import type {
  ChatRequest,
  ChatResponse,
  LLMMessage,
  LLMProvider,
  ToolDefinition,
} from "./types.js";

const ENV_KEYS = [
  "OPENROUTER_API_KEY",
  "PUSHFOX_OPENROUTER_API_KEY",
] as const;

const DEFAULT_BASE_URL = "https://openrouter.ai/api/v1";
const DEFAULT_MAX_RETRIES = 8;
const DEFAULT_RETRY_BASE_MS = 4000;
const DEFAULT_RETRY_MAX_MS = 60_000;

const sanitizeApiKey = (value: string | undefined): string | undefined => {
  if (!value) return undefined;
  const cleaned = value.replace(/[\r\n]/g, "").split("\0").join("").trim();
  return cleaned.length > 0 ? cleaned : undefined;
};

export const resolveOpenRouterApiKey = (
  explicit?: string,
): string | undefined => {
  const fromExplicit = sanitizeApiKey(explicit);
  if (fromExplicit) return fromExplicit;
  for (const key of ENV_KEYS) {
    const cleaned = sanitizeApiKey(process.env[key]);
    if (cleaned) return cleaned;
  }
  return undefined;
};

export type OpenRouterProviderOptions = {
  apiKey?: string;
  baseUrl?: string;
  siteUrl?: string;
  appName?: string;
  maxRetries?: number;
  retryBaseMs?: number;
  retryMaxMs?: number;
  fallbackModels?: string[];
};

type OpenAIToolCall = {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
};

type OpenAIMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: OpenAIToolCall[];
  tool_call_id?: string;
  name?: string;
};

type OpenAIChatCompletion = {
  choices?: Array<{
    message?: {
      content?: string | null;
      tool_calls?: OpenAIToolCall[];
    };
    finish_reason?: string | null;
  }>;
  error?: {
    message?: string;
    code?: string | number;
  };
};

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const retryDelayMs = (
  attempt: number,
  baseMs: number,
  maxMs: number,
): number => {
  const expo = baseMs * 2 ** attempt;
  const jitter = Math.floor(Math.random() * baseMs);
  return Math.min(maxMs, expo + jitter);
};

const errorText = (error: unknown): string => {
  if (error instanceof Error) return error.message;
  return String(error);
};

export const isRetryableOpenRouterError = (error: unknown): boolean => {
  const text = errorText(error);
  if (/\b(408|429|500|502|503|504)\b/.test(text)) return true;
  return (
    /rate limit/i.test(text) ||
    /temporarily/i.test(text) ||
    /try again later/i.test(text) ||
    /ECONNRESET/i.test(text) ||
    /ETIMEDOUT/i.test(text) ||
    /socket hang up/i.test(text) ||
    /fetch failed/i.test(text)
  );
};

const toOpenAITools = (
  tools: ToolDefinition[],
): Array<{
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}> =>
  tools.map((tool) => ({
    type: "function" as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }));

/**
 * Convert provider-agnostic messages into OpenAI-compatible chat messages.
 * Exported for unit tests.
 */
export const toOpenRouterMessages = (
  messages: LLMMessage[],
): OpenAIMessage[] => {
  const out: OpenAIMessage[] = [];

  for (const message of messages) {
    if (message.role === "system") {
      if (message.content?.trim()) {
        out.push({ role: "system", content: message.content });
      }
      continue;
    }

    if (message.role === "user") {
      out.push({ role: "user", content: message.content ?? "" });
      continue;
    }

    if (message.role === "tool") {
      out.push({
        role: "tool",
        tool_call_id: message.toolCallId ?? "tool_call",
        content: message.content ?? "",
        ...(message.name ? { name: message.name } : {}),
      });
      continue;
    }

    // assistant
    const toolCalls = message.toolCalls?.map((call) => ({
      id: call.id,
      type: "function" as const,
      function: {
        name: call.name,
        arguments: call.arguments || "{}",
      },
    }));

    out.push({
      role: "assistant",
      content: message.content,
      ...(toolCalls?.length ? { tool_calls: toolCalls } : {}),
    });
  }

  return out;
};

export class OpenRouterProvider implements LLMProvider {
  readonly name = "openrouter";
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly siteUrl?: string;
  private readonly appName: string;
  private readonly maxRetries: number;
  private readonly retryBaseMs: number;
  private readonly retryMaxMs: number;
  private readonly fallbackModels: string[];
  private activeModelOverride?: string;

