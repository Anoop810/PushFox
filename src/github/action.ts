#!/usr/bin/env node
/**
 * GitHub Action entrypoint.
 * Expects a checked-out repo and GitHub event context via env.
 */
import { resolve } from "node:path";
import { loadConfig } from "../config/load.js";
import { createProvider } from "../providers/index.js";
import { ReviewEngine } from "../review/engine.js";
import {
  formatReviewMarkdown,
  publishPullRequestComment,
} from "./publish.js";
import type { AgentEvent } from "../agent/loop.js";

const requireEnv = (name: string): string => {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
};

const env = (...names: string[]): string | undefined => {
  for (const name of names) {
    const value = process.env[name];
    if (value) return value;
  }
  return undefined;
};

const main = async (): Promise<void> => {
  const workspace = resolve(process.env.GITHUB_WORKSPACE || process.cwd());
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;

  const eventName = process.env.GITHUB_EVENT_NAME ?? "";
  const base =
    env("PUSHFOX_BASE", "PRNERD_BASE") ||
    process.env.GITHUB_BASE_REF ||
    "main";
  const head =
    env("PUSHFOX_HEAD", "PRNERD_HEAD") ||
    process.env.GITHUB_HEAD_REF ||
    "HEAD";

  // Prefer SHAs when available (Actions checkout)
  const baseSha = env("PUSHFOX_BASE_SHA", "PRNERD_BASE_SHA");
  const headSha = env("PUSHFOX_HEAD_SHA", "PRNERD_HEAD_SHA");

  const maxIterationsRaw = env(
    "PUSHFOX_MAX_ITERATIONS",
    "PRNERD_MAX_ITERATIONS",
  );

  const config = loadConfig(workspace, {
    provider: env("PUSHFOX_PROVIDER", "PRNERD_PROVIDER"),
    model: env("PUSHFOX_MODEL", "PRNERD_MODEL"),
    maxIterations: maxIterationsRaw ? Number(maxIterationsRaw) : undefined,
    severityThreshold: env(
      "PUSHFOX_SEVERITY_THRESHOLD",
      "PRNERD_SEVERITY_THRESHOLD",
    ),
  });

  const explicitKey =
    config.provider === "openrouter"
      ? process.env.OPENROUTER_API_KEY ||
        process.env.PUSHFOX_OPENROUTER_API_KEY
      : process.env.GEMINI_API_KEY ||
        process.env.GOOGLE_API_KEY ||
        process.env.GOOGLE_GENERATIVE_AI_API_KEY ||
        process.env.PUSHFOX_GEMINI_API_KEY ||
        process.env.PRNERD_GEMINI_API_KEY;

  let provider;
  try {
    const maxRetries = process.env.PRNERD_GEMINI_MAX_RETRIES
      ? Number(process.env.PRNERD_GEMINI_MAX_RETRIES)
      : undefined;
    const retryBaseMs = process.env.PRNERD_GEMINI_RETRY_BASE_MS
      ? Number(process.env.PRNERD_GEMINI_RETRY_BASE_MS)
      : undefined;
    provider = createProvider(config.provider, {
      ...(explicitKey ? { apiKey: explicitKey } : {}),
      ...(Number.isFinite(maxRetries) ? { maxRetries } : {}),
      ...(Number.isFinite(retryBaseMs) ? { retryBaseMs } : {}),
      fallbackModels: config.fallbackModels,
    });
  } catch (error) {
    throw new Error(
      error instanceof Error
        ? error.message
        : config.provider === "openrouter"
          ? "BYOK: set OPENROUTER_API_KEY secret for OpenRouter reviews"
          : "BYOK: set GEMINI_API_KEY secret for Gemini reviews",
    );
  }
  const engine = new ReviewEngine();

  const prNumberRaw = env("PUSHFOX_PR_NUMBER", "PRNERD_PR_NUMBER");

  const result = await engine.run({
    repoRoot: workspace,
    base: baseSha || base,
    head: headSha || head,
    config,
    provider,
    pr: {
      number: prNumberRaw ? Number(prNumberRaw) : undefined,
      title: env("PUSHFOX_PR_TITLE", "PRNERD_PR_TITLE"),
      body: env("PUSHFOX_PR_BODY", "PRNERD_PR_BODY"),
      author: env("PUSHFOX_PR_AUTHOR", "PRNERD_PR_AUTHOR"),
      url: env("PUSHFOX_PR_URL", "PRNERD_PR_URL"),
    },
    onEvent: (event: AgentEvent) => {
      if (event.type === "iteration") {
        console.log(`iteration ${event.iteration}`);
      } else if (event.type === "tool_call") {
        console.log(`tool ${event.name}`);
      } else if (event.type === "completed") {
        console.log(`findings ${event.result.findings.length}`);
      }
    },
  });

  if (!result.review) {
    throw new Error("Review engine returned no review");
  }

  const body = formatReviewMarkdown(result.review);
  console.log(body);

  const publishFlag = env("PUSHFOX_PUBLISH", "PRNERD_PUBLISH");
  const shouldPublish =
    publishFlag !== "false" &&
    Boolean(token) &&
    Boolean(prNumberRaw || process.env.GITHUB_EVENT_PATH);

  if (!shouldPublish) {
    console.log(
      "Skipping GitHub publish (no token/PR number or PUSHFOX_PUBLISH=false)",
    );
    return;
  }

  if (!token) {
    throw new Error("GITHUB_TOKEN required to publish review comments");
  }

  let pullNumber = prNumberRaw ? Number(prNumberRaw) : undefined;
  let repository =
    env("PUSHFOX_REPOSITORY", "PRNERD_REPOSITORY") ||
    process.env.GITHUB_REPOSITORY;

  if ((!pullNumber || !repository) && process.env.GITHUB_EVENT_PATH) {
    const event = JSON.parse(
      await import("node:fs").then(({ readFileSync }) =>
        readFileSync(requireEnv("GITHUB_EVENT_PATH"), "utf8"),
      ),
    ) as {
      pull_request?: { number?: number };
      number?: number;
      repository?: { full_name?: string };
    };
    pullNumber =
      pullNumber ??
      event.pull_request?.number ??
      event.number;
    repository = repository ?? event.repository?.full_name;
  }

  if (!pullNumber || !repository) {
    console.log(
      `Cannot publish: event=${eventName} pullNumber=${pullNumber} repository=${repository}`,
    );
    return;
  }

  const published = await publishPullRequestComment({
    token,
    repository,
    pullNumber,
    body,
  });
  console.log(`Published review comment: ${published.url}`);
};

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
