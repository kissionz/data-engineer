# Learnings

## [LRN-20260703-001] correction

**Logged**: 2026-07-03T04:24:40Z
**Priority**: high
**Status**: resolved
**Area**: config

### Summary
An RFC 6598 address returned for the MaxCompute MCP hostname can be expected when the user intentionally configured the VPC endpoint.

### Details
The initial diagnosis attributed `100.103.125.243` to proxy Fake-IP DNS. The user clarified that they replaced the public MaxCompute MCP URL with the documented VPC URL. In that case, internal address resolution is intentional, while Harness currently blocks it because MCP network safety only permits public addresses and explicit localhost.

### Suggested Action
Before diagnosing reserved-address DNS as proxy interference, confirm the exact configured MCP URL. Add an explicit, tightly scoped VPC network mode rather than weakening the global SSRF blocklist.

### Metadata
- Source: user_feedback
- Related Files: src/mcp/manager.ts, src/runtime/httpSafety.ts
- Tags: mcp, maxcompute, vpc, ssrf

---

## [LRN-20260703-002] correction

**Logged**: 2026-07-03T05:49:30Z
**Priority**: high
**Status**: resolved
**Area**: config

### Summary
MaxCompute VPC access must not be hardcoded to a single observed private CIDR.

### Details
The first VPC design proposed allowing only `100.64.0.0/10`, based on one DNS result. The user clarified that MaxCompute can use multiple VPC ranges. A usable preset should allow the standard private-routable address classes for one exact configured MCP hostname while retaining a non-overridable denylist for loopback, link-local/metadata, benchmark, multicast, and reserved ranges.

### Suggested Action
Model VPC access as an explicit per-server network mode rather than a MaxCompute CIDR constant. Keep exact host, protocol, and port binding as the primary scope boundary.

### Metadata
- Source: user_feedback
- Related Files: src/runtime/httpSafety.ts, src/mcp/manager.ts
- Tags: mcp, maxcompute, vpc, ssrf

---

## [LRN-20260720-001] best_practice

**Logged**: 2026-07-20T00:00:00+08:00
**Priority**: high
**Status**: resolved
**Area**: backend

### Summary
Runtime iteration should preserve one primary path per capability and reject feature redundancy.

### Details
The user explicitly required that Grok-inspired improvements be evaluated for overlap before implementation. New behavior should extend existing execution, cancellation, permission, session, and sandbox primitives rather than introduce multiple interchangeable backends or speculative configuration choices.

### Suggested Action
For each iteration, document the missing user outcome, reuse the narrowest existing abstraction, and defer adjacent features that do not directly serve that outcome.

### Metadata
- Source: user_feedback
- Related Files: src/runtime/commandExecutor.ts, src/runtime/shellExecutor.ts, src/tools/bash.ts
- Tags: simplicity, architecture, runtime, non-redundancy
- Pattern-Key: simplify.single_primary_path

---
