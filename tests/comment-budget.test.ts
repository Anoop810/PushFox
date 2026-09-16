import { describe, expect, it } from "vitest";
import {
  GITHUB_COMMENT_MAX_CHARS,
  truncateCommentBody,
} from "../src/github/comment-budget.js";

describe("comment budget", () => {
  it("leaves short bodies unchanged", () => {
    expect(truncateCommentBody("hello")).toBe("hello");
  });

  it("returns a body no longer than the GitHub limit", () => {
    const huge = "x".repeat(GITHUB_COMMENT_MAX_CHARS + 500);
    const out = truncateCommentBody(huge);
    // Intentionally asserts the contract callers rely on.
    expect(out.length).toBeLessThanOrEqual(GITHUB_COMMENT_MAX_CHARS);
    expect(out).toContain("truncated by PushFox");
  });
});
