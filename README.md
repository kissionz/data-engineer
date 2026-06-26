# harness-ts

A TypeScript / Node.js local coding agent harness runtime.

This P0 implementation includes:

- Agent loop with model tool-call continuation
- Append-only session event log
- Workspace path boundary checks
- Read, Grep, Write, Edit, and Bash tools
- Tool registry
- Permission gate with allow / ask / deny decisions
- Real OpenAI Responses API model client by default
- Streaming model output with concise tool status lines
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

Permissions follow resource operations. `Read` and `Grep` are allowed by default. `Write` may create new files without approval but cannot overwrite an existing file. Updating files through `Edit` requires approval. Clearly readonly shell commands are allowed, while commands that may change state require approval. Dangerous shell fragments and sensitive paths such as `.git`, `.env`, and `node_modules` are denied before tool execution.

When approval is required, you can choose:

- Allow once
- Allow for this session
- Reject

Session approvals are kept only in memory until the current CLI process exits. `Edit` approvals apply to later edit tool calls in the same session. `Bash` approvals are grouped by command family, such as `npm` or `git`, so approving `npm test` for the session also allows later `npm run build` without another prompt. Dangerous commands and denied paths are still blocked before approval.

Model text is streamed to the terminal as it arrives. Tool calls show only a compact action summary and execution status; complete arguments and results remain in the session log for model continuity and diagnostics.
