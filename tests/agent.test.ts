import { describe, expect, it } from "vitest";
import { AgentLoop } from "../src/agent/loop.js";
import type { ChatRequest, ChatResponse, LLMProvider } from "../src/providers/types.js";
import type { StaticPack } from "../src/static-pack/schema.js";
import { DEFAULT_CONFIG } from "../src/config/schema.js";

const minimalPack = (): StaticPack => ({
  version: "1",
  generatedAt: new Date().toISOString(),
  repository: { root: "/tmp/repo", name: "repo" },
  comparison: {
    base: "main",
    head: "HEAD",
    baseSha: "aaa",
    headSha: "bbb",
  },
  git: { commits: [] },
  changedFiles: [
    {
      path: "src/a.ts",
      status: "modified",
      additions: 1,
      deletions: 0,
    },
  ],
  diff: { text: "diff --git a/src/a.ts b/src/a.ts\n", truncated: false, totalBytes: 10 },
  surroundingCode: [],
  imports: [],
  relatedTests: [],
  repositoryInstructions: null,
  fileStructure: { text: ".", truncated: false },
  bounds: {
    maxDiffBytes: 1000,
    maxFileBytes: 1000,
    maxStructureEntries: 10,
  },
});

class ScriptedProvider implements LLMProvider {
  readonly name = "scripted";
  public calls = 0;
  constructor(private readonly script: Array<(req: ChatRequest) => ChatResponse>) {}
  async chat(request: ChatRequest): Promise<ChatResponse> {
    const fn = this.script[this.calls];
    this.calls += 1;
    if (!fn) {
      return { content: null, toolCalls: [], finishReason: "stop" };
    }
    return fn(request);
  }
}

describe("agent iteration limits", () => {
  it("stops at maxIterations and fails safe", async () => {
    const provider = new ScriptedProvider(
      Array.from({ length: 20 }, () => () => ({
        content: null,
        toolCalls: [
          {
            id: "1",
            name: "list_files",
            arguments: JSON.stringify({ path: "." }),
          },
        ],
        finishReason: "tool_calls",
      })),
    );

    const loop = new AgentLoop();
    const result = await loop.run({
      provider,
      model: "mock",
      pack: minimalPack(),
      maxIterations: 3,
      severityThreshold: "medium",
      toolContext: {
        repoRoot: process.cwd(),
        baseRef: "HEAD",
        headRef: "HEAD",
        ignorePaths: DEFAULT_CONFIG.paths.ignore,
        maxOutputChars: 2000,
      },
    });

    // investigation turns + forced submit_review attempt + optional prose JSON attempt
    expect(provider.calls).toBeGreaterThanOrEqual(3);
    expect(provider.calls).toBeLessThanOrEqual(5);
    expect(result.findings).toEqual([]);
    expect(result.confidence).toBe("low");
  });

  it("forces submit_review tool choice on the final investigation turn", async () => {
    const requests: ChatRequest[] = [];
    const provider = new ScriptedProvider([
      (req) => {
        requests.push(req);
        return {
          content: null,
          toolCalls: [
            {
              id: "1",
              name: "list_files",
              arguments: JSON.stringify({ path: "." }),
            },
          ],
          finishReason: "tool_calls",
        };
      },
      (req) => {
        requests.push(req);
        return {
          content: null,
          toolCalls: [
            {
              id: "2",
              name: "submit_review",
              arguments: JSON.stringify({
                summary: "Forced finish",
                confidence: "medium",
                investigatedFiles: ["src/a.ts"],
                findings: [],
              }),
            },
          ],
          finishReason: "tool_calls",
        };
      },
    ]);

    const loop = new AgentLoop();
    const result = await loop.run({
      provider,
      model: "mock",
      pack: minimalPack(),
      maxIterations: 2,
      severityThreshold: "medium",
      toolContext: {
        repoRoot: process.cwd(),
        baseRef: "HEAD",
        headRef: "HEAD",
        ignorePaths: DEFAULT_CONFIG.paths.ignore,
        maxOutputChars: 2000,
      },
    });

    expect(result.summary).toBe("Forced finish");
    expect(requests[1]?.toolChoice).toEqual({
      type: "function",
      name: "submit_review",
    });
    expect(requests[1]?.tools?.every((t) => t.name === "submit_review")).toBe(
      true,
    );
  });

  it("completes when submit_review is called", async () => {
    const provider = new ScriptedProvider([
      () => ({
        content: null,
        toolCalls: [
          {
            id: "call_1",
            name: "submit_review",
            arguments: JSON.stringify({
              summary: "No meaningful issues",
              confidence: "high",
              investigatedFiles: ["src/a.ts"],
              findings: [],
            }),
          },
        ],
        finishReason: "tool_calls",
      }),
    ]);

    const loop = new AgentLoop();
    const result = await loop.run({
      provider,
      model: "mock",
      pack: minimalPack(),
      maxIterations: 8,
      severityThreshold: "medium",
      toolContext: {
        repoRoot: process.cwd(),
        baseRef: "HEAD",
        headRef: "HEAD",
        ignorePaths: DEFAULT_CONFIG.paths.ignore,
        maxOutputChars: 2000,
      },
    });

    expect(result.summary).toBe("No meaningful issues");
    expect(result.findings).toEqual([]);
    expect(provider.calls).toBe(1);
  });

  it("fails safe on malformed submit_review", async () => {
    const provider = new ScriptedProvider([
      () => ({
        content: null,
        toolCalls: [
          {
            id: "call_1",
            name: "submit_review",
            arguments: "{bad",
          },
        ],
        finishReason: "tool_calls",
      }),
    ]);

    const loop = new AgentLoop();
    const result = await loop.run({
      provider,
      model: "mock",
      pack: minimalPack(),
      maxIterations: 5,
      severityThreshold: "medium",
      toolContext: {
        repoRoot: process.cwd(),
        baseRef: "HEAD",
        headRef: "HEAD",
        ignorePaths: DEFAULT_CONFIG.paths.ignore,
        maxOutputChars: 2000,
      },
    });

    expect(result.findings).toEqual([]);
    expect(result.summary.toLowerCase()).toContain("malformed");
  });
});
