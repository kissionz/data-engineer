# harness-ts

A TypeScript / Node.js local coding agent harness runtime.

## Requirements

- Node.js 22.12 or newer
- Git for `GitStatus` and `GitDiff`
- ripgrep (`rg`) for `Grep` and `Glob`
- Docker with Linux containers for sandboxed Bash, or Bash installed locally
  when explicitly using host mode

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
- Docker-isolated Bash with explicit host/off modes
- Bounded, read-only code-reviewer subagent
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
- `HARNESS_BASH_SANDBOX`: `auto`, `docker`, `host`, or `off`
- `HARNESS_SANDBOX_IMAGE`: Docker image used for Bash
- `HARNESS_SANDBOX_PULL`: `never` or `missing`
- `HARNESS_SANDBOX_NETWORK`: `none` or `bridge`

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

## Bash Sandbox

The default `auto` mode uses Docker only when the daemon, Linux container mode,
local Docker context, sandbox image, and workspace mount all pass readiness
checks. If any check fails, the Bash tool is not registered. It never silently
falls back to host execution.

Fetch the default image when missing:

```bash
npm start -- --sandbox-pull missing
```

Require Docker or disable Bash explicitly:

```bash
npm start -- --bash-sandbox docker
npm start -- --bash-sandbox off
```

Host Bash is an explicit compatibility choice and has no OS isolation:

```bash
npm start -- --bash-sandbox host
```

On Windows, host mode requires `bash.exe` on `PATH`, such as Git for Windows.
Docker mode runs Bash with no network by default, a read-only container root,
dropped capabilities, process/memory/CPU limits, a hidden `.harness`, masked
`.env*` files, read-only `.git`, and per-session Linux `node_modules`. Enable
network access only for tasks that require it:

```bash
npm start -- --sandbox-network bridge
```

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

## Read-Only Subagent

The `Task` tool can run the built-in `code-reviewer` as a separate AgentLoop.
It has its own hidden append-only audit log and a maximum of 20 turns. Its tool
registry contains only:

```text
Read
Grep
Glob
GitStatus
GitDiff
SkillList
SkillLoad
```

It cannot access `Write`, `Edit`, `Bash`, `TodoWrite`, or `Task`, so it cannot
modify files or recursively create more subagents. The parent receives only the
bounded final review result.
