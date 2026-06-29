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
