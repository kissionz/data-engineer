# harness-ts

A TypeScript / Node.js agent harness runtime inspired by Claude Code-style tool loops.

This P0 implementation includes:

- Agent loop with model tool-call continuation
- Append-only session event log
- Workspace path boundary checks
- Read, Edit, and Bash tools
- Tool registry
- Permission gate with allow / ask / deny decisions
- Mock model for local loop testing

## Usage

```bash
pnpm install
pnpm build
pnpm dev -- --task "Inspect README.md"
```

The default CLI uses `MockModel` so the P0 loop can run without a real model API key.
