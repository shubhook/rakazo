# Milo

Milo runs AI teammates on your own machine. Each bot keeps one conversation, its own memory and
routines, and a computer it can use for browsing, the terminal, and files. Bots run on the
[Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) you already have signed in.

Milo works in the browser, as an Electron desktop app, and as an Expo mobile app. It is in beta.

## Quick start

You need:

- Node.js 22.22.2+, 24.x, or 26+ (not 23 or 25)
- pnpm 9 (`corepack enable` picks up the pinned version)
- Docker Desktop, OrbStack, or Docker Engine, running
- Claude Code, signed in with `claude auth login`. You can skip this and sign in with ChatGPT or
  connect a model instead.

```bash
git clone https://github.com/shubhook/rakazo.git milo
cd milo
pnpm install
pnpm dev:setup      # writes .env, starts Postgres, runs migrations
pnpm sandbox:build  # once; builds the bot computer image
pnpm dev
```

Open http://127.0.0.1:5173, create an account, and create a bot.

| Service | Address |
| --- | --- |
| Web app | http://127.0.0.1:5173 |
| API | http://127.0.0.1:3100 |
| Sandbox supervisor | http://127.0.0.1:7091 |
| Postgres | 127.0.0.1:5433 |

Ctrl+C stops the app. Postgres keeps running in Docker: `pnpm compose:down` stops it and
`pnpm compose:reset` deletes its data.

If migrations fail with `P1000: Authentication failed`, your `.env` doesn't match the Postgres
volume. Every checkout on a machine, worktrees included, shares that volume, so copy `.env` from
the checkout that created it, or run `pnpm compose:reset` and `pnpm dev:setup` if the data is
disposable.

## Desktop and mobile

Both apps talk to the same API as the web app. With `pnpm dev` running:

```bash
pnpm --filter @milo/desktop dev
```

Choose **Existing instance** and enter `http://127.0.0.1:5173`.

For the mobile app, see [docs/mobile-release.md](./docs/mobile-release.md).

## Repository layout

```text
apps/web        web app (also hosted by the desktop app)
apps/desktop    Electron shell
apps/mobile     Expo app
apps/api        HTTP API
apps/worker     background jobs and bot runs
packages/       shared contracts, core logic, adapters, database, and UI
infra/          Docker Compose files and the bot computer image
docs/           self-hosting, runtime, and release guides
```

## Development

```bash
pnpm lint
pnpm check
pnpm test
```

Integration and end-to-end suites, and when to run them, are in
[CONTRIBUTING.md](./CONTRIBUTING.md).

## Documentation

- [Self-hosting](./docs/self-host.md)
- [Computer runtime and isolation](./docs/computer-runtime.md)
- [Desktop releases](./docs/desktop-release.md)
- [Mobile releases](./docs/mobile-release.md)

## Contributing

Read [CONTRIBUTING.md](./CONTRIBUTING.md) before opening a pull request. Report security issues
through [SECURITY.md](./SECURITY.md), not public issues.

## License

[Apache License 2.0](./LICENSE).
