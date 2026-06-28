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
