/** GitHub issue comment body limit is 65536 characters. */
export const GITHUB_COMMENT_MAX_CHARS = 65_536;

const TRUNCATION_MARKER = "\n\n_…truncated by PushFox_";

/**
 * Keep PR comment bodies under GitHub's hard limit.
 * Prefer cutting earlier so the truncation marker still fits.
 */
export const truncateCommentBody = (
  body: string,
  maxChars: number = GITHUB_COMMENT_MAX_CHARS,
): string => {
  if (body.length <= maxChars) return body;

  const budget = Math.max(0, maxChars - TRUNCATION_MARKER.length);
  return `${body.slice(0, budget)}${TRUNCATION_MARKER}`;
};
