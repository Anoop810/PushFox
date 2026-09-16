export type LLMRole = "system" | "user" | "assistant" | "tool";

export type ToolCallRequest = {
  id: string;
  name: string;
  arguments: string;
  /** Gemini 3+ opaque signature required when echoing functionCall parts. */
  thoughtSignature?: string;
};

export type LLMMessage = {
  role: LLMRole;
  content: string | null;
  toolCallId?: string;
  name?: string;
  toolCalls?: ToolCallRequest[];
  /**
   * Exact model content parts from the prior provider response.
   * Gemini 3 requires these (incl. thought signatures) to be echoed verbatim.
   */
  rawModelParts?: unknown[];
};

export type ToolDefinition = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
};

export type ToolChoice =
  | "auto"
  | "required"
  | { type: "function"; name: string };

export type ChatRequest = {
  model: string;
  messages: LLMMessage[];
  tools?: ToolDefinition[];
  toolChoice?: ToolChoice;
  temperature?: number;
  maxTokens?: number;
};

export type ChatResponse = {
  content: string | null;
  toolCalls: ToolCallRequest[];
  finishReason: string | null;
  /** Provider-native model parts to echo on the next turn (Gemini thought signatures). */
  rawModelParts?: unknown[];
  raw?: unknown;
};

/**
 * Provider-agnostic LLM interface.
 * Implementations must never log or persist API keys.
 */
export interface LLMProvider {
  readonly name: string;
  chat(request: ChatRequest): Promise<ChatResponse>;
}
