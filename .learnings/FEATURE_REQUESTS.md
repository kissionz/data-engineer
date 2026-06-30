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

## [FEAT-20260630-002] search_without_external_ripgrep

**Logged**: 2026-06-30T10:15:00Z
**Priority**: high
**Status**: resolved
**Area**: backend

### Requested Capability
Keep fast file-name and file-content search available on machines without a separately installed `rg` executable.

### User Context
The model attempted to call Glob on Windows, but Harness had omitted both Glob and Grep because ripgrep was unavailable. Comparable coding agents still expose file search without requiring manual dependency setup.

### Complexity Estimate
medium

### Suggested Implementation
Retain ripgrep as the accelerated backend when detected, add bounded native Node.js fallbacks for Glob and Grep, register both tools on every platform, and keep sensitive/generated paths excluded.

### Metadata
- Frequency: recurring
- Related Features: Glob, Grep, runtime capability discovery

### Resolution
- **Resolved**: 2026-06-30T10:20:01Z
- **Notes**: Kept ripgrep acceleration, added bounded native Glob/Grep backends, registered search tools without rg, added backend visibility, and passed the full test suite.

---
