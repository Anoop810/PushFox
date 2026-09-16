import { GoogleGenAI } from "@google/genai";
import type { Content, FunctionDeclaration, Part } from "@google/genai";
import type {
  ChatRequest,
  ChatResponse,
  LLMMessage,
  LLMProvider,
  ToolDefinition,
} from "./types.js";

const ENV_KEYS = [
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "GOOGLE_GENERATIVE_AI_API_KEY",
  "PUSHFOX_GEMINI_API_KEY",
] as const;

/** Last-resort token when a signature was lost; Gemini documents this escape hatch. */
const SKIP_THOUGHT_SIGNATURE = "skip_thought_signature_validator";

const DEFAULT_MAX_RETRIES = 8;
const DEFAULT_RETRY_BASE_MS = 4000;
const DEFAULT_RETRY_MAX_MS = 60_000;

const sanitizeApiKey = (value: string | undefined): string | undefined => {
  if (!value) return undefined;
  // Secrets pasted into GitHub often include trailing/CRLF newlines, which break HTTP headers.
  const cleaned = value.replace(/[\r\n]/g, "").split("\0").join("").trim();
  return cleaned.length > 0 ? cleaned : undefined;
};

export const resolveGeminiApiKey = (
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

export type GeminiProviderOptions = {
  apiKey?: string;
  maxRetries?: number;
  retryBaseMs?: number;
  retryMaxMs?: number;
  fallbackModels?: string[];
};

const readErrorStatus = (error: unknown): number | undefined => {
  if (!error || typeof error !== "object") return undefined;
  const record = error as Record<string, unknown>;
  for (const key of ["status", "statusCode", "code"] as const) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
  }
  return undefined;
};

const errorText = (error: unknown): string => {
  const chunks: string[] = [];
  if (error instanceof Error) {
    chunks.push(error.message);
    if (error.stack) chunks.push(error.stack);
    const cause = (error as Error & { cause?: unknown }).cause;
    if (cause) chunks.push(errorText(cause));
  } else {
    chunks.push(String(error));
  }
  try {
    chunks.push(JSON.stringify(error));
  } catch {
    // ignore circulars
  }
  return chunks.join("\n");
};

export const isDailyQuotaExhausted = (error: unknown): boolean => {
  const text = errorText(error);
  return (
    /GenerateRequestsPerDay/i.test(text) ||
    /PerDayPerProjectPerModel/i.test(text) ||
    /free_tier_requests/i.test(text) ||
    (/exceeded your current quota/i.test(text) &&
      /FreeTier/i.test(text) &&
      /PerDay/i.test(text))
  );
};

export const isRetryableGeminiError = (error: unknown): boolean => {
  // Daily free-tier caps will not recover within a job — fail fast / try fallbacks.
  if (isDailyQuotaExhausted(error)) return false;

  const status = readErrorStatus(error);
  if (status !== undefined && [408, 429, 500, 502, 503, 504].includes(status)) {
    return true;
  }

  const text = errorText(error);
  return (
    /\b503\b/.test(text) ||
    /\b429\b/.test(text) ||
    /\b500\b/.test(text) ||
    /\b502\b/.test(text) ||
    /\b504\b/.test(text) ||
    /UNAVAILABLE/i.test(text) ||
    /RESOURCE_EXHAUSTED/i.test(text) ||
    /\bINTERNAL\b/.test(text) ||
    /high demand/i.test(text) ||
    /try again later/i.test(text) ||
    /temporarily/i.test(text) ||
    /rate limit/i.test(text) ||
    /ECONNRESET/i.test(text) ||
    /ETIMEDOUT/i.test(text) ||
    /socket hang up/i.test(text) ||
    /fetch failed/i.test(text)
  );
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

const toFunctionDeclarations = (
  tools: ToolDefinition[],
): FunctionDeclaration[] =>
  tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parametersJsonSchema: tool.parameters,
  }));

const parseArgsObject = (
  raw: string | undefined,
): Record<string, unknown> => {
  if (!raw?.trim()) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return { value: parsed };
  } catch {
    return { raw };
  }
};

/**
 * Normalize thought signatures from SDK / REST shapes (camelCase, snake_case, bytes).
 */
