# Ephemeral Fly.io Test Environments via Telegram

**Date:** 2026-06-29
**Status:** Approved (design)

## Summary

Add three Telegram bot commands that deploy the current session's workspace
project as a throwaway Fly.io app, return a live test URL, and tear it down on
demand:

| Command | Description |
|---|---|
| `/teststart [path] [port]` | Deploy a workspace project as an ephemeral Fly app; reply with its URL. |
| `/teststop` | Destroy the active test app and clear state. |
| `/teststatus` | Report whether a test app is active, with its URL and app name. |

The bot already has a `FLY_API_TOKEN` secret set on the Fly app. `flyctl` reads
this env var directly for auth.

## Decisions

- **What runs:** the project in the agent's workspace (the current chat
  session's `workingDirectory`), not a fixed image.
- **Build path:** bundle `flyctl` into the bot image; build on Fly's **remote
  builders** (`fly deploy --remote-only`) — the bot container has no Docker
  daemon.
- **Target dir:** optional `path` arg resolved within `WORKSPACE_DIR`; with no
  arg, default to the current session's `workingDirectory`.
- **Lifecycle:** a **separate** ephemeral app named `claudegram-test-<id>`,
  **one at a time** globally; teardown via `fly apps destroy`.
- **Dockerfile required:** the target project must contain a `Dockerfile`. This
  keeps the remote build deterministic and avoids the interactive `fly launch`
  scanner. If absent, `/teststart` replies asking the user to have the agent
  add one.
- **Default port:** `8080`, overridable per-invocation and via env.

## Architecture

### New: `src/fly/flyctl.ts`

Thin wrapper around the `flyctl` binary.

- Spawns `fly` with `FLY_API_TOKEN` injected via `env` (never as a CLI arg).
- Captures stdout/stderr; **scrubs the token** from any captured output before
  returning or logging it.
- Functions:
  - `deployApp(opts: { appName, dir, port, region, org, onProgress?: (line: string) => void }): Promise<{ url: string }>`
  - `destroyApp(appName: string): Promise<void>`
  - `appExists(appName: string): Promise<boolean>`
- All non-interactive: pass `--yes`/equivalent confirmation flags; no TTY
  prompts. (Exact flags verified during implementation against the bundled
  flyctl version.)

### New: `src/fly/test-env.ts`

Tracks the single active test app and persists it.

- State shape: `{ appName: string; url: string; targetDir: string; port: number; startedAt: number }`.
- Persisted to `$WORKSPACE_DIR/.claudegram/test-env.json` via the existing
  `src/utils/atomic-write.ts`, so `/teststop` and `/teststatus` survive a bot
  restart (relevant given the OOM-restart history).
- API: `getTestEnv(): TestEnv | null`, `setTestEnv(env: TestEnv): void`,
  `clearTestEnv(): void`. Loads from disk on first access.

### Modified: `src/config.ts`

Add to the env schema:

- `FLY_API_TOKEN: z.string().optional()`
- `FLY_TEST_ORG: z.string().default('personal')`
- `FLY_TEST_DEFAULT_PORT: z.string().default('8080').transform(Number)`
- `FLY_TEST_REGION: z.string().default('lax')`

### Modified: `src/bot/handlers/command.handler.ts`

Three handlers, following the existing `handleRestartBot` style (`replyMd`,
`esc`, MarkdownV2 escaping):

- `handleTestStart(ctx)`
- `handleTestStop(ctx)`
- `handleTestStatus(ctx)`

### Modified: `src/bot/bot.ts`

Register `/teststart`, `/teststop`, `/teststatus` (same pattern as existing
command registrations).

### Modified: `Dockerfile`

Install `flyctl` in the runtime stage (e.g. `curl -L https://fly.io/install.sh
| sh`, then place the binary on `PATH`). Done as root before dropping to the
`node` user.

### Modified: `docs/index.html` (mandatory per CLAUDE.md)

- One feature card, `data-category="session"`, icon 🧪, "Test Environments".
- Three command rows for `/teststart`, `/teststop`, `/teststatus`.

## `/teststart [path] [port]` flow

1. **Token check:** if `FLY_API_TOKEN` is unset → reply
   "Fly API token not configured. Set `FLY_API_TOKEN` via `fly secrets set`."
   and stop.
2. **Resolve target dir:** if a `path` arg is given, resolve it within
   `WORKSPACE_DIR` using `resolvePathWithinRoot` (rejects traversal/symlink
   escape); if it resolves to `null`, reply with an error. With no arg, use the
   current session's `workingDirectory`.
3. **Already-active guard:** if `getTestEnv()` returns an active app → reply
   with the existing URL, do not launch a second.
4. **Dockerfile check:** if the target dir has no `Dockerfile` → reply asking
   the user to have the agent add one, and stop.
5. **Resolve port:** second arg if numeric, else `FLY_TEST_DEFAULT_PORT`.
6. **Create app:** generate `appName = claudegram-test-<6-char-id>`; run
   `fly apps create <appName> -o <org>`.
7. **Write config:** if the target dir already has a `fly.toml`, reuse it but
   override the `app` name (and ensure an `[http_service].internal_port`); pass
   it via `fly deploy --config <path>`. Otherwise generate a minimal `fly.toml`
   in a temp path (not written into the user's repo) with the app name,
   `primary_region`, and an `[http_service]` block (`internal_port = <port>`,
   `force_https = true`, `auto_stop_machines`).
8. **Reply immediately:** "🚀 Deploying… ⏳".
9. **Deploy:** `fly deploy --app <appName> --remote-only` via the wrapper,
   streaming progress lines. Run async — must **not** block the per-session
   request queue. Overall timeout ~10 minutes.
10. **On success:** `setTestEnv(...)` and edit/follow-up with
    `https://<appName>.fly.dev`.
11. **On failure or timeout:** attempt `fly apps destroy <appName>`, clear any
    partial state, reply with a `sanitizeError`-scrubbed message.

## `/teststop` flow

1. `getTestEnv()`; if none → reply "No active test environment.".
2. `fly apps destroy <appName>` (non-interactive).
3. `clearTestEnv()` even if destroy errors (so local state never wedges);
   report success or a sanitized error.

## `/teststatus` flow

- `getTestEnv()`; reply with app name + URL + uptime if active, else
  "No active test environment.".

## Security / constraints

- `FLY_API_TOKEN` passed **only** via env, never as a CLI arg; explicitly
  redacted from all logs and replies in addition to `sanitizeError`.
- Path arg guarded with `resolvePathWithinRoot` from
  `src/utils/workspace-guard.ts`.
- Auth middleware already gates every command — no extra auth.
- One active test app globally; long deploy runs async.
- All new source is TypeScript, functional style, no `any`.

## Error cases

| Case | Response |
|---|---|
| `FLY_API_TOKEN` unset | "Fly API token not configured…" |
| Path arg escapes workspace | Rejected with an error reply |
| No `Dockerfile` in target | "Add a Dockerfile (ask the agent)…" |
| Test app already active | Reply with existing URL |
| `fly apps create` / deploy fails | Destroy partial app, sanitized error |
| Deploy timeout (~10 min) | Destroy app, timeout error |
| `/teststop` with no active app | "No active test environment." |
| Destroy network error | Clear local state anyway, report error |

## Out of scope (YAGNI)

- Multiple concurrent test apps.
- Auto-expiry / TTL of test apps (manual `/teststop`).
- Non-Dockerfile build detection (nixpacks/buildpacks).
- Streaming app logs into Telegram.
