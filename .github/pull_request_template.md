## What changed

<!-- What this pull request does and why. Link the issue: Fixes #123 -->

## How it was tested

<!-- Tests added, and anything checked by hand (endpoint type, Docker version). -->

## Checklist

- [ ] Tests cover the change, and `npx tsc --noEmit` and `npm test` pass
- [ ] Schema changes come with a migration (`npm run db:migration -- --name …`)
- [ ] New API routes are in `src/lib/openapi.ts`
- [ ] A line under **Unreleased** in `CHANGELOG.md` if users will notice
