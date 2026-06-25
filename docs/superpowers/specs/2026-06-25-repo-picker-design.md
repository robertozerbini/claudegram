# GitHub repo picker for `/clone` — design

## Purpose

Let a user clone one of their own GitHub repositories by picking it from a list
instead of copy-pasting a URL. Running `/clone` with no argument fetches the
user's owned repos and presents a paginated inline-keyboard picker; tapping a
repo clones it using the existing `/clone` machinery.

Builds on the existing `/clone` command (see
`2026-06-25-clone-command-design.md`) and mirrors the interactive paginated
picker already used by `/project`.

## Trigger

- `/clone` **with no argument** → opens the repo picker.
- `/clone <git-url> [name]` → unchanged (clones the given URL directly).

## Scope of repos

- The user's **own** repositories only (`affiliation=owner`), public and
  private, sorted by most recently pushed.
- Requires `GITHUB_TOKEN`. Without it, listing owned/private repos is not
  possible, so the picker is unavailable (see No-token handling).

## Components

### 1. `src/git/github.ts` (new, isolated, unit-testable)

```ts
export interface Repo {
  name: string;        // e.g. "claudegram"
  fullName: string;    // e.g. "octocat/claudegram"
  private: boolean;
  cloneUrl: string;    // https clone URL
  pushedAt: string;    // ISO timestamp
}

export type ListReposResult =
  | { ok: true; repos: Repo[] }
  | { ok: false; error: string };

export function listOwnedRepos(token: string): Promise<ListReposResult>;
```

- Calls `GET https://api.github.com/user/repos?affiliation=owner&sort=pushed&per_page=100`
  with headers `Authorization: Bearer <token>`, `Accept: application/vnd.github+json`,
  `X-GitHub-Api-Version: 2022-11-28`, and a `User-Agent` (GitHub requires one).
- Maps each item to `Repo` (`clone_url` → `cloneUrl`, `pushed_at` → `pushedAt`,
  `full_name` → `fullName`).
- On non-2xx or network error, returns `{ ok: false, error }` with a friendly,
  **token-sanitized** message (reuse `sanitizeGitError` or an equivalent guard
  so the token can never appear). 401 → "GitHub token rejected (check
  GITHUB_TOKEN)."; 403 with rate-limit headers → "GitHub API rate limit
  reached, try again later."
- Uses the global `fetch` (Node 20+). No pagination beyond the first 100 repos
  (YAGNI).

### 2. Picker state + keyboard (mirrors `/project`'s browser)

- A new small module **`src/bot/repo-picker.ts`** holds the `RepoPickerState`
  type (`{ repos: Repo[]; page: number }`) and the **pure** keyboard builder, so
  the pagination logic is unit-testable without importing grammY/bot wiring. The
  per-chat state map and the callback handler live in `command.handler.ts`
  (they need `ctx`/`sessionManager`), mirroring how `ProjectBrowserState` is
  managed there.
- `callback_data` references repos **by index** into the cached list — Telegram
  limits `callback_data` to 64 bytes, so full URLs/names cannot be embedded.
- Pure keyboard builder `buildRepoPickerKeyboard(state: RepoPickerState): { inline_keyboard: { text: string; callback_data: string }[][] }` (in `repo-picker.ts`) —
  - 8 repos per page (matching `/project`), one repo per row:
    `🔒 name` (private) or `📂 name` (public), `callback_data: repo:open:<index>`.
  - Nav row: `◀️ Prev` (`repo:page:prev`) when `page > 0`, `Next ▶️`
    (`repo:page:next`) when more pages remain.
  - `🔄 Refresh` row (`repo:refresh`) — re-fetches the list.
- Long repo names are shortened for the button label using the existing
  `shortenName` helper.

### 3. Callback handling

- A new `handleRepoCallback(ctx)` routed from the existing
  `bot.on('callback_query:data')` dispatcher in `bot.ts`, alongside the
  `project:` routing. Handles `callback_data` starting with `repo:`.
