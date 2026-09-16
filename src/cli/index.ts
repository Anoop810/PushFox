#!/usr/bin/env node
import { resolve } from "node:path";
import { readFileSync, existsSync } from "node:fs";
import { Command } from "commander";
import { loadConfig } from "../config/load.js";
import { ReviewEngine } from "../review/engine.js";
import { formatReviewMarkdown } from "../github/publish.js";
import {
  byokHintForProvider,
  createProvider,
} from "../providers/index.js";
import type { AgentEvent } from "../agent/loop.js";

const printEvent = (event: AgentEvent, verbose: boolean): void => {
  if (!verbose && event.type === "message") return;
  switch (event.type) {
    case "iteration":
      console.error(`[agent] iteration ${event.iteration}`);
      break;
    case "tool_call":
      console.error(`[tool] → ${event.name}`);
      break;
    case "tool_result":
      console.error(
        `[tool] ← ${event.name} ok=${event.ok} truncated=${event.truncated}`,
      );
      break;
    case "message":
      console.error(`[model] ${event.content.slice(0, 200)}`);
      break;
    case "completed":
      console.error(
        `[agent] completed with ${event.result.findings.length} finding(s); confidence=${event.result.confidence}`,
      );
      break;
    case "forced_stop":
      console.error(`[agent] stop: ${event.reason}`);
      break;
  }
};

const program = new Command();

program
  .name("pushfox")
  .description(
    "PushFox — BYOK AI PR reviewer that investigates before it reviews",
  )
  .version("0.1.0");

program
  .command("pack")
  .description("Build the deterministic Static Context Pack only")
  .requiredOption("--base <ref>", "Base git ref (e.g. main)")
  .option("--head <ref>", "Head git ref", "HEAD")
  .option("--repo <path>", "Repository root", ".")
  .action(async (opts: { base: string; head: string; repo: string }) => {
    const repoRoot = resolve(opts.repo);
    const config = loadConfig(repoRoot);
    const engine = new ReviewEngine();
    const result = await engine.run({
      repoRoot,
      base: opts.base,
      head: opts.head,
      config,
      packOnly: true,
    });
    console.log(`Static pack written to ${result.packPath}`);
    console.log(
      `Changed files: ${result.pack.changedFiles.length}; diff truncated: ${result.pack.diff.truncated}`,
    );
  });

program
  .command("review")
  .description("Build Static Pack, run agentic investigation, emit findings")
  .requiredOption("--base <ref>", "Base git ref (e.g. main)")
  .option("--head <ref>", "Head git ref", "HEAD")
  .option("--repo <path>", "Repository root", ".")
  .option("--provider <name>", "LLM provider override")
  .option("--model <name>", "Model override")
  .option("--max-iterations <n>", "Max agent iterations", (v) => Number(v))
  .option("--severity-threshold <level>", "Minimum severity to report")
  .option("--verbose", "Log agent tool calls", false)
  .option("--json", "Print review JSON to stdout", false)
  .option("--markdown", "Print review markdown to stdout", false)
  .action(
    async (opts: {
      base: string;
      head: string;
      repo: string;
      provider?: string;
      model?: string;
      maxIterations?: number;
      severityThreshold?: string;
      verbose?: boolean;
      json?: boolean;
      markdown?: boolean;
    }) => {
      const repoRoot = resolve(opts.repo);
      const config = loadConfig(repoRoot, {
        provider: opts.provider,
        model: opts.model,
        maxIterations: opts.maxIterations,
        severityThreshold: opts.severityThreshold,
      });

      let provider;
      try {
        provider = createProvider(config.provider, {
          fallbackModels: config.fallbackModels,
        });
      } catch (error) {
        console.error(
          error instanceof Error ? error.message : String(error),
        );
        console.error(byokHintForProvider(config.provider));
        process.exitCode = 1;
        return;
      }

      const engine = new ReviewEngine();
      const result = await engine.run({
        repoRoot,
        base: opts.base,
        head: opts.head,
        config,
        provider,
        onEvent: (e) => printEvent(e, Boolean(opts.verbose)),
      });

      if (!result.review) {
        console.error("No review produced.");
        process.exitCode = 1;
        return;
      }

      console.error(`Review written to ${result.reviewPath}`);
      console.error(`Findings: ${result.review.findings.length}`);

      if (opts.json) {
        console.log(JSON.stringify(result.review, null, 2));
      } else if (opts.markdown) {
        console.log(formatReviewMarkdown(result.review));
      } else {
        console.log(formatReviewMarkdown(result.review));
      }
    },
  );

program
  .command("show-pack")
  .description("Print a previously built static-pack.json")
  .option("--repo <path>", "Repository root", ".")
  .action((opts: { repo: string }) => {
    const path = resolve(opts.repo, ".pushfox", "static-pack.json");
    if (!existsSync(path)) {
      console.error(`No pack found at ${path}. Run: pushfox pack --base <ref>`);
      process.exitCode = 1;
      return;
    }
    console.log(readFileSync(path, "utf8"));
  });

program.parseAsync(process.argv).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