export const normalizeThoughtSignature = (
  value: unknown,
): string | undefined => {
  if (typeof value === "string" && value.length > 0) return value;
  if (value instanceof Uint8Array && value.length > 0) {
    return Buffer.from(value).toString("base64");
  }
  if (
    value &&
    typeof value === "object" &&
    "type" in value &&
    (value as { type?: string }).type === "Buffer" &&
    "data" in value &&
    Array.isArray((value as { data?: unknown }).data)
  ) {
    return Buffer.from((value as { data: number[] }).data).toString("base64");
  }
  return undefined;
};

const readPartThoughtSignature = (part: Part): string | undefined => {
  const direct = normalizeThoughtSignature(part.thoughtSignature);
  if (direct) return direct;

  const snake = normalizeThoughtSignature(
    (part as Part & { thought_signature?: unknown }).thought_signature,
  );
  if (snake) return snake;

  const nested = part.functionCall as
    | (NonNullable<Part["functionCall"]> & {
        thoughtSignature?: unknown;
        thought_signature?: unknown;
      })
    | undefined;
  return (
    normalizeThoughtSignature(nested?.thoughtSignature) ??
    normalizeThoughtSignature(nested?.thought_signature)
  );
};

const isRawModelPart = (value: unknown): value is Part =>
  !!value && typeof value === "object";

/**
 * Convert provider-agnostic messages into Gemini contents + system instruction.
 * Exported for unit tests.
 */
export const toGeminiRequestParts = (
  messages: LLMMessage[],
): { systemInstruction: string | undefined; contents: Content[] } => {
  const systemChunks: string[] = [];
  const contents: Content[] = [];
  let pendingToolParts: Part[] = [];

  const flushToolParts = () => {
    if (pendingToolParts.length === 0) return;
    contents.push({ role: "user", parts: pendingToolParts });
    pendingToolParts = [];
  };

  for (const message of messages) {
    if (message.role === "system") {
      if (message.content?.trim()) systemChunks.push(message.content);
      continue;
    }

    if (message.role === "tool") {
      pendingToolParts.push({
        functionResponse: {
          id: message.toolCallId,
          name: message.name ?? "tool",
          response: { output: message.content ?? "" },
        },
      });
      continue;
    }

    flushToolParts();

    if (message.role === "user") {
      contents.push({
        role: "user",
        parts: [{ text: message.content ?? "" }],
      });
      continue;
    }

    // Prefer exact model parts from the prior response (required for Gemini 3 signatures).
    if (
      Array.isArray(message.rawModelParts) &&
      message.rawModelParts.length > 0 &&
      message.rawModelParts.every(isRawModelPart)
    ) {
      contents.push({
        role: "model",
        parts: message.rawModelParts as Part[],
      });
      continue;
    }

    // assistant — reconstruct when raw parts are unavailable
    const parts: Part[] = [];
    if (message.content?.trim()) {
      parts.push({ text: message.content });
    }
    if (message.toolCalls?.length) {
      message.toolCalls.forEach((call, index) => {
        const part: Part = {
          functionCall: {
            id: call.id,
            name: call.name,
            args: parseArgsObject(call.arguments),
          },
        };
        const signature =
          call.thoughtSignature ??
          (index === 0 ? SKIP_THOUGHT_SIGNATURE : undefined);
        if (signature) {
          part.thoughtSignature = signature;
        }
        parts.push(part);
      });
    }
    contents.push({
      role: "model",
      parts: parts.length > 0 ? parts : [{ text: "" }],
    });
  }

  flushToolParts();

  return {
    systemInstruction: systemChunks.length
      ? systemChunks.join("\n\n")
      : undefined,
    contents,
  };
};

export class GeminiProvider implements LLMProvider {
  readonly name = "gemini";
  private readonly client: GoogleGenAI;
  private readonly maxRetries: number;
  private readonly retryBaseMs: number;
  private readonly retryMaxMs: number;
  private readonly fallbackModels: string[];
  private activeModelOverride?: string;

