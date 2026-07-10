# Contributing

## Development

Use Node.js 22.12 or newer, then install the locked dependencies:

```bash
npm ci
```

Keep changes focused and preserve the security boundaries around paths,
permissions, environment loading, MCP, and command execution.

## Validation

Before submitting a change, run:

```bash
npm run check
npm run pack:check
```

Changes to CLI behavior require tests for both human-readable and
machine-readable modes. Changes to persisted state require migration and
recovery tests. Do not include secrets or private repository content in test
fixtures, telemetry, or bug reports.
