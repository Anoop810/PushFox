import { z } from "zod";
import { SeveritySchema } from "../review/findings.js";

export const ProviderNameSchema = z.enum([
  "gemini",
  "openrouter",
  "anthropic",
  "xai",
]);
export type ProviderName = z.infer<typeof ProviderNameSchema>;

const ReviewConfigSchema = z
  .object({
    maxIterations: z.number().int().positive().optional(),
    max_iterations: z.number().int().positive().optional(),
    severityThreshold: SeveritySchema.optional(),
    severity_threshold: SeveritySchema.optional(),
    maxToolOutputChars: z.number().int().positive().optional(),
    max_tool_output_chars: z.number().int().positive().optional(),
  })
  .transform((value) => ({
    maxIterations: value.maxIterations ?? value.max_iterations ?? 8,
    severityThreshold:
      value.severityThreshold ?? value.severity_threshold ?? "medium",
    maxToolOutputChars:
      value.maxToolOutputChars ?? value.max_tool_output_chars ?? 12_000,
  }));

const StaticPackConfigSchema = z
  .object({
    maxDiffBytes: z.number().int().positive().optional(),
    max_diff_bytes: z.number().int().positive().optional(),
    maxFileBytes: z.number().int().positive().optional(),
    max_file_bytes: z.number().int().positive().optional(),
    maxSurroundingFiles: z.number().int().positive().optional(),
    max_surrounding_files: z.number().int().positive().optional(),
    maxStructureEntries: z.number().int().positive().optional(),
    max_structure_entries: z.number().int().positive().optional(),
  })
  .transform((value) => ({
    maxDiffBytes: value.maxDiffBytes ?? value.max_diff_bytes ?? 200_000,
    maxFileBytes: value.maxFileBytes ?? value.max_file_bytes ?? 80_000,
    maxSurroundingFiles:
      value.maxSurroundingFiles ?? value.max_surrounding_files ?? 20,
    maxStructureEntries:
      value.maxStructureEntries ?? value.max_structure_entries ?? 200,
  }));

export const ConfigSchema = z.object({
  provider: ProviderNameSchema.default("gemini"),
  model: z.string().default("gemini-3.6-flash"),
  fallbackModels: z.array(z.string()).optional(),
  fallback_models: z.array(z.string()).optional(),
  review: ReviewConfigSchema.default({}),
  staticPack: StaticPackConfigSchema.default({}),
  static_pack: StaticPackConfigSchema.optional(),
  paths: z
    .object({
      ignore: z
        .array(z.string())
        .default([
          "node_modules",
          "dist",
          "build",
          ".git",
          "coverage",
          ".pushfox",
          "vendor",
          ".next",
        ]),
    })
    .default({}),
}).transform((value) => ({
  provider: value.provider,
  model: value.model,
  fallbackModels: value.fallbackModels ?? value.fallback_models ?? [
    "gemini-2.0-flash",
    "gemini-flash-latest",
  ],
  review: value.review,
  staticPack: value.static_pack ?? value.staticPack,
  paths: value.paths,
}));

export type PushFoxConfig = z.infer<typeof ConfigSchema>;

/** @deprecated Use PushFoxConfig */
export type PrReviewerConfig = PushFoxConfig;

export const DEFAULT_CONFIG: PushFoxConfig = ConfigSchema.parse({});