  constructor(options: GeminiProviderOptions = {}) {
    const apiKey = resolveGeminiApiKey(options.apiKey);
    if (!apiKey) {
      throw new Error(
        "Gemini API key not found. Set GEMINI_API_KEY (BYOK) or pass apiKey.",
      );
    }
    // Keep env copies clean so the SDK never reads a newline-tainted secret.
    for (const key of ENV_KEYS) {
      if (process.env[key]) {
        process.env[key] = sanitizeApiKey(process.env[key]) ?? apiKey;
      }
    }
    this.client = new GoogleGenAI({ apiKey });
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
        if (isDailyQuotaExhausted(error) && hasFallback) {
          const next = models[index + 1]!;
          console.error(
            `[pushfox] Daily/free-tier quota exhausted for model "${model}". Falling back to "${next}".`,
          );
          this.activeModelOverride = next;
          continue;
        }
        if (isDailyQuotaExhausted(error)) {
          throw new Error(
            `Gemini free-tier daily quota exhausted for model "${model}" (and no usable fallbacks remained). Enable billing at https://ai.google.dev/ or wait for the daily reset, then re-run the review.`,
          );
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
    const { systemInstruction, contents } = toGeminiRequestParts(
      request.messages,
    );

    if (contents.length === 0) {
      contents.push({ role: "user", parts: [{ text: "Begin the review." }] });
    }

    const response = await this.generateContentWithRetry({
      model,
      contents,
      config: {
        temperature: request.temperature ?? 0.1,
        maxOutputTokens: request.maxTokens,
        ...(systemInstruction ? { systemInstruction } : {}),
        automaticFunctionCalling: { disable: true },
        ...(request.tools?.length
          ? {
              tools: [
                {
                  functionDeclarations: toFunctionDeclarations(request.tools),
                },
              ],
            }
          : {}),
      },
    });

    const modelContent = response.candidates?.[0]?.content;
    const candidateParts = modelContent?.parts ?? [];
    const toolCalls: ChatResponse["toolCalls"] = [];
    let textChunks = "";

    for (const [index, part] of candidateParts.entries()) {
      if (part.functionCall) {
        const thoughtSignature = readPartThoughtSignature(part);
        toolCalls.push({
          id: part.functionCall.id ?? `gemini_call_${index}`,
          name: part.functionCall.name ?? "unknown",
          arguments: JSON.stringify(part.functionCall.args ?? {}),
          ...(thoughtSignature ? { thoughtSignature } : {}),
        });
        continue;
      }
      // Skip thought-only parts; keep visible text for transcript/fallback parsing.
      if (part.text && !part.thought) {
        textChunks += part.text;
      }
    }

    // Fallback if SDK flattens functionCalls but parts are empty/odd.
    if (toolCalls.length === 0 && response.functionCalls?.length) {
      for (const [index, call] of response.functionCalls.entries()) {
        toolCalls.push({
          id: call.id ?? `gemini_call_${index}`,
          name: call.name ?? "unknown",
          arguments: JSON.stringify(call.args ?? {}),
        });
      }
    }

    // Ensure the first function call always carries a signature when we must reconstruct.
    if (toolCalls.length > 0 && !toolCalls[0]?.thoughtSignature) {
      const signedPart = candidateParts.find(
        (part) => part.functionCall && readPartThoughtSignature(part),
      );
      const recovered = signedPart
        ? readPartThoughtSignature(signedPart)
        : undefined;
      toolCalls[0] = {
        ...toolCalls[0]!,
        thoughtSignature: recovered ?? SKIP_THOUGHT_SIGNATURE,
      };
    }

    const text = textChunks.trim()
      ? textChunks
      : response.text?.trim()
        ? response.text
        : null;

    const finishReason =
      response.candidates?.[0]?.finishReason?.toString() ?? null;

    return {
      content: text,
      toolCalls,
      finishReason,
      rawModelParts: candidateParts.length > 0 ? candidateParts : undefined,
      raw: response,
    };
  }

  private async generateContentWithRetry(
    params: Parameters<GoogleGenAI["models"]["generateContent"]>[0],
  ): Promise<Awaited<ReturnType<GoogleGenAI["models"]["generateContent"]>>> {
    let lastError: unknown;

    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      try {
        return await this.client.models.generateContent(params);
      } catch (error) {
        lastError = error;
        if (isDailyQuotaExhausted(error)) throw error;

        const canRetry =
          attempt < this.maxRetries && isRetryableGeminiError(error);
        if (!canRetry) throw error;

        const delay = retryDelayMs(
          attempt,
          this.retryBaseMs,
          this.retryMaxMs,
        );
        const status = readErrorStatus(error);
        console.error(
          `[pushfox] Gemini transient error${status ? ` status=${status}` : ""} (attempt ${attempt + 1}/${this.maxRetries + 1}); retrying in ${delay}ms`,
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