  constructor(options: OpenRouterProviderOptions = {}) {
    const apiKey = resolveOpenRouterApiKey(options.apiKey);
    if (!apiKey) {
      throw new Error(
        "OpenRouter API key not found. Set OPENROUTER_API_KEY (BYOK) or pass apiKey.",
      );
    }
    for (const key of ENV_KEYS) {
      if (process.env[key]) {
        process.env[key] = sanitizeApiKey(process.env[key]) ?? apiKey;
      }
    }
    this.apiKey = apiKey;
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.siteUrl = options.siteUrl ?? process.env.OPENROUTER_SITE_URL;
    this.appName =
      options.appName ?? process.env.OPENROUTER_APP_NAME ?? "PushFox";
    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.retryBaseMs = options.retryBaseMs ?? DEFAULT_RETRY_BASE_MS;
    this.retryMaxMs = options.retryMaxMs ?? DEFAULT_RETRY_MAX_MS;
    this.fallbackModels = (options.fallbackModels ?? []).filter(
      (model) => typeof model === "string" && model.trim().length > 0,
    );
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const models = this.resolveModelCandidates(request.model);
    let lastError: unknown;

    for (let index = 0; index < models.length; index += 1) {
      const model = models[index]!;
      try {
        const response = await this.chatWithModel(request, model);
        if (model !== request.model || this.activeModelOverride) {
          this.activeModelOverride = model;
        }
        return response;
      } catch (error) {
        lastError = error;
        const hasFallback = index < models.length - 1;
        const text = errorText(error);
        const isModelUnavailable =
          /\b404\b/.test(text) ||
          /model .* not found/i.test(text) ||
          /no endpoints/i.test(text);

        if (hasFallback && (isModelUnavailable || isRetryableOpenRouterError(error))) {
          const next = models[index + 1]!;
          console.error(
            `[pushfox] OpenRouter error for model "${model}". Falling back to "${next}".`,
          );
          this.activeModelOverride = next;
          continue;
        }
        throw error;
      }
    }

    throw lastError instanceof Error
      ? lastError
      : new Error(String(lastError));
  }

  private resolveModelCandidates(requestedModel: string): string[] {
    const ordered = [
      this.activeModelOverride,
      requestedModel,
      ...this.fallbackModels,
    ].filter((model): model is string => Boolean(model?.trim()));

    return [...new Set(ordered)];
  }

  private async chatWithModel(
    request: ChatRequest,
    model: string,
  ): Promise<ChatResponse> {
    let messages = toOpenRouterMessages(request.messages);
    if (messages.length === 0) {
      messages = [{ role: "user", content: "Begin the review." }];
    }

    const body: Record<string, unknown> = {
      model,
      messages,
      temperature: request.temperature ?? 0.1,
    };
    if (request.maxTokens !== undefined) {
      body.max_tokens = request.maxTokens;
    }
    if (request.tools?.length) {
      body.tools = toOpenAITools(request.tools);
      body.tool_choice = "auto";
    }

    const data = await this.postChatCompletion(body);
    const choice = data.choices?.[0];
    const message = choice?.message;
    const toolCalls =
      message?.tool_calls?.map((call) => ({
        id: call.id,
        name: call.function.name,
        arguments: call.function.arguments || "{}",
      })) ?? [];

    return {
      content: message?.content ?? null,
      toolCalls,
      finishReason: choice?.finish_reason ?? null,
      raw: data,
    };
  }

  private async postChatCompletion(
    body: Record<string, unknown>,
  ): Promise<OpenAIChatCompletion> {
    let lastError: unknown;

    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      try {
        const headers: Record<string, string> = {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
          "X-Title": this.appName,
        };
        if (this.siteUrl) {
          headers["HTTP-Referer"] = this.siteUrl;
        }

        const response = await fetch(`${this.baseUrl}/chat/completions`, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
        });

        const text = await response.text();
        let data: OpenAIChatCompletion = {};
        if (text.trim()) {
          try {
            data = JSON.parse(text) as OpenAIChatCompletion;
          } catch {
            throw new Error(
              `OpenRouter returned non-JSON (status ${response.status}): ${text.slice(0, 400)}`,
            );
          }
        }

        if (!response.ok) {
          const detail =
            data.error?.message ??
            (text.slice(0, 400) || response.statusText);
          throw new Error(
            `OpenRouter request failed (${response.status}): ${detail}`,
          );
        }

        if (data.error?.message) {
          throw new Error(`OpenRouter error: ${data.error.message}`);
        }

        return data;
      } catch (error) {
        lastError = error;
        const canRetry =
          attempt < this.maxRetries && isRetryableOpenRouterError(error);
        if (!canRetry) throw error;

        const delay = retryDelayMs(
          attempt,
          this.retryBaseMs,
          this.retryMaxMs,
        );
        console.error(
          `[pushfox] OpenRouter transient error (attempt ${attempt + 1}/${this.maxRetries + 1}); retrying in ${delay}ms`,
        );
        console.error(
          `[pushfox] ${error instanceof Error ? error.message : String(error)}`,
        );
        await sleep(delay);
      }
    }

    throw lastError instanceof Error
      ? lastError
      : new Error(String(lastError));
  }
}
