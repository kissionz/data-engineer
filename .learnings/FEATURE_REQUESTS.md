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

## [FEAT-20260703-001] guided_mcp_configuration

**Logged**: 2026-07-03T03:32:29Z
**Priority**: high
**Status**: resolved
**Area**: config

### Requested Capability
Provide a guided CLI for adding, listing, and removing MCP servers instead of requiring users to locate and edit JSON configuration manually.

### User Context
Manual configuration is cumbersome and error-prone, especially on Windows where users may edit the wrong config path or produce invalid JSON.

### Complexity Estimate
medium

### Suggested Implementation
Add `harness mcp add/list/remove`, include a MaxCompute Remote MCP preset, validate all generated configuration through the existing schema, and save it atomically with private permissions.

### Metadata
- Frequency: first_time
- Related Features: MCP OAuth, trusted user config

### Resolution
- **Resolved**: 2026-07-03T03:39:15Z
- **Notes**: Added guided `mcp add/list/remove` commands, a zero-input MaxCompute preset, schema validation, atomic private config writes, Windows documentation, and automated tests.

---

## [FEAT-20260703-002] scoped_mcp_vpc_access

**Logged**: 2026-07-03T05:48:06Z
**Priority**: high
**Status**: resolved
**Area**: config

### Requested Capability
Allow an explicitly configured MCP server to connect to a VPC-only endpoint without disabling global SSRF protections.

### User Context
The MaxCompute deployment is intentionally reachable only through its VPC endpoint, which resolves into `100.64.0.0/10` and is rejected by the current public-only MCP network policy.

### Complexity Estimate
medium

### Suggested Implementation
Add a per-server VPC network mode covering standard private-routable address classes, keep loopback/link-local/metadata/benchmark/multicast/reserved ranges non-overridable, and add `harness mcp add maxcompute --vpc` for the documented VPC endpoint.

### Metadata
- Frequency: first_time
- Related Features: MCP OAuth, guided MCP configuration, SSRF protection

### Resolution
- **Resolved**: 2026-07-03T05:53:00Z
- **Notes**: Added an explicit per-server VPC mode, covered standard private-routable IPv4 and IPv6 ranges without a MaxCompute-specific CIDR list, retained non-overridable sensitive-range blocks, added the MaxCompute VPC CLI preset, and passed the full validation suite.

---

## [FEAT-20260703-003] maxcompute_local_mcp_preset

**Logged**: 2026-07-03T06:08:00Z
**Priority**: high
**Status**: resolved
**Area**: config

### Requested Capability
Configure the official local MaxCompute MCP server through the guided CLI so it can use a reachable regional VPC service endpoint.

### User Context
The Windows host cannot route to the Hangzhou Remote MCP VPC endpoint, but it can reach the Shanghai MaxCompute VPC service path. Running the MCP server locally over stdio avoids the unavailable remote gateway route.

### Complexity Estimate
medium

### Suggested Implementation
Add a `maxcompute-local` CLI preset that launches the official source checkout with `uv`, supports an optional external server config, and passes only explicitly allowlisted MaxCompute and Alibaba Cloud credential environment variables without persisting secrets.

### Metadata
- Frequency: first_time
- Related Features: guided MCP configuration, stdio MCP transport, workspace environment loading

### Resolution
- **Resolved**: 2026-07-03T06:16:00Z
- **Notes**: Added the `maxcompute-local` guided preset with source-directory validation, optional external server config, explicit environment allowlisting, Windows instructions for the Shanghai VPC endpoint, and full automated coverage.

---

## [FEAT-20260720-001] background_command_lifecycle

**Logged**: 2026-07-20T00:00:00+08:00
**Priority**: high
**Status**: resolved
**Area**: backend

### Requested Capability
Iteratively adopt the highest-value Grok Build runtime ideas, starting with observable and cancellable background commands.

### User Context
Long-running builds, tests, and development processes should not block the agent loop, but the product should remain focused and avoid parallel implementations or overlapping control paths.

### Complexity Estimate
medium

### Suggested Implementation
Extend the existing Bash and ShellExecutor path with one session-scoped background command manager and one control tool. Reuse the current sandbox, permission, cancellation, output bounding, and session logging mechanisms; do not add a second command executor, scheduler, or monitor subsystem.

### Metadata
- Frequency: first_time
- Related Features: Bash, cancellation, session events, sandbox

### Resolution
- **Resolved**: 2026-07-20T16:29:30+08:00
- **Notes**: Extended the existing Bash/ShellExecutor path with session-scoped background tasks, one BashTask control tool, bounded live output, durable lifecycle events, and session-exit cleanup. Build, lint, full tests, and coverage passed.

---

## [FEAT-20260720-002] session_display_title

**Logged**: 2026-07-20T17:00:00+08:00
**Priority**: medium
**Status**: resolved
**Area**: sessions

### Requested Capability
Improve session identification while keeping the session model focused and avoiding overlapping indexing or naming mechanisms.

### User Context
Opaque session IDs make lists and later recovery harder to navigate, but automatic naming, search indexing, and multiple aliases would add redundant behavior.

### Complexity Estimate
small

### Suggested Implementation
Store one optional, explicitly assigned title in existing session metadata, expose one `/rename <title>` command, and display that title in the existing session list.

### Metadata
- Frequency: first_time
- Related Features: session metadata, resume, inspect

### Resolution
- **Resolved**: 2026-07-20T17:00:00+08:00
- **Notes**: Added one normalized metadata title and one interactive rename command; no automatic naming, alias layer, or search index was introduced.

---
