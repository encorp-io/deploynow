# Contributing to DeployNow

Thanks for helping. Bug reports, docs fixes and pull requests are all welcome.

- **Bugs and ideas:** open an [issue](https://github.com/encorp-io/deploynow/issues/new/choose).
  For a big change, open an issue first so we can agree on the approach.
- **Security problems:** don't open an issue. See [SECURITY.md](SECURITY.md).
- **Questions:** use [Discussions](https://github.com/encorp-io/deploynow/discussions).

## Development setup

You need Node.js 22, Docker (for the integration tests) and Go 1.24 (for the agent).

```bash
git clone https://github.com/encorp-io/deploynow.git && cd deploynow
npm install
cp .env.example .env              # set AUTH_SECRET and ADMIN_PASSWORD
npm run db:migrate                # creates or upgrades the SQLite database
npm run db:seed                   # creates the owner account from .env
npm run dev                       # http://localhost:3000
```

With a local Docker socket the `local` endpoint appears on first start.

## Tests

```bash
npx tsc --noEmit                  # type check
npm test                          # unit and API tests; integration tests run when Docker is available
cd agent && go test ./...         # the agent
```

Add tests with your change. API routes have tests in `tests/api/`, libraries in
`tests/lib/`, and anything that needs real Docker in `tests/integration/`.

## Changing the database

The schema is `prisma/schema.prisma`, and every change needs a migration so that
existing installs upgrade:

```bash
# edit prisma/schema.prisma, then
npm run db:migration -- --name add-something
```

Check the SQL in `prisma/migrations/<timestamp>_add-something/`. Migrations must
not lose data: add columns with defaults, and copy data before you drop or rename
anything. CI fails if the migrations and the schema disagree.

## Code style

- TypeScript, strict. Route handlers start with `requireUser(permission, scope)`
  and write an `audit()` entry for anything that changes state.
- Destructive actions call `requireStepUp()`.
- New REST routes go into `src/lib/openapi.ts` (a test checks this).
- Keep UI text short and plain.

## Pull requests

- One topic per pull request, with a description of what changed and how you tested it.
- Add a line under **Unreleased** in [CHANGELOG.md](CHANGELOG.md) for anything users notice.
- CI (type check, tests, agent, build) must pass.

By contributing you agree that your contribution is licensed under the
[MIT License](LICENSE), and you follow our [Code of Conduct](CODE_OF_CONDUCT.md).
