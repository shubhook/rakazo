# Self-hosting Milo

The signed-in product is a long-running API, a Graphile Worker, Postgres, and a computer provider (Docker supervisor, E2B, Daytona, CreateOS, or Box). It is not a static site.

## Local (source checkout)

Same as the README quick start: `.env` from `.env.example`, Postgres via Compose, `pnpm sandbox:build`, `pnpm dev`, then [http://127.0.0.1:5173](http://127.0.0.1:5173) (or `http://localhost:5173` — both loopback hosts are trusted). Electron: `pnpm --filter @milo/desktop dev` while that stack is up, choosing **Existing instance** with that address. The desktop app's **This computer** option instead installs and runs the published images itself with Docker Compose (see [Published images](#published-images-no-checkout)), using port 45173 by default so it can run alongside `pnpm dev`. If that port is occupied, the app selects and remembers another loopback port. The managed API gets a Docker-assigned loopback port; all desktop traffic uses the web origin.

For source development in WSL, keep the checkout and `data` directory in the Linux filesystem (for example, `~/rakazo`), and run `pnpm dev` as your normal user. The host-run supervisor matches bot container UID/GID to that user. If Docker Desktop container IPs are unreachable, set `SANDBOX_CONTROL_VIA_LOOPBACK=true` in `.env`; this publishes the token-protected control service on a random loopback port. Leave this unset for the Compose-hosted supervisor.

Compose bot homes mount only their own subdirectory of the application volume using Docker volume semantics. Docker's internal volume paths are never used as host bind mounts.

## Published images (no checkout)

Pull Postgres and `ghcr.io/elie222/rakazo/app` into any empty folder. No clone or image build.
Requires Docker Engine 26+ (API 1.45+ for bot home volume subpaths), the Compose plugin, curl, and OpenSSL.

```bash
mkdir -p rakazo && cd rakazo &&
curl -fsSLO https://raw.githubusercontent.com/elie222/rakazo/main/infra/compose/install-images.sh &&
bash install-images.sh
```

The installer downloads `docker-compose.images.yml` and `.env.images.example`, creates `.env` with
random secrets, then pulls and starts the images. It preserves an existing `.env` when rerun. For
the installer secret list, non-reuse rules, and recovery, see
[Self-host secrets checklist](./self-host-secrets.md). To customize the public URL, image tag, or
optional providers before startup, run `bash install-images.sh --prepare-only`, edit `.env`, then
run `bash install-images.sh`. Flags may be combined in either order: `--prepare-only`, `--local`.

`SANDBOX_PROVIDER` defaults to `docker`. The images Compose file runs a sandbox supervisor
(from the app image, on the internal network only) and pulls `ghcr.io/elie222/rakazo/computer`.
Signup and local Docker computers work without an E2B account. Optional remote providers: set
`SANDBOX_PROVIDER` to `e2b`, `daytona`, `createos`, or `box` and add the matching API key. The published-images
Compose stack requires `SANDBOX_SUPERVISOR_TOKEN` for every provider; leave it empty and `compose up` fails closed.

Optional: set `OPENROUTER_API_KEY` or connect a model in the UI after signup.
Auto Review uses that LLM checker by default. To use TypeSafe Jev instead, set
`RAKAZO_AUTO_REVIEW_PROVIDER=jev` and `TYPESAFE_API_KEY`. Core still runs with neither.

The example defaults to `edge` (main builds). Every publish is multi-arch (`amd64` + `arm64`), so
arm64 hosts need no special tag. Do not assume `latest` is present until a stable release exists.

Open [http://127.0.0.1:5173](http://127.0.0.1:5173). The first registered user becomes the
deployment owner. Put TLS in front of `:5173` for a public host and set the three public origins to
that HTTPS URL.

Images Compose binds web to loopback (`127.0.0.1:5173`). Terminate TLS on the host and proxy
there. Vite preview same-origin-proxies `/api` and `/rpc`, so do not expose `:3100`. Set
`BETTER_AUTH_URL`, `WEB_ORIGIN`, and `API_URL` to that same HTTPS origin, and set
`RAKAZO_HOST` to its hostname (for example, `app.example.com`).

```Caddyfile
app.example.com {
	reverse_proxy 127.0.0.1:5173
}
```

Open **Agent computer** on a bot, or send a message that uses the desktop, to see
the local Docker computer.

### Restricted networks / mirror downloads

If the installer, Compose downloads, or image pulls are blocked, use the
[restricted-network guide](./self-host-restricted-network.md) for mirror settings and local files.

### Bot computer resource ceilings

Each Docker computer runs Xvfb, a window manager and a full Chromium driven by an agent that
decides for itself what to open, so it is capped. These defaults provide a starting point for the
Docker computer topology:

| Variable | Default | Accepts |
| --- | --- | --- |
| `RAKAZO_COMPUTER_MEMORY` | `2g` | `2g`, `1536m`, a byte count. Minimum `6m`, Docker's own floor. Also caps swap, so the ceiling holds. |
| `RAKAZO_COMPUTER_CPUS` | `2` | Whole or fractional cores, e.g. `1.5` |
| `RAKAZO_COMPUTER_PIDS_LIMIT` | `2048` | A positive integer |

Set any of them to `0`, `none` or `unlimited` to remove that ceiling. A malformed value fails the
supervisor at startup naming the variable, rather than surfacing later as a failed bot.

### Restricted computer egress

Docker computers have full outbound access by default — the public internet plus the Docker
host's own addresses, the LAN, and link-local cloud metadata endpoints such as
`169.254.169.254`. On a cloud VM that last path is instance-credential theft for anything a
bot runs. Restricted mode keeps public internet egress (browsing, DNS, apt, git over SSH)
while dropping computer traffic to every non-public destination and to the host itself.

It takes two parts, both opt-in:

1. Set `SANDBOX_COMPUTER_EGRESS=restricted` in `.env` and recreate the supervisor. Each
   computer network then gets a deterministic host bridge name (`rakazo-c…`) instead of a
   generic `br-*`.
2. Apply the host ruleset once per Docker host:

   ```bash
   sudo bash infra/compose/restrict-computer-egress.sh
   ```

   On a no-checkout install, download it first:
   `curl -fsSLO https://raw.githubusercontent.com/elie222/rakazo/main/infra/compose/restrict-computer-egress.sh`.
   The script drops forwarded traffic from `rakazo-c*` bridges to all non-public IPv4/IPv6
   destinations via the `DOCKER-USER` chain, adds an `INPUT` drop so computers cannot open
   connections to the host (established replies to host-initiated control and screen
   connections still flow), and installs a systemd oneshot so the rules return after a
   reboot. `--print` shows the exact rules without changing anything; `--remove` uninstalls.

Screen streaming is unaffected: the supervisor and web proxy join each computer's bridge,
and the ruleset exempts traffic whose in- and out-interface are both `rakazo-c*` before
any drop (that exemption is load-bearing on hosts where `br_netfilter` feeds bridged
frames through `FORWARD`). Rules match interface names rather than subnets, so computer
create/delete cycles need no firewall maintenance; deleting a computer removes its
traffic from the match and nothing else. A computer provisioned before the flag flips
is replaced on its next provision — resuming it on an unnamed bridge would bypass the
restriction.

To disable restricted egress, set `SANDBOX_COMPUTER_EGRESS=open`, recreate the
supervisor, and run `sudo bash infra/compose/restrict-computer-egress.sh --remove`.
The flag alone does not uninstall the host rules, which keep matching the still-named
`rakazo-c*` bridges until removed.

Do not enable restricted egress if computers must reach LAN services, an internal proxy,
or endpoints bound to the host. Requires Linux Docker Engine with the iptables backend —
Docker Desktop, rootless Docker, and `firewall-backend: nftables` are unsupported. The
`SANDBOX_SCREEN_NETWORK=internal` topology shares one network instead of per-bot bridges,
so the mode does not apply there.

## Docker Compose (single machine)

1. Copy `.env.example` to `.env` and set `POSTGRES_PASSWORD` (`openssl rand -hex 16`), plus `BETTER_AUTH_SECRET`, `ENCRYPTION_KEY`, and `SCREEN_PROXY_SECRET` to independent long random strings (32+ characters; 64 hex for `ENCRYPTION_KEY`). Docker sandboxes also need a dedicated `SANDBOX_SUPERVISOR_TOKEN`. Keep existing `ENCRYPTION_KEY` values so stored credentials stay decryptable.
2. Set `OPENROUTER_API_KEY` (and `COMPOSIO_API_KEY` if you want Plugins).
3. Build the computer image: `pnpm sandbox:build` (Compose also builds it via the `computer` service).
4. `docker compose --env-file .env -f infra/compose/docker-compose.yml up --build`
5. Open the web origin (`http://127.0.0.1:5173` by default). The first registered user becomes the deployment owner.

On Windows, if an older clone with `core.autocrlf=true` leaves the computer pane hung on boot (`bash\r` in sandbox logs): from a clean worktree, set `git config core.autocrlf false`, run `git add --renormalize . && git checkout -- .`, then rebuild with `pnpm sandbox:build`.

Compose runs Postgres, the sandbox supervisor (Docker socket), API, worker, and a Vite preview of the web app. Bot computers are sibling containers (`rakazo/computer:local`) on separate per-bot networks; only the supervisor and screen proxy join each one. The API process does not get an unrestricted Docker socket; the supervisor owns the lifecycle.

Postgres stays on the Compose network only (not published on the host), matching the images
compose. Credentials come from `.env` (`POSTGRES_PASSWORD` is required). Prefer a URI-safe value
(`openssl rand -hex 16`); characters such as `@ : / ? # %` break the interpolated `DATABASE_URL`
inside Compose. Official Postgres images set user, password, and database only on first volume
init, so an existing `pgdata` volume keeps its original identity: keep those values in `.env`, or
change them in place with `ALTER ROLE` / rename. Recreate the volume only after a backup (or when
the data is disposable); `docker compose down -v` deletes all Postgres state. For host-side clients
(`pnpm db:migrate`, GUI tools),
add `infra/compose/docker-compose.postgres-host.yml` so Postgres is published on loopback
`127.0.0.1:5433`, or use
`docker compose --env-file .env -f infra/compose/docker-compose.yml exec postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"'`.
Do not publish Postgres on a public interface.

The Docker supervisor is not published as its own image and is not exposed on the host. It runs from
the app image, stays on the internal Compose network, and holds the Docker socket because access to
it is equivalent to control of the Docker host. Docker sandboxes require `SANDBOX_SUPERVISOR_TOKEN`
(API, worker, supervisor). `SCREEN_PROXY_SECRET` signs browser-screen capabilities (API and web
proxy). Keep both distinct from `BETTER_AUTH_SECRET`.

New credentials use versioned AES-GCM with per-record salt and row-bound AAD. Legacy ciphertext stays readable.

On a VPS, put TLS in front of `:5173` (or serve the web build behind your proxy) and set:

```env
BETTER_AUTH_URL=https://app.example.com
WEB_ORIGIN=https://app.example.com
API_URL=https://app.example.com
```

Cookies and CORS follow those origins. `SIGNUPS_ENABLED` seeds whether registration is open
when the API starts for the first time and is not reapplied on restart. A non-empty
`SIGNUP_ALLOWLIST` is applied on every API start, replacing the allowlist stored for the deployment.
Leave it empty to keep that stored list.

With a nonempty signup allowlist and SMTP configured, users—including existing accounts—must
verify their email to sign in. On a fresh instance with no SMTP, the first allowlisted account
can register without verification. That signup does not prove mailbox ownership, so create the
account before exposing the service. Further accounts still need SMTP.

For a public deployment, configure SMTP and an allowlist before the API's first start.
Keep an installation without email on a trusted local network.

### Verification and password recovery email

Password changes for signed-in users require no email configuration. Forgotten-password recovery
appears on sign-in only when a transactional email provider is available. Milo uses a
provider-neutral contract and ships an SMTP adapter, so Amazon SES, Resend, and self-hosted SMTP
servers use the same configuration:

```env
SMTP_URL=smtps://smtp-user:replace-with-password@smtp.example.com:465
EMAIL_FROM=Milo <no-reply@example.com>
```

For Resend, use `smtp.resend.com`, username `resend`, and an API key as the password. For Amazon
SES, use the regional SMTP endpoint and SES SMTP credentials; these are different from ordinary AWS
access keys. Verify the sender/domain with the provider before testing delivery. Keep credentials in
`.env`, never in tracked files. `smtps://` uses implicit TLS; `smtp://` is also supported but requires
STARTTLS. Milo rejects configuration that disables TLS or certificate verification.

Local source development can use the offline email emulator instead. It captures email without
contacting a provider:

```env
EMAIL_EMULATOR=true
```

The emulator is forcibly disabled when `NODE_ENV=production` and requires the API to bind to a
loopback host. In `NODE_ENV=development`, captured messages are available from
`http://127.0.0.1:3100/api/dev/emails` with cache disabled; the API logs only delivery
metadata, never reset tokens. The inbox route is not registered in test, staging, or production.

### Logging

Backend services write structured logs to stdout. `LOG_LEVEL` is `debug`, `info`, `warn`, `error`,
or `off` (default `info`). Production defaults to `LOG_FORMAT=json`; development defaults to pretty
unless you set `json` or `pretty`.

Axiom is optional. Set both `AXIOM_TOKEN` and `AXIOM_DATASET` for ingest to one shared dataset.
Services set `service.name` (`rakazo-api`, `rakazo-worker`, `rakazo-sandbox-supervisor`,
`rakazo-updater`). A partial Axiom config logs a one-time warning and stays off. `AXIOM_EDGE` is a
regional hostname; `AXIOM_EDGE_URL` must be https and wins when both are set.

Compose passes these into the API, worker, supervisor, and updater. Computer containers and updater
child commands do not receive them.

Optional:

```env
SIGNUPS_ENABLED=true
SIGNUP_ALLOWLIST=you@example.com,@company.com
SANDBOX_PROVIDER=docker   # or none, e2b, daytona, createos, box. Keep fake only for pnpm test.
AGENT_RUNTIME=claude-code # default (below), or pi. Keep scripted only for pnpm test.
WAKEUP_DRIVER=graphile
SANDBOX_IDLE_MS=600000    # pause the bot computer after 10 minutes idle
SANDBOX_COMMAND_TIMEOUT_MS=300000 # stop a shell command after 5 minutes
MAX_TOOL_CALLS_PER_TURN=  # optional Pi turn tool-call fuse; unset/0 = unlimited
E2B_API_KEY=              # when SANDBOX_PROVIDER=e2b
DAYTONA_API_KEY=          # when SANDBOX_PROVIDER=daytona
CREATEOS_SANDBOX_API_KEY= # when SANDBOX_PROVIDER=createos
BOX_API_KEY=              # when SANDBOX_PROVIDER=box
```

To use an operator-controlled OpenAI-compatible server such as Ollama, LM Studio, llama.cpp, or
MLX, list its model IDs and an endpoint that both the API and worker processes can reach:

```env
RAKAZO_LOCAL_MODELS=qwen3:4b,llama3.1:8b,qwen3-vl
RAKAZO_LOCAL_MODELS_URL=http://127.0.0.1:11434/v1
RAKAZO_LOCAL_CONTEXT_WINDOW=32768
RAKAZO_LOCAL_MAX_TOKENS=4096
# Optional: model ids on this endpoint that accept images (screenshot computer tools).
RAKAZO_LOCAL_VISION_MODELS=qwen3-vl
```

The loopback default is suitable when running Milo from a source checkout. From containers,
prefer a stable LAN RFC1918 address (not Compose service DNS alone). On Docker Desktop,
`host.docker.internal` also works.
On Docker Desktop, a bot computer shell can often reach services bound to host `127.0.0.1`
through that same hostname. Do not run sensitive unauthenticated services on loopback while
bots run, or firewall / block that path. Linux does not get `host.docker.internal` the same
way by default.
Only configure an endpoint you control: prompts, attachments, and tool results sent to that model
leave Milo through this URL. Leave `RAKAZO_LOCAL_MODELS` blank to disable the provider.

Each user can also connect their own OpenAI-compatible endpoint from **Connect a model** /
**Settings → Models** on web and mobile. Choose **OpenAI-compatible**, enter the server base URL
(for example `http://127.0.0.1:8000/v1`), the exact model id, and an optional API key.
Public hosts and ordinary hostnames need `RAKAZO_OPENAI_COMPAT_ALLOW_PUBLIC=1` and HTTPS.
Literal private IP, loopback, and `host.docker.internal` targets do not. If that endpoint's model
accepts images, enable **Supports images** under **Advanced** when connecting so attachments and
screenshot computer tools stay available. Existing connections default to disabled. For centrally
managed endpoints, the deployment-wide fallback remains
`RAKAZO_OPENAI_COMPATIBLE_VISION_MODELS=gpt4o-vision,llava`.

Remote MCP servers and installed API / GraphQL connectors default to public HTTPS. The deployment
owner can attach one on localhost, the same LAN, or a Docker network. Set
`MCP_ALLOW_PRIVATE_ENDPOINT=true` on the API and worker to allow these for every user. Cloud
metadata addresses stay blocked. Leave the flag unset on public installs.

For servers that accept standard `reasoning_effort`, enable **Supports thinking** under
**Advanced** when connecting. The setting is saved on the connection (no env var or restart).
Existing connections default to disabled. Reconnect former Qwen-list or deployment-local models
via **Settings → Models** and turn it on; the old environment list is no longer read.

Enabled connections default to medium thinking. Web and desktop expose **Thinking** in a bot's
advanced settings; mobile inherits the same backend policy. Milo sends standard
`reasoning_effort` (`minimal`, `low`, `medium`, `high`, or `none` when off); the server owns
model-specific translation. Leave **Supports thinking** off when the server lacks standard effort
support. Existing token limits still apply; effort is not a separate reasoning-token budget.

Do not commit `.env`. Never put `COMPOSIO_API_KEY`, OpenRouter keys, or provider tokens in git, logs, or chat.

Optional messaging platforms (iMessage, Slack, WhatsApp, Telegram, Feishu/Lark) mount when their env credentials are set — see `.env.example`. Point a Feishu/Lark bot event subscription at `/api/v1/messaging/webhook/lark` (webhook/HTTP inbound only; do not enable long connection). Groups stay iMessage-only.

## Choosing a computer provider

The Electron desktop app is a client of the same API. Docker and E2B still apply. On first launch, Electron asks the deployment owner whether bots should keep using Docker or run on this Mac as you. `SANDBOX_PROVIDER=desktop` is a separate, explicit provider that always runs commands on the service host.

- **Published images** (`docker-compose.images.yml`) default to `SANDBOX_PROVIDER=docker` with a
  local supervisor and published `ghcr.io/elie222/rakazo/computer` image. No E2B account required.
  Optional: set `e2b`, `daytona`, `createos`, or `box` plus the matching API key for remote computers.
- **Docker** is the quick-start default for published images and for a source checkout / full local
  Compose stack. Workspace bots share a persistent Team Computer by default; Private computers are
  optional. Keep the supervisor private, as the included Compose files do.
- **E2B** runs bot computers away from the Milo host and is a good choice for public or multi-user
  production deployments. Milo checkpoints the portable workspace and browser-profile directory to
  `DATA_DIR`; the E2B disk is a runtime cache, not the durable source of truth.
- **Daytona** provides the same remote-computer contract through Daytona sandboxes. Configure
  `DAYTONA_API_KEY` and optionally `DAYTONA_API_URL` / `DAYTONA_TARGET` / `DAYTONA_SNAPSHOT`.
- **CreateOS** provides the same remote-computer contract through CreateOS desktop sandboxes.
  Configure `CREATEOS_SANDBOX_API_KEY` and optionally `CREATEOS_SANDBOX_BASE_URL`,
  `CREATEOS_SANDBOX_SHAPE`, or `CREATEOS_SANDBOX_ROOTFS`. Milo defaults to
  `https://api.sb.createos.sh`, `s-2vcpu-2gb`, and `desktop:1`.
- **Box by ASCII** provides a managed Linux desktop through `BOX_API_KEY` and optionally
  `BOX_API_URL`. Milo always creates or resumes boxes with `noEnv: true`, keeps the portable
  workspace under `/home/user/rakazo-home`, and refreshes a two-hour TTL. Box uses the shared Linux
  desktop runtime and protected port routes for concurrent bot desktops. Each bot has its own
  persistent Chrome profile; logins are not shared between bots.
- **Desktop provider** / **This Mac** runs commands on the API/worker host. Docker stays the default.
  The Electron app asks once; if you choose This Mac, bots can use working directories under your home
  folder. Do not enable it on a public or shared service. macOS does not show its own permission
  dialog for this.
- **Fake** is only an emulator for verification.
- **None** boots the product without a computer host (fallback when Docker/supervisor is not
  configured, or when a remote provider is selected without its API key).

For provider configuration and health checks, see the [provider setup guide](./self-host-sandbox-providers.md).

## Claude Code runtime

This is the only way to run Milo on a Claude Pro or Max subscription. Anthropic only allows those
subscriptions inside Claude Code, so Milo has no Claude sign-in of its own. It refuses
subscription tokens (`sk-ant-oat…`) pasted as an Anthropic key, and Claude sign-ins saved by
older versions stop working. An Anthropic API key still works on either runtime.

Claude Code is the default runtime (`AGENT_RUNTIME=claude-code`). Bots run through the Claude Code
CLI installed on the worker's machine, using that CLI's own sign-in. Milo never reads or stores
the Claude credential. Install the CLI and run `claude auth login` as the user the worker runs as;
set `CLAUDE_CONFIG_DIR` in the worker environment to use a different Claude login. First-run
onboarding shows the deployment owner whether the CLI is installed and signed in, and the desktop
app can run both steps for a server on the same computer. The worker also logs the CLI state at
startup. The API checks the CLI on its own machine, so run the API and worker on the same machine.

Every bot runs on Claude Code (`sonnet`) unless its owner signed in with ChatGPT (below), so the
apps hide model sign-in and the model pickers.
Models connected before switching runtimes are kept but not used. Pi still serves a model the
deployment configures for side work, such as an Auto Review checker. The CLI's own tools, settings, hooks, and MCP servers are disabled for bot runs, so
shell, files, browser, and approvals still go through Milo. The published images do not include
the CLI, so use a source checkout where the worker runs on your machine. Use this only on a
personal deployment: everyone on the deployment would share your Claude subscription.

## Sign in with ChatGPT

People can sign in to Milo with their ChatGPT account. The same sign-in can let Milo run that
person's bots on their ChatGPT plan through OpenAI's Responses API, in place of Claude Code. Milo
never sees ChatGPT conversations. Nothing needs configuring: Milo registers itself with OpenAI the
first time someone signs in, and OpenAI lists it under the person's ChatGPT settings.

OpenAI only returns the sign-in to `http://127.0.0.1`, so the option appears only when
`WEB_ORIGIN` is a loopback address. When the API runs directly on that computer it catches the
redirect itself. Inside Docker, only the desktop app can catch it, so a browser does not show the
option. A server on another computer, and the mobile app, never show it. OpenAI offers plan usage
to open-source and locally hosted apps; a hosted deployment needs OpenAI's approval first.

A new ChatGPT account follows the same registration rules as email sign-up. An account that
already exists with the same email keeps signing in with its password; the deployment owner can
connect ChatGPT from the first-run agent step instead of Claude Code.

## Backup

```bash
./scripts/backup.sh
```

This dumps Postgres (`pg_dump`) and archives `data/` into `backups/<stamp>/`. A missing
`data/` produces an empty archive; database or archive errors fail the backup. Discard the
output directory of any failed run.

## Restore

For backups created by `scripts/backup.sh`, use an empty `rakazo` database in the development
Compose stack, with application services stopped. The SQL import runs in one transaction and
stops on the first error, including conflicts with existing tables. Files are restored and
application services started only after the import succeeds.

```bash
./scripts/restore.sh backups/<stamp>
```

## Upgrade

Source checkouts upgrade by pulling, rebuild with
`GIT_SHA=$(git rev-parse HEAD)`, run `pnpm --filter @milo/db migrate`, then restart API and worker.
Product contracts stay compatible across cloud and self-hosted.

### Space privacy-boundary migration

Before upgrading across migration `20260830200000_space_scope_names_and_user_credentials`, check
that every existing model and voice credential still belongs to a member of its Space. This query
uses the pre-migration `workspaceId` column name and must return no rows:

```sql
SELECT 'model' AS credential_type, credential."id", credential."userId",
       credential."workspaceId" AS "spaceId"
FROM "user_model_credentials" AS credential
LEFT JOIN "space_members" AS membership
  ON membership."spaceId" = credential."workspaceId"
 AND membership."userId" = credential."userId"
WHERE membership."id" IS NULL
UNION ALL
SELECT 'voice', credential."id", credential."userId", credential."workspaceId"
FROM "user_voice_credentials" AS credential
LEFT JOIN "space_members" AS membership
  ON membership."spaceId" = credential."workspaceId"
 AND membership."userId" = credential."userId"
WHERE membership."id" IS NULL;
```

The migration renames columns used by the API and worker and is therefore a coordinated cutover,
not an online rolling migration. Stop the old API and worker, apply the migration, and start the new
versions together. Its lock waits are bounded so contention fails the migration instead of leaving
application traffic queued indefinitely.

### Published images and tags

`.github/workflows/publish-server-image.yml` publishes to `ghcr.io/<owner>/<repo>/…`, derived from
`${{ github.repository }}` rather than hardcoded, so a fork's CI fills the fork's own namespace. For
this repository that is:

| Image | Contents |
| --- | --- |
| `ghcr.io/elie222/rakazo/app` | api, worker, web, and sandbox supervisor — one image, multiple commands |
| `ghcr.io/elie222/rakazo/computer` | Linux desktop used as each bot computer |
| `ghcr.io/elie222/rakazo/updater` | the updater sidecar, plus the Docker CLI |

`infra/compose/docker-compose.images.yml` is the no-checkout path for those app and computer tags
plus Postgres. The supervisor runs from the app image on the internal network only (not a separate
published supervisor image, and no host port).

If you deploy from your own fork, set `RAKAZO_IMAGE` and `RAKAZO_UPDATER_IMAGE` to your namespace —
your CI cannot publish into someone else's.

| Tag | Published on | Moves? |
| --- | --- | --- |
| `local` | nothing — built locally by `up --build` | rebuilt in place |
| `local-<full-commit>` | nothing — built on the server by a fork update | never |
| `vX.Y.Z`, `vX.Y` | release tags | conventionally no / on patch releases |
| `latest` | stable `vX.Y.Z` tags only (not prereleases) | yes, to the newest stable release |
| `sha-<full-commit>` | every push and manual run | source-addressed; used by the updater sidecar |
| `edge` | pushes to main | yes, to the newest main build |

Every publish, including `edge` from main merges, is multi-arch (`amd64` + `arm64`): each
architecture builds natively on its own runner and one manifest is assembled per image. Until a
stable `vX.Y.Z` has been published, GHCR may only have `edge` and `sha-*` tags; do not pin
`latest` unless that tag exists in the registry.

Building the images yourself does not need QEMU. `docker compose up --build` builds for the host's
own architecture, and a fork publishing multi-arch images should do what `publish-server-image.yml`
does: build each architecture on a native runner (GitHub Actions provides `ubuntu-24.04-arm` for
public repositories) and merge the digests into one manifest. QEMU emulation
(`docker/setup-qemu-action`, `binfmt`) still works if you have no native arm64 machine, but it is
many times slower, hours rather than minutes for the `computer` image.

The updater resolves the newest stable `vX.Y.Z` source tag but deploys its `sha-<full-commit>` image,
not `latest` or a moving minor tag. A registry tag is not an OCI digest and GHCR package writers can
replace it, so the trust boundary remains this repository's publishing credentials. The workflow
reduces that boundary by using SHA-pinned actions, read-only pull-request jobs, digest-pinned base
images, SBOM/provenance output, and a GitHub build attestation. Operators who require registry-level
content addressing can pin `RAKAZO_IMAGE` outside the automatic updater to a verified digest.

Rollback never contacts the registry: it redeploys the previous tag from the local Docker cache,
so a later tag move cannot change rollback content. Do not prune the previous application image
until the next update has been accepted. If it is missing, rollback fails closed instead of pulling
new content under an old tag.

To populate the registry the first time, run the workflow manually (`workflow_dispatch`) or push a
`v*` tag. A manual run produces `sha-<full-commit>`; only a stable `vX.Y.Z` tag (no prerelease
suffix) produces `latest`, and any `v*` tag produces semver tags. The updater ignores prereleases
and refuses the official path until a stable `vX.Y.Z` exists.

## Other deployment layouts

API and worker need always-on processes; serverless request handlers are not sufficient. Use a
Node.js version supported by the root `package.json`, Postgres 16 and a persistent `DATA_DIR` volume shared by API and worker, with encrypted off-host
backups. The current home store uses a local filesystem, so deployments on separate hosts need a
shared filesystem; an object-storage adapter is not available yet.

Use the same HTTPS origin for the web app, `/api`, and `/rpc`. Preserve the authenticated screen
proxy routes. Choose a [computer provider](#choosing-a-computer-provider) appropriate to the
service's trust boundary. `SIGNUPS_ENABLED` applies on the API's first start. A non-empty
`SIGNUP_ALLOWLIST` applies on every API start.

## Connect mobile clients

The iOS and Android app can also point at a self-hosted origin at runtime. On the sign-in screen, tap **Use a custom server** and enter the same HTTPS origin as `WEB_ORIGIN` (for example `https://app.example.com`). Store builds still default to `EXPO_PUBLIC_API_URL`; the in-app setting is an override for people running their own API. Changing the server signs the device out of any previous session.
