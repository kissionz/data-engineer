---
name: typescript-testing
description: Test and verify TypeScript changes with the smallest useful scope.
---

# TypeScript Testing

Run targeted tests first when a focused test file exists, then run the full
suite and TypeScript build before declaring the task complete.

Prefer repository scripts over globally installed commands. For this project:

```bash
npm test -- --run
npm run build
```

Treat test output as evidence. Do not claim a passing result from an earlier
run made before the latest code changes.
