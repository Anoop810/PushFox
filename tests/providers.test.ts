import { describe, expect, it } from "vitest";
import type {
  ChatRequest,
  ChatResponse,
  LLMProvider,
} from "../src/providers/types.js";
import {
  AnthropicProvider,
  createProvider,
  isDailyQuotaExhausted,
  isRetryableGeminiError,
  normalizeThoughtSignature,
  resolveGeminiApiKey,
  resolveOpenRouterApiKey,
  toGeminiRequestParts,
  toOpenRouterMessages,
} from "../src/providers/index.js";

class MockProvider implements LLMProvider {
  readonly name = "mock";
  public calls = 0;
  constructor(private readonly responses: ChatResponse[]) {}
  async chat(_request: ChatRequest): Promise<ChatResponse> {
    const response = this.responses[this.calls] ?? {
      content: null,
      toolCalls: [],
      finishReason: "stop",
    };
    this.calls += 1;
    return response;
  }
}

describe("provider abstraction", () => {
  it("createProvider returns gemini implementation when key present", () => {
    const prev = process.env.GEMINI_API_KEY;
    process.env.GEMINI_API_KEY = "test-gemini-key";
    try {
      const provider = createProvider("gemini");
      expect(provider.name).toBe("gemini");
    } finally {
      if (prev === undefined) delete process.env.GEMINI_API_KEY;
      else process.env.GEMINI_API_KEY = prev;
    }
  });

  it("createProvider returns openrouter implementation when key present", () => {
    const prev = process.env.OPENROUTER_API_KEY;
    process.env.OPENROUTER_API_KEY = "test-openrouter-key";
    try {
      const provider = createProvider("openrouter");
      expect(provider.name).toBe("openrouter");
    } finally {
      if (prev === undefined) delete process.env.OPENROUTER_API_KEY;
      else process.env.OPENROUTER_API_KEY = prev;
    }
  });

  it("rejects openai as unsupported", () => {
    expect(() => createProvider("openai")).toThrow(/openrouter/i);
  });

  it("createProvider stubs unimplemented providers without changing agent engine", async () => {
    const anthropic = createProvider("anthropic");
    expect(anthropic.name).toBe("anthropic");
    await expect(
      anthropic.chat({ model: "x", messages: [] }),
    ).rejects.toThrow(/not implemented/i);
    await expect(
      new AnthropicProvider().chat({ model: "x", messages: [] }),
    ).rejects.toThrow(/not implemented/i);
  });

  it("resolveGeminiApiKey prefers explicit key", () => {
    expect(resolveGeminiApiKey(" gemini-explicit ")).toBe("gemini-explicit");
  });

  it("resolveOpenRouterApiKey prefers explicit key and strips newlines", () => {
    expect(resolveOpenRouterApiKey(" or-explicit ")).toBe("or-explicit");
    expect(resolveOpenRouterApiKey("sk-or-test\r\n")).toBe("sk-or-test");
  });

  it("maps tool turns into OpenAI-compatible OpenRouter messages", () => {
    const messages = toOpenRouterMessages([
      { role: "system", content: "You are a reviewer." },
      { role: "user", content: "Review this PR." },
      {
        role: "assistant",
        content: null,
        toolCalls: [
          {
            id: "call_1",
            name: "read_file",
            arguments: JSON.stringify({ path: "src/a.ts" }),
          },
        ],
      },
      {
        role: "tool",
        toolCallId: "call_1",
        name: "read_file",
        content: "file contents",
      },
    ]);

    expect(messages[0]).toEqual({
      role: "system",
      content: "You are a reviewer.",
    });
    expect(messages[1]).toEqual({
      role: "user",
      content: "Review this PR.",
    });
    expect(messages[2]).toMatchObject({
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: "call_1",
          type: "function",
          function: {
            name: "read_file",
            arguments: JSON.stringify({ path: "src/a.ts" }),
          },
        },
      ],
    });
    expect(messages[3]).toMatchObject({
      role: "tool",
      tool_call_id: "call_1",
      name: "read_file",
      content: "file contents",
    });
  });

  it("strips newlines from Gemini API keys", () => {
    expect(resolveGeminiApiKey("AIzaSyTest\r\n")).toBe("AIzaSyTest");
    expect(resolveGeminiApiKey("AIza\nSyTest")).toBe("AIzaSyTest");
  });

  it("maps tool turns into Gemini function responses", () => {
    const { systemInstruction, contents } = toGeminiRequestParts([
      { role: "system", content: "You are a reviewer." },
      { role: "user", content: "Review this PR." },
      {
        role: "assistant",
        content: null,
        toolCalls: [
          {
            id: "call_1",
            name: "read_file",
            arguments: JSON.stringify({ path: "src/a.ts" }),
            thoughtSignature: "sig-abc",
          },
        ],
      },
      {
        role: "tool",
        toolCallId: "call_1",
        name: "read_file",
        content: "file contents",
      },
    ]);

    expect(systemInstruction).toContain("reviewer");
    expect(contents[0]?.role).toBe("user");
    expect(contents[1]?.role).toBe("model");
    expect(contents[1]?.parts?.[0]).toMatchObject({
      functionCall: { name: "read_file", id: "call_1" },
      thoughtSignature: "sig-abc",
    });
    expect(contents[2]?.role).toBe("user");
    expect(contents[2]?.parts?.[0]).toMatchObject({
      functionResponse: {
        name: "read_file",
        id: "call_1",
        response: { output: "file contents" },
      },
    });
  });

  it("echoes raw model parts verbatim for Gemini 3 thought signatures", () => {
    const rawParts = [
      {
        functionCall: {
          id: "call_1",
          name: "get_diff",
          args: {},
        },
        thoughtSignature: "raw-sig-xyz",
      },
    ];

    const { contents } = toGeminiRequestParts([
      { role: "user", content: "Review" },
      {
        role: "assistant",
        content: null,
        toolCalls: [
          {
            id: "call_1",
            name: "get_diff",
            arguments: "{}",
            // Intentionally different — raw parts must win.
            thoughtSignature: "should-not-be-used",
          },
        ],
        rawModelParts: rawParts,
      },
      {
        role: "tool",
        toolCallId: "call_1",
        name: "get_diff",
        content: "diff text",
      },
    ]);

    expect(contents[1]?.parts).toEqual(rawParts);
  });

  it("injects skip thought signature when reconstructing without one", () => {
    const { contents } = toGeminiRequestParts([
      { role: "user", content: "Review" },
      {
        role: "assistant",
        content: null,
        toolCalls: [
          {
            id: "call_1",
            name: "get_diff",
            arguments: "{}",
          },
        ],
      },
    ]);

    expect(contents[1]?.parts?.[0]).toMatchObject({
      functionCall: { name: "get_diff" },
      thoughtSignature: "skip_thought_signature_validator",
    });
  });

  it("normalizes thought signatures from bytes", () => {
    expect(normalizeThoughtSignature(Uint8Array.from([1, 2, 3]))).toBe(
      Buffer.from([1, 2, 3]).toString("base64"),
    );
    expect(normalizeThoughtSignature("abc")).toBe("abc");
    expect(normalizeThoughtSignature(undefined)).toBeUndefined();
  });

  it("detects retryable Gemini capacity errors", () => {
    expect(
      isRetryableGeminiError(
        new Error(
          '{"error":{"code":503,"message":"This model is currently experiencing high demand.","status":"UNAVAILABLE"}}',
        ),
      ),
    ).toBe(true);
    expect(
      isRetryableGeminiError(
        Object.assign(new Error("high demand"), { status: 503 }),
      ),
    ).toBe(true);
    expect(isRetryableGeminiError(new Error("INVALID_ARGUMENT"))).toBe(false);
  });

  it("does not retry daily free-tier quota exhaustion", () => {
    const daily = new Error(
      '{"error":{"code":429,"message":"Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests","status":"RESOURCE_EXHAUSTED","details":[{"@type":"type.googleapis.com/google.rpc.QuotaFailure","violations":[{"quotaId":"GenerateRequestsPerDayPerProjectPerModel-FreeTier"}]}]}}',
    );
    expect(isDailyQuotaExhausted(daily)).toBe(true);
    expect(isRetryableGeminiError(daily)).toBe(false);
  });

  it("mock provider is usable as LLMProvider", async () => {
    const mock = new MockProvider([
      { content: "hi", toolCalls: [], finishReason: "stop" },
    ]);
    const res = await mock.chat({ model: "m", messages: [] });
    expect(res.content).toBe("hi");
    expect(mock.calls).toBe(1);
  });
});

export { MockProvider };
