## [FEAT-20260630-001] automatic_runtime_env_discovery

**Logged**: 2026-06-30T10:06:06Z
**Priority**: medium
**Status**: resolved
**Area**: config

### Requested Capability
When `harness` is installed with `npm link` and launched from another workspace, automatically load the Harness source/install directory `.env` without requiring per-machine user config.

### User Context
The expected experience is to enter any project directory and run `harness` directly, with project instructions coming from that workspace and provider credentials coming from the Harness installation.

### Complexity Estimate
simple

### Suggested Implementation
Derive the trusted runtime root from `import.meta.url`. When neither `--env-file` nor user `envFile` is configured, load the runtime-root `.env` first and then load missing variables from the current workspace `.env`.

### Metadata
- Frequency: first_time
- Related Features: workspace env auto-loading, user envFile

### Resolution
- **Resolved**: 2026-06-30T10:07:33Z
- **Notes**: Added runtime-root `.env` discovery with workspace `.env` supplementation, documented precedence, and passed the full test suite.

---
