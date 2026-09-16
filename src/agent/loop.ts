import {
  ReviewResultSchema,
  meetsSeverityThreshold,
  type ReviewResult,
  type Severity,
} from "../review/findings.js";
import type {
  ChatRequest,
  LLMProvider,
  LLMMessage,
  ToolDefinition,
} from "../providers/types.js";
import type { StaticPack } from "../static-pack/schema.js";
import {
  createToolRegistry,
  getToolDefinitions,
} from "../tools/index.js";
import type { ToolContext } from "../tools/types.js";
import {
  SYSTEM_REVIEWER_INSTRUCTIONS,
  buildUserKickoffMessage,
  buildSubmitNudgeMessage,
  wrapToolOutput,
} from "./prompts.js";

export type AgentLoopOptions = {
  provider: LLMProvider;
  model: string;
  pack: StaticPack;
  toolContext: ToolContext;
  maxIterations: number;
  severityThreshold: Severity;
  onEvent?: (event: AgentEvent) => void;
};

export type AgentEvent =
  | { type: "iteration"; iteration: number }
  | { type: "tool_call"; name: string; arguments: string }
  | { type: "tool_result"; name: string; ok: boolean; truncated: boolean }
  | { type: "message"; content: string }
  | { type: "completed"; result: ReviewResult }
  | { type: "forced_stop"; reason: string };

const EMPTY_SAFE_RESULT = (reason: string): ReviewResult => ({
  summary: `Review completed without structured findings (${reason}).`,
  findings: [],
  confidence: "low",
  investigatedFiles: [],
});

const SUBMIT_TOOL_NAME = "submit_review";

const submitOnlyTools = (tools: ToolDefinition[]): ToolDefinition[] =>
  tools.filter((tool) => tool.name === SUBMIT_TOOL_NAME);

export const parseSubmitReviewArgs = (
  rawArgs: string,
  severityThreshold: Severity,
): ReviewResult => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawArgs);
  } catch {
    // Try to extract JSON object from surrounding text
    const start = rawArgs.indexOf("{");
    const end = rawArgs.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        parsed = JSON.parse(rawArgs.slice(start, end + 1));
      } catch {
        return EMPTY_SAFE_RESULT("malformed submit_review JSON");
      }
    } else {
      return EMPTY_SAFE_RESULT("malformed submit_review JSON");
    }
  }

  const result = ReviewResultSchema.safeParse(parsed);
  if (!result.success) {
    return EMPTY_SAFE_RESULT(
      `invalid submit_review payload: ${result.error.issues
        .slice(0, 3)
        .map((i) => i.message)
        .join("; ")}`,
    );
  }

  const filtered = {
    ...result.data,
    findings: result.data.findings.filter((f) =>
      meetsSeverityThreshold(f.severity, severityThreshold),
    ),
  };
  return filtered;
};

export const parseReviewFromContent = (
  content: string,
  severityThreshold: Severity,
): ReviewResult | null => {
  const fence = content.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fence?.[1]?.trim() ?? content.trim();
  if (!candidate.includes("{")) return null;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(candidate.slice(start, end + 1));
    const result = ReviewResultSchema.safeParse(parsed);
    if (!result.success) return null;
    return {
      ...result.data,
      findings: result.data.findings.filter((f) =>
        meetsSeverityThreshold(f.severity, severityThreshold),
      ),
    };
  } catch {
    return null;
  }
};

