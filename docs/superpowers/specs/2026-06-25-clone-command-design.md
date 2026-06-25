# `/clone` command — design

## Purpose

Add a Telegram command that clones a git repository into the workspace and
switches the session to it, so a user can start working on an existing repo
from their phone without first creating an empty project and pasting files in.

It is the repository-aware sibling of `/newproject` (which creates an empty
project directory).

## Command

```
/clone <git-url> [name]
```

- `<git-url>` — required. Must be an `https://` URL.
- `[name]` — optional project directory name. If omitted, derived from the
  URL's last path segment with any trailing `.git` removed
  (`https://github.com/acme/foo.git` → `foo`).

## Behavior

Mirrors `handleNewProject`:

1. Validate `name` against `^[a-zA-Z0-9_-]+$` (reject otherwise).
2. Compute `projectPath = path.join(config.WORKSPACE_DIR, name)`.
3. If `projectPath` already exists → error, suggest `/project <name>`.
4. `git clone` the repo into `projectPath`.
5. On success: `sessionManager.setWorkingDirectory(sessionKey, projectPath)`,
   `clearConversation(sessionKey)`, reply with success + `projectStatusSuffix`.
6. On failure: remove the partial directory and reply with a sanitized error.

While the clone runs (can take seconds), send a "⏳ Cloning…" status reply and
edit/append the result.

## Authentication (private repos)

- Add optional `GITHUB_TOKEN` to `config.ts`.
- Only `https://` URLs are accepted. SSH (`git@…`), `git://`, `file://`, and
  any non-https scheme are rejected with a clear message.
- When the host is `github.com` **and** `GITHUB_TOKEN` is set, authenticate
  **without persisting the token to disk**:
  - Use `git -c http.extraHeader="AUTHORIZATION: basic <base64('x-access-token:'+token)>" clone <url> <dir>`.
  - Do **not** bake `token@github.com` into the URL — that writes the token
    into `projectPath/.git/config` on the persistent volume.
- Non-github hosts (and github when no token is set) clone unauthenticated
  (public repos only).

## Safety

- **Token never leaves the process:** never logged, never included in any
  Telegram reply. Clone stderr is passed through a sanitizer that strips the
  token value (and the `AUTHORIZATION:` header) before being shown to the user.
- **SSRF / scheme guard:** reject non-`https` schemes and private/localhost
  hosts, consistent with the repo's existing `download.ts` SSRF guard and the
  `ALLOW_PRIVATE_NETWORK_URLS` flag.
- **Clean failure:** on any clone error, `rm -rf` the partial `projectPath` so
  a retry starts clean. Never delete a pre-existing directory (step 3 already
  guarantees the path did not exist).
- **No shell injection:** invoke git via `execFile`/`spawn` with an argv array
  (not a shell string); the URL and path are arguments, never interpolated into
  a shell command.

## Files touched

| File | Change |
|------|--------|
| `src/config.ts` | Add optional `GITHUB_TOKEN: z.string().optional()`. |
| `src/bot/handlers/command.handler.ts` | Add `handleClone` next to `handleNewProject`; add a small `git clone` helper (argv-based, token via `http.extraHeader`, stderr sanitizer). |
| `src/bot/bot.ts` | Register `bot.command('clone', handleClone)`; add `/clone` to the command menu list. |
| `src/bot/handlers/command.handler.ts` (help text) | Add `/clone` to `handleStart` welcome and `handleCommands` listing. |
| `.env.example` | Document `GITHUB_TOKEN` (optional, for private clones). |

## Out of scope (YAGNI)

- SSH-key auth.
- Non-GitHub private hosts (GitLab/Bitbucket tokens).
- Cloning a specific branch/tag/depth (could be a follow-up `--branch` flag).
- Updating/pulling an already-cloned repo (`/pull`) — separate command later.

## Testing

- Public clone, no name → derives name, clones, switches session.
- Public clone with explicit name.
- Name collision → error + `/project` suggestion.
- Invalid name characters → rejected.
- Non-https URL (ssh/git/file) → rejected.
- Private github URL with `GITHUB_TOKEN` set → succeeds; `.git/config` contains
  no token; token absent from logs and from any error reply.
- Private github URL without token → fails with sanitized, tokenless error and
  the partial directory is removed.
