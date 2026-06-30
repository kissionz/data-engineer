## [ERR-20260628-001] apply_patch

**Logged**: 2026-06-28T13:39:19Z
**Priority**: low
**Status**: resolved
**Area**: tests

### Summary
An insertion patch used an outdated neighboring test as its context.

### Error
```
apply_patch verification failed: Failed to find expected lines in tests/openai.test.ts
```

### Context
- Attempted to insert a provider stop-reason regression test.
- The expected adjacent test was not immediately after the selected block.

### Suggested Fix
Locate the exact neighboring test before constructing an insertion patch.

### Metadata
- Reproducible: yes
- Related Files: tests/openai.test.ts
- Recurrence-Count: 2

### Resolution
- **Resolved**: 2026-06-28T13:39:19Z
- **Notes**: Located the actual insertion point before retrying.

---

## [ERR-20260630-002] git_stage_sandbox_permission

**Logged**: 2026-06-30T09:56:53Z
**Priority**: low
**Status**: resolved
**Area**: infra

### Summary
Staging failed because the workspace sandbox denied creation of `.git/index.lock`.

### Error
```
fatal: Unable to create '/Users/kissionz/Documents/data engineer/.git/index.lock': Operation not permitted
```

### Context
- `git add` was run after build and test validation.
- Source files were writable, but Git metadata writes required scoped escalation.

### Suggested Fix
Retry repository-mutating Git commands with the approved scoped Git prefix when the sandbox denies `.git` writes.

### Metadata
- Reproducible: yes
- Related Files: .git/index

### Resolution
- **Resolved**: 2026-06-30T09:56:53Z
- **Notes**: Retried `git add` with scoped escalation; staging succeeded.

---

## [ERR-20260629-002] ephemeral_subagent_contract

**Logged**: 2026-06-29T07:28:47Z
**Priority**: low
**Status**: resolved
**Area**: backend

### Summary
The first ephemeral Subagent contract depended on unsupported schema combinators, and a broad test edit wrapped one configured-role case with the wrong tool.

### Error
```
expected true to be false
Creating an ephemeral subagent requires an explicit request from the current user.
```

### Context
- The local tool validator did not previously enforce `oneOf`/`not`.
- A repeated constructor pattern caused an imprecise patch to alter an adjacent test.

### Suggested Fix
Use a separate basic-schema `EphemeralTask` tool for provider compatibility, retain strict runtime Zod validation, and anchor repeated-code patches to the test name.

### Metadata
- Reproducible: yes
- Related Files: src/tools/task.ts, src/tools/schemaValidator.ts, tests/task.test.ts

### Resolution
- **Resolved**: 2026-06-29T07:28:47Z
- **Notes**: Split configured and ephemeral tools, added only the basic numeric/array constraints used by that schema, corrected the targeted test, and passed directed regression tests.

---

## [ERR-20260630-001] explicit_request_sentence_split

**Logged**: 2026-06-30T07:05:23Z
**Priority**: low
**Status**: resolved
**Area**: backend

### Summary
The conservative Subagent authorization classifier omitted the ASCII period from sentence boundaries.

### Error
```
expected false to be true
```

### Context
- `Review the docs. Create a subagent to check tests` remained one segment.
- The meta-discussion guard correctly rejected that combined segment.

### Suggested Fix
Test every supported sentence boundary when authorization depends on sentence-local intent.

### Metadata
- Reproducible: yes
- Related Files: src/agent/loop.ts, tests/loop.test.ts

### Resolution
- **Resolved**: 2026-06-30T07:05:23Z
- **Notes**: The immediate split bug was fixed, then the ambiguous natural-language classifier was replaced entirely by the structured `/subagent <subtask>` prefix.

---

## [ERR-20260629-001] skill_context_wiring

**Logged**: 2026-06-29T02:24:24Z
**Priority**: low
**Status**: resolved
**Area**: backend

### Summary
Skill recommendation wiring referenced a loader outside its scope in TaskTool.

### Error
```
src/tools/task.ts(115,11): error TS2304: Cannot find name 'skills'.
```

### Context
- Added metadata-only skill recommendations to ContextBuilder.
- The main agent had a SkillLoader, but the subagent context referenced the helper-local loader.

### Suggested Fix
Create one SkillLoader in TaskTool.execute and pass it to both the tool registry and ContextBuilder.

### Metadata
- Reproducible: yes
- Related Files: src/tools/task.ts, src/agent/context.ts

### Resolution
- **Resolved**: 2026-06-29T02:24:24Z
- **Notes**: Shared the loader explicitly; build and 35 directed tests passed.

---

## [ERR-20260628-002] git_merge

**Logged**: 2026-06-28T13:41:00Z
**Priority**: low
**Status**: resolved
**Area**: infra

### Summary
An attempted fast-forward merge failed because `main` and the feature branch had diverged.

### Error
```
fatal: Not possible to fast-forward, aborting.
```

### Context
- Attempted `git merge --ff-only feature/hardening-improvements`.
- `main` contained commit `ba63842` after the shared merge base.

### Suggested Fix
Inspect the graph before choosing fast-forward-only, then use a normal merge when both histories must be preserved.

### Metadata
- Reproducible: yes
- Related Files: src/model/openai.ts

### Resolution
- **Resolved**: 2026-06-28T13:41:00Z
- **Notes**: Merged with the `ort` strategy; both branches were preserved without conflicts.

---