export class AgentLoop {
  async run(options: AgentLoopOptions): Promise<ReviewResult> {
    const {
      provider,
      model,
      pack,
      toolContext,
      maxIterations,
      severityThreshold,
      onEvent,
    } = options;

    const registry = createToolRegistry();
    const tools = getToolDefinitions();
    const submitTools = submitOnlyTools(tools);

    // Bound the pack sent to the model — keep structure but trim huge surrounding code
    const packForModel = {
      ...pack,
      surroundingCode: pack.surroundingCode.map((f) => ({
        ...f,
        content:
          f.content.length > 20_000
            ? `${f.content.slice(0, 20_000)}\n… [truncated for model input]`
            : f.content,
      })),
      diff: {
        ...pack.diff,
        text:
          pack.diff.text.length > 100_000
            ? `${pack.diff.text.slice(0, 100_000)}\n… [truncated for model input]`
            : pack.diff.text,
      },
    };

    const messages: LLMMessage[] = [
      { role: "system", content: SYSTEM_REVIEWER_INSTRUCTIONS },
      {
        role: "user",
        content: buildUserKickoffMessage(
          JSON.stringify(packForModel, null, 2),
          maxIterations,
        ),
      },
    ];

    let iterations = 0;
    while (iterations < maxIterations) {
      iterations += 1;
      onEvent?.({ type: "iteration", iteration: iterations });

      const remainingIncludingThis = maxIterations - iterations + 1;
      const forceSubmit = remainingIncludingThis <= 1;
      if (remainingIncludingThis <= 2) {
        messages.push({
          role: "user",
          content: buildSubmitNudgeMessage(remainingIncludingThis),
        });
      }

      const response = await provider.chat({
        model,
        messages,
        tools: forceSubmit ? submitTools : tools,
        toolChoice: forceSubmit
          ? { type: "function", name: SUBMIT_TOOL_NAME }
          : "auto",
        temperature: 0.1,
      });

      if (response.content) {
        onEvent?.({ type: "message", content: response.content });
      }

      if (!response.toolCalls.length) {
        // Model returned prose only — try to parse review JSON, else stop safely
        if (response.content) {
          const parsed = parseReviewFromContent(
            response.content,
            severityThreshold,
          );
          if (parsed) {
            onEvent?.({ type: "completed", result: parsed });
            return parsed;
          }
        }
        if (forceSubmit) {
          break;
        }
        onEvent?.({
          type: "forced_stop",
          reason: "model returned no tool calls",
        });
        return EMPTY_SAFE_RESULT("model ended without submit_review");
      }

      messages.push({
        role: "assistant",
        content: response.content,
        toolCalls: response.toolCalls,
        ...(response.rawModelParts?.length
          ? { rawModelParts: response.rawModelParts }
          : {}),
      });

      for (const call of response.toolCalls) {
        onEvent?.({
          type: "tool_call",
          name: call.name,
          arguments: call.arguments,
        });

        if (call.name === SUBMIT_TOOL_NAME) {
          const result = parseSubmitReviewArgs(
            call.arguments,
            severityThreshold,
          );
          onEvent?.({ type: "completed", result });
          return result;
        }

        if (forceSubmit) {
          // Last turn should only submit; treat other tools as a soft miss.
          messages.push({
            role: "tool",
            toolCallId: call.id,
            name: call.name,
            content: wrapToolOutput(
              call.name,
              "Investigation tools are disabled on the final turn. Call submit_review.",
            ),
          });
          onEvent?.({
            type: "tool_result",
            name: call.name,
            ok: false,
            truncated: false,
          });
          continue;
        }

        const tool = registry.get(call.name);
        if (!tool) {
          const output = wrapToolOutput(
            call.name,
            `Unknown tool: ${call.name}`,
          );
          messages.push({
            role: "tool",
            toolCallId: call.id,
            name: call.name,
            content: output,
          });
          onEvent?.({
            type: "tool_result",
            name: call.name,
            ok: false,
            truncated: false,
          });
          continue;
        }

        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(call.arguments || "{}") as Record<string, unknown>;
        } catch {
          args = {};
        }

        const result = await tool.execute(args, toolContext);
        onEvent?.({
          type: "tool_result",
          name: call.name,
          ok: result.ok,
          truncated: result.truncated,
        });

        messages.push({
          role: "tool",
          toolCallId: call.id,
          name: call.name,
          content: wrapToolOutput(call.name, result.output),
        });
      }
    }

    onEvent?.({
      type: "forced_stop",
      reason: `reached max iterations (${maxIterations})`,
    });

    return this.forceFinalSubmit({
      provider,
      model,
      messages,
      tools: submitTools,
      severityThreshold,
      onEvent,
    });
  }

  private async forceFinalSubmit(input: {
    provider: LLMProvider;
    model: string;
    messages: LLMMessage[];
    tools: ToolDefinition[];
    severityThreshold: Severity;
    onEvent?: (event: AgentEvent) => void;
  }): Promise<ReviewResult> {
    const { provider, model, messages, tools, severityThreshold, onEvent } =
      input;

    messages.push({
      role: "user",
      content: [
        "=== SYSTEM ===",
        "Investigation limit reached. Call submit_review exactly once now.",
        "Provide summary, confidence, investigatedFiles, and findings (may be []).",
      ].join("\n"),
    });

    const forcedRequest: ChatRequest = {
      model,
      messages,
      tools,
      toolChoice: { type: "function", name: SUBMIT_TOOL_NAME },
      temperature: 0,
    };

    try {
      const forced = await provider.chat(forcedRequest);
      const submitCall = forced.toolCalls.find(
        (call) => call.name === SUBMIT_TOOL_NAME,
      );
      if (submitCall) {
        const result = parseSubmitReviewArgs(
          submitCall.arguments,
          severityThreshold,
        );
        onEvent?.({ type: "completed", result });
        return result;
      }
      if (forced.content) {
        const parsed = parseReviewFromContent(
          forced.content,
          severityThreshold,
        );
        if (parsed) {
          onEvent?.({ type: "completed", result: parsed });
          return parsed;
        }
      }
    } catch {
      // fall through to prose-only attempt
    }

    // Last resort: ask for raw JSON with tools disabled.
    messages.push({
      role: "user",
      content:
        "=== SYSTEM ===\nRespond with ONLY a JSON object matching the submit_review schema (summary, confidence, investigatedFiles, findings). No tools.",
    });

    try {
      const finalResponse = await provider.chat({
        model,
        messages,
        temperature: 0,
      });
      if (finalResponse.content) {
        const parsed = parseReviewFromContent(
          finalResponse.content,
          severityThreshold,
        );
        if (parsed) {
          onEvent?.({ type: "completed", result: parsed });
          return parsed;
        }
      }
    } catch {
      // fall through to empty safe result
    }

    return EMPTY_SAFE_RESULT(
      `max iterations exceeded without submit_review`,
    );
  }
}
