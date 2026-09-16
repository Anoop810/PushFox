import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { PushFoxConfig } from "../config/schema.js";
import { loadConfig } from "../config/load.js";
import { createProvider, type LLMProvider } from "../providers/index.js";
import { StaticPackBuilder } from "../static-pack/builder.js";
import type { StaticPack } from "../static-pack/schema.js";
import { AgentLoop, type AgentEvent } from "../agent/loop.js";
import type { ReviewResult } from "./findings.js";

export type ReviewEngineInput = {
  repoRoot: string;
  base: string;
  head: string;
  pr?: StaticPack["pr"];
  config?: PushFoxConfig;
  provider?: LLMProvider;
  packOnly?: boolean;
  onEvent?: (event: AgentEvent) => void;
};

export type ReviewEngineOutput = {
  pack: StaticPack;
  review: ReviewResult | null;
  packPath: string;
  reviewPath: string | null;
};

/**
 * Core review coordinator — independent of GitHub.
 * Usable from CLI, Actions, or other CI.
 */
export class ReviewEngine {
  async run(input: ReviewEngineInput): Promise<ReviewEngineOutput> {
    const config =
      input.config ??
      loadConfig(input.repoRoot);

    const builder = new StaticPackBuilder();
    const packPath = join(input.repoRoot, ".pushfox", "static-pack.json");
    const pack = await builder.build({
      repoRoot: input.repoRoot,
      base: input.base,
      head: input.head,
      config,
      pr: input.pr,
      outputPath: packPath,
    });

    if (input.packOnly) {
      return { pack, review: null, packPath, reviewPath: null };
    }

    const provider =
      input.provider ??
      createProvider(config.provider, {
        fallbackModels: config.fallbackModels,
      });

    const agent = new AgentLoop();
    const review = await agent.run({
      provider,
      model: config.model,
      pack,
      maxIterations: config.review.maxIterations,
      severityThreshold: config.review.severityThreshold,
      onEvent: input.onEvent,
      toolContext: {
        repoRoot: input.repoRoot,
        baseRef: input.base,
        headRef: input.head,
        ignorePaths: config.paths.ignore,
        maxOutputChars: config.review.maxToolOutputChars,
      },
    });

    const reviewPath = join(input.repoRoot, ".pushfox", "review.json");
    mkdirSync(dirname(reviewPath), { recursive: true });
    writeFileSync(reviewPath, JSON.stringify(review, null, 2), "utf8");

    return { pack, review, packPath, reviewPath };
  }
}
