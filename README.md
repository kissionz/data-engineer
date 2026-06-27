# harness-ts

A TypeScript / Node.js local coding agent harness runtime.

## Requirements

- Node.js 22.12 or newer
- Git for `GitStatus` and `GitDiff`
- ripgrep (`rg`) for `Grep` and `Glob`

This P0 implementation includes:

- Agent loop with model tool-call continuation
- Append-only session event log
- Workspace path boundary checks
- Read, Grep, Glob, Write, Edit, Bash, Git status/diff, and Todo tools
- Explicit, read-only project Skill discovery and loading
- Tool registry
- Permission gate with allow / ask / deny decisions
- Real OpenAI Responses API model client by default
- Streaming model output with concise tool status lines
- Append-only context compaction and tool lifecycle hooks
- Mock model only for explicit local loop testing

## Usage

```bash
npm install
cp .env.example .env
# edit .env and set OPENAI_API_KEY
npm run build
npm start -- --task "Inspect this project and summarize what it does"
```

Without `--task`, the CLI starts an interactive session and keeps accepting user messages until `/exit` or `/quit`:

```bash
npm start
```

Each process starts a new isolated session by default. Resume the most recently
selected session or a specific session explicitly:

```bash
npm start -- --resume latest
npm start -- --resume 20260627-120000-a1b2c3
```

Interactive session commands:

```text
/new
/resume <session-id|latest>
/session
/sessions
/exit
```

## Environment Setup

Create a workspace-local `.env` file:

```bash
cp .env.example .env
```

Then edit `.env`:

```bash
OPENAI_API_KEY=sk-your-real-key
OPENAI_MODEL=gpt-4.1
OPENAI_BASE_URL=https://api.openai.com/v1
```

`OPENAI_API_KEY` is required for the default provider. Shell environment variables take precedence over values in `.env`, so CI or a terminal export can override the file.

The CLI reads:

- `OPENAI_API_KEY`: required for the default OpenAI provider
- `OPENAI_MODEL`: optional model override, defaults to `gpt-4.1`
- `OPENAI_BASE_URL`: optional OpenAI-compatible API base URL, defaults to `https://api.openai.com/v1`

You can also pass the model explicitly:

```bash
npm run dev -- --model gpt-4.1 --task "Find the main agent loop"
```

For an OpenAI-compatible gateway or proxy:

```bash
npm run dev -- --base-url https://your-gateway.example/v1 --task "Inspect README.md"
```

For harness loop development without an API call, opt into the mock provider explicitly:

```bash
npm run dev -- --provider mock --task "Inspect README.md"
```

For longer tasks, adjust the per-message agent loop budget:

```bash
npm run dev -- --max-turns 100
```

## Safety Model

Tool names and arguments are validated against the same JSON Schemas sent to the model before hooks or permissions run. Unknown tools and malformed calls are returned to the model as recoverable failures without prompting for approval.

Permissions follow resource operations. `Read` and `Grep` are allowed by default. `Write` may create new files without approval but cannot overwrite an existing file. Updating files through `Edit` requires approval. Clearly readonly shell commands are allowed, while commands that may change state require approval. Dangerous shell fragments and sensitive paths such as `.git`, `.env`, and `node_modules` are denied before tool execution.

When approval is required, you can choose:

- Allow once
- Allow for this session
- Reject

Session approvals are kept only in memory until the current CLI process exits. `Edit` approvals apply to later edit tool calls in the same session. `Bash` approvals are grouped by command family, such as `npm` or `git`, so approving `npm test` for the session also allows later `npm run build` without another prompt. Dangerous commands and denied paths are still blocked before approval.

Model text is streamed to the terminal as it arrives. Tool calls show only a compact action summary and execution status; complete arguments and results remain in the session log for model continuity and diagnostics.

Session logs and their task todos are persisted separately under `.harness/sessions/` and `.harness/todos/`. They are task execution state, not long-term user memory. Internal `rg` and `git` tools use argument-based process execution for Windows and Unix compatibility; only the explicit `Bash` tool invokes a shell.

Long sessions retain the full append-only event log. Once enough new events accumulate, a bounded factual summary is appended and used with recent events for model context. `BeforeToolUse` and `AfterToolUse` hooks provide deterministic interception and observation; the default write hook blocks sensitive paths and oversized single-file writes.

## Project Skills

Project skills live under `.harness/skills/<name>/SKILL.md` and may be committed
with the repository. Each file uses YAML frontmatter:

```md
---
name: typescript-testing
description: Test and verify TypeScript changes.
---

# TypeScript Testing

Run targeted tests before the full suite.
```

The model uses `SkillList` to discover metadata and `SkillLoad` to load one
relevant instruction file explicitly. Skill names must match their directory,
files are limited to 64KB, and paths cannot escape the workspace. Files under a
skill's `scripts/` directory are never executed automatically.
