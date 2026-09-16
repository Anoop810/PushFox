import type {
  ChatRequest,
  ChatResponse,
  LLMProvider,
} from "./types.js";
import {
  GeminiProvider,
  type GeminiProviderOptions,
} from "./gemini.js";
import {
  OpenRouterProvider,
  type OpenRouterProviderOptions,
} from "./openrouter.js";

export type { LLMProvider, ChatRequest, ChatResponse, LLMMessage } from "./types.js";
export {
  GeminiProvider,
  isDailyQuotaExhausted,
  isRetryableGeminiError,
  normalizeThoughtSignature,
  resolveGeminiApiKey,
  toGeminiRequestParts,
} from "./gemini.js";
export {
  OpenRouterProvider,
  isRetryableOpenRouterError,
  resolveOpenRouterApiKey,
  toOpenRouterMessages,
} from "./openrouter.js";

export type ProviderOptions = {
  apiKey?: string;
  baseUrl?: string;
  siteUrl?: string;
  appName?: string;
  maxRetries?: number;
  retryBaseMs?: number;
  retryMaxMs?: number;
  fallbackModels?: string[];
};

/**
 * Stubs for future providers — keep the abstraction stable.
 */
export class AnthropicProvider implements LLMProvider {
  readonly name = "anthropic";
  async chat(_request: ChatRequest): Promise<ChatResponse> {
    throw new Error(
      "AnthropicProvider is not implemented. Use provider: gemini or openrouter.",
    );
  }
}

export class XAIProvider implements LLMProvider {
  readonly name = "xai";
  async chat(_request: ChatRequest): Promise<ChatResponse> {
    throw new Error(
      "XAIProvider is not implemented. Use provider: gemini or openrouter.",
    );
  }
}

export const byokHintForProvider = (name: string): string => {
  switch (name) {
    case "gemini":
      return "BYOK: set GEMINI_API_KEY in your environment (never commit keys).";
    case "openrouter":
      return "BYOK: set OPENROUTER_API_KEY in your environment (never commit keys).";
    default:
      return `BYOK: provider "${name}" is not available. Use gemini (GEMINI_API_KEY) or openrouter (OPENROUTER_API_KEY).`;
  }
};

export const createProvider = (
  name: string,
  options: ProviderOptions = {},
): LLMProvider => {
  switch (name) {
    case "gemini":
      return new GeminiProvider(options as GeminiProviderOptions);
    case "openrouter":
      return new OpenRouterProvider(options as OpenRouterProviderOptions);
    case "anthropic":
      return new AnthropicProvider();
    case "xai":
      return new XAIProvider();
    case "openai":
      throw new Error(
        "OpenAI is not supported directly. Use provider: openrouter with an OpenAI model id (e.g. openai/gpt-4o-mini).",
      );
    default:
      throw new Error(
        `Unknown LLM provider: ${name}. Supported: gemini, openrouter.`,
      );
  }
};
