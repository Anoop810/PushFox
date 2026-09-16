# PushFox

**An AI PR reviewer that investigates before it reviews.**

PushFox is a reusable, open-source, **BYOK** (Bring Your Own Key) pull-request review tool. It does not dump a diff into an LLM and hope for the best. It builds a deterministic **Static Context Pack**, then runs an **agentic investigation loop** that can search and read the repository until it has enough confidence to produce a **structured review**.

```
Pull Request
    ↓
Static Context Pack
    ↓
Agentic Investigation Loop
    ↓
Structured Review
    ↓
GitHub PR / CLI
```

Philosophy: **Prepare → Investigate → Understand → Review**  
Not: Diff → LLM → Comments

> PushFox aims for high-signal findings. It does **not** claim to find every bug.

---

## Why this is different

Most “AI PR review” tools send a patch to a model and paste the reply as comments.

PushFox separates two kinds of context:

| Stage | What it is | Who runs it |
|--------|------------|-------------|
| **Static Pack** | Cheap, bounded, reproducible first context | Deterministic code (git / fs / ripgrep) |
| **Agentic Loop** | Dynamic follow-up when the pack is not enough | LLM chooses tools until confident |

Example:

1. Static Pack includes `src/auth/login.ts` and its diff  
2. Agent notices a changed helper  
3. Agent calls `find_references` / `search_code`  
4. Agent reads a caller and a config file  
5. Agent submits structured findings — or zero findings

---

## Features (V1)

- **BYOK** — your API key, your provider account; keys are never hard-coded or persisted by PushFox
- **Static Context Pack** — inspectable at `.pushfox/static-pack.json`
- **Agent tools** — `get_diff`, `read_file`, `search_code`, `list_files`, `find_references`, `get_file_history`, `submit_review`
- **Hard iteration limit** — investigation cannot run forever
- **Structured findings** — severity, file, line, explanation, suggestion
- **AGENTS.md support** — repository guidance included as *untrusted* context
- **Prompt-injection hardening** — system instructions stay above repo/PR/tool text
- **Local CLI** — debug without GitHub
- **GitHub Actions** — optional PR comment publishing
- **No vector DB** — git + filesystem + `rg` only
- **Gemini / OpenRouter** — BYOK LLM providers (`gemini` default; `openrouter` for multi-model routing)

---

## Installation

Requires **Node.js 20+**. `git` is required. `rg` (ripgrep) is recommended for faster search.

```bash
npm install -g github:Anoop810/PushFox
# or from this repo:
npm install
npm run build
npm link
```

---

## BYOK

### Gemini

```bash
# Windows PowerShell
$env:GEMINI_API_KEY = "your-key"

# macOS / Linux
export GEMINI_API_KEY=your-key
```

`GOOGLE_API_KEY` and `GOOGLE_GENERATIVE_AI_API_KEY` are also accepted as Gemini key aliases.

### OpenRouter

```bash
# Windows PowerShell
$env:OPENROUTER_API_KEY = "your-key"

# macOS / Linux
export OPENROUTER_API_KEY=your-key
```

Use OpenRouter model ids in `.pushfox.yml` (for example `google/gemini-3.6-flash` or `openai/gpt-4o-mini`).

In GitHub Actions, store the key as a repository secret (`GEMINI_API_KEY` or `OPENROUTER_API_KEY`) and pass it into the workflow. PushFox only sends the key to the configured LLM provider.

Never commit keys. Never put keys in `.pushfox.yml`.

---

## Local usage

### 1. Build the Static Pack only

```bash
pushfox pack --base main --head HEAD
```

Writes `.pushfox/static-pack.json`.

### 2. Full review

```bash
pushfox review --base main --head HEAD --verbose
```

Options:

```bash
pushfox review --base main --head HEAD --json
pushfox review --base main --head HEAD --markdown
pushfox review --base main --head HEAD --model gemini-2.5-flash --max-iterations 6
pushfox show-pack
```

### Example review output

```markdown
## PushFox Review

Authentication error paths look incomplete when the upstream IdP times out.

_Confidence: medium_

### Findings (1)

#### [HIGH] Unhandled rejection on timeout
- **Where:** `src/auth/login.ts:84`
- **Category:** error_handling
- **Why:** `fetchProfile` can reject after the request is aborted; the catch block only handles `AuthError`.
- **Suggestion:** Catch abort/timeout errors and map them to a retryable response.
```

Empty reviews are valid when nothing meaningful is found.

---

## Configuration

Optional `.pushfox.yml` in the repo root:

```yaml
provider: openrouter
model: google/gemini-3.6-flash
fallback_models:
  - google/gemini-3.5-flash
  - openai/gpt-4o-mini

review:
  max_iterations: 8
  severity_threshold: medium

paths:
  ignore:
    - node_modules
    - dist
```

Gemini example:

```yaml
provider: gemini
model: gemini-2.5-flash
```

---

## GitHub Action setup

