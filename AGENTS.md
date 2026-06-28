# Project Collaboration Instructions

## Git workflow

- Work directly on `main` unless the user explicitly requests a separate branch.
- After a requested code change, run `npm run build` and `npm test -- --run`.
- If validation passes, commit the scoped changes and push `main` to `origin`.
- If validation fails, do not push; report the failure and keep the work local until fixed.