- `repo:open:<index>` → look up the repo in `RepoPickerState`, then call the
  shared `cloneIntoProject` helper with `repo.cloneUrl` and `repo.name`.
  - If state is missing/expired or the index is out of range →
    `answerCallbackQuery({ text: 'Selection expired, run /clone again' })`.
- `repo:page:prev` / `repo:page:next` → adjust `state.page`, edit the message's
  reply markup with the new keyboard, `answerCallbackQuery()`.
- `repo:refresh` → re-fetch via `listOwnedRepos`, reset `page` to 0, update
  state and keyboard.

### 4. Shared clone helper (small refactor of `handleClone`)

Extract the execution tail of the existing `handleClone` into:

```ts
async function cloneIntoProject(
  ctx: Context,
  sessionKey: string,
  gitUrl: string,
  name: string,
): Promise<void>;
```

It performs: name-regex validation, existence check (error + `/project`
suggestion if the dir exists), `⏳ Cloning…` reply, `runGitClone`, partial-dir
cleanup + sanitized error on failure, then `setWorkingDirectory` +
`clearConversation` + success reply + optional resume message.

- `handleClone` (typed-URL path) calls `cloneIntoProject` after validating the
  URL — **no behavior change** for `/clone <url>`.
- The picker's `repo:open` path calls `cloneIntoProject` directly (the
  `cloneUrl` from the API is already a valid https GitHub URL, so URL
  validation is not re-needed, but `cloneIntoProject` still runs the name and
  existence checks).

### 5. No-token handling

When `/clone` is run with no argument and `config.GITHUB_TOKEN` is unset:

> "Set `GITHUB_TOKEN` to browse your repos, or clone by URL: `/clone <url>`"

(escaped for MarkdownV2; brackets/backticks per the code-span rules already
established for `/clone`.)

### 6. Empty / large lists

- Zero owned repos → "No repositories found for your account."
- More than 100 repos → only the 100 most-recently-pushed are shown (documented
  limitation; refresh does not page past 100).

## Files touched

| File | Change |
|------|--------|
| `src/git/github.ts` | New: `listOwnedRepos`, `Repo`, `ListReposResult`. |
| `src/git/github.test.ts` | New: unit tests (mock `fetch`). |
| `src/bot/repo-picker.ts` | New: `RepoPickerState` type + pure `buildRepoPickerKeyboard`. |
| `src/bot/repo-picker.test.ts` | New: pagination + icon unit tests. |
| `src/bot/handlers/command.handler.ts` | Refactor `handleClone` → add `cloneIntoProject`; add per-chat picker state map + `handleRepoCallback`; `/clone` no-arg opens the picker. |
| `src/bot/bot.ts` | Route `repo:` callbacks to `handleRepoCallback`. |

## Testing

- `listOwnedRepos`: mock `fetch` —
  - 200 with a sample payload → parses `name/fullName/private/cloneUrl/pushedAt`
    correctly, preserves API order.
  - 401 → `{ ok: false }` with a sanitized message; the token string never
    appears in `error`.
  - network rejection → `{ ok: false }` with a friendly message.
- `buildRepoPickerKeyboard`: pure function —
  - page 0 of 20 repos → 8 repo rows + a `Next ▶️` (no `Prev`).
  - last page → `◀️ Prev` only, correct remaining count.
  - private repo → `🔒` label; public → `📂`.
  - `callback_data` uses the absolute index (page-independent).
- Callback wiring (`handleRepoCallback`) and the no-token path are
  integration-level; verified via typecheck + build and a manual check.

## Out of scope (YAGNI)

- Org / collaborator / starred repos (owner-only for now).
- Search/filter by name.
- Pagination past 100 repos; cross-restart caching of the repo list.
- Branch/tag selection (inherited from `/clone`'s scope).