1. Add repository secret `OPENROUTER_API_KEY` (or `GEMINI_API_KEY` for Gemini)
2. Add a workflow such as `.github/workflows/pushfox.yml`:

```yaml
name: PushFox PR Review

on:
  pull_request:
    types: [opened, synchronize, reopened]

permissions:
  contents: read
  pull-requests: write

jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - uses: actions/setup-node@v4
        with:
          node-version: "22"

      - run: npm install -g github:Anoop810/PushFox

      - name: Run PushFox
        env:
          OPENROUTER_API_KEY: ${{ secrets.OPENROUTER_API_KEY }}
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          PUSHFOX_PROVIDER: openrouter
          PUSHFOX_BASE_SHA: ${{ github.event.pull_request.base.sha }}
          PUSHFOX_HEAD_SHA: ${{ github.event.pull_request.head.sha }}
          PUSHFOX_PR_NUMBER: ${{ github.event.pull_request.number }}
          PUSHFOX_PR_TITLE: ${{ github.event.pull_request.title }}
          PUSHFOX_PR_BODY: ${{ github.event.pull_request.body }}
          PUSHFOX_PR_AUTHOR: ${{ github.event.pull_request.user.login }}
          PUSHFOX_PR_URL: ${{ github.event.pull_request.html_url }}
          PUSHFOX_REPOSITORY: ${{ github.repository }}
        run: node "$(npm root -g)/pushfox/dist/github/action.js"
```

V1 publishes a single structured PR comment (not inline line comments).

---

## Supported providers

| Provider | V1 status |
|----------|-----------|
| Gemini | Implemented |
| OpenRouter | Implemented (OpenAI-compatible; any routed model) |
| Anthropic | Interface stub |
| xAI | Interface stub |

The agent engine depends only on `LLMProvider`. Adding a provider should not require rewriting the review loop.

---

## Architecture

```
GitHub Action / CLI
        ↓
   Review Engine
        ↓
 Static Pack Builder  →  .pushfox/static-pack.json
        ↓
    Agent Loop
   ↙    ↓    ↘
search read diff / history
   ↘    ↓    ↙
   Repository
        ↓
   LLM Provider (BYOK Gemini / OpenRouter)
        ↓
 Structured Findings → CLI / GitHub comment
```

### Directory layout

```
src/
  agent/         # prompts + investigation loop
  static-pack/   # StaticPackBuilder + schema
  tools/         # repository tools
  providers/     # LLMProvider + Gemini + OpenRouter
  review/        # ReviewEngine + findings
  github/        # Action entry + comment publishing
  config/        # .pushfox.yml
  cli/           # pushfox CLI
  utils/         # git/exec helpers
```

### Static Pack (v1)

Deterministic JSON including:

- PR / comparison metadata (base, head, SHAs)
- Changed files + full (bounded) diff
- Surrounding code for changed files
- Import hints + related tests
- `AGENTS.md` / similar instructions (if present)
- Relevant file-structure snippet
- Basic commit metadata

### Agent loop

1. System reviewer instructions (trusted)
2. Static Pack as untrusted repository context
3. Model may call tools (bounded output, secret paths blocked)
4. Tool results wrapped as untrusted
5. Model calls `submit_review` with structured JSON
6. Invalid / malformed payloads → **empty findings** (fail safe)
7. Hard stop at `max_iterations`

---

## Repository instructions (`AGENTS.md`)

If `AGENTS.md` (or `AGENT.md` / `CLAUDE.md`) exists, it is included in the Static Pack.

Repository content — including AGENTS.md, README, PR descriptions, comments, and tool output — is **untrusted** and cannot override system reviewer rules.

---

## Development

```bash
npm install
npm run typecheck
npm run lint
npm test
npm run build
```

Tests mock the LLM. No real API calls in CI.

---

## Environment variables

| Variable | Purpose |
|----------|---------|
| `GEMINI_API_KEY` | BYOK key for Gemini |
| `GOOGLE_API_KEY` | Alias for Gemini BYOK key |
| `OPENROUTER_API_KEY` | BYOK key for OpenRouter |
| `PUSHFOX_PROVIDER` | Provider override (`gemini` or `openrouter`) |
| `PUSHFOX_MODEL` | Model override (e.g. `gemini-2.5-flash` or `google/gemini-3.6-flash`) |
| `PUSHFOX_MAX_ITERATIONS` | Agent iteration cap |
| `PUSHFOX_SEVERITY_THRESHOLD` | Minimum reported severity |
| `PUSHFOX_PUBLISH` | `false` to skip GitHub comment |
| `GITHUB_TOKEN` | Publish PR comments in Actions |

---

## Roadmap (V2+)

- Native Anthropic / xAI providers
- Inline GitHub review comments
- Parallel tool calls + smarter pack budgeting
- Incremental review on push (review only new commits)
- SARIF / code-scanning export
- Optional ignore-findings suppressions file

---

## License

MIT
