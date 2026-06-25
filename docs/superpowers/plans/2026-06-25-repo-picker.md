# GitHub Repo Picker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `/clone` with no argument show a paginated inline-keyboard picker of the user's owned GitHub repos; tapping one clones it via the existing `runGitClone` path.

**Architecture:** A new isolated `src/git/github.ts` fetches owned repos from the GitHub REST API. A new pure `src/bot/repo-picker.ts` builds the paginated keyboard (unit-tested). `command.handler.ts` gains a per-chat picker-state map, a `handleRepoCallback`, and a `cloneIntoProject` helper extracted from `handleClone` so the typed-URL path and the tapped-repo path share identical clone logic. `bot.ts` routes `repo:` callbacks. Mirrors the existing `/project` paginated-browser pattern.

**Tech Stack:** TypeScript (ESM, bundler resolution), grammY, global `fetch` (Node 20+), vitest.

## Global Constraints

- Node >=20; ESM (`"type": "module"`). Source relative imports use `.js` extensions; vitest test files import the module under test WITHOUT extension.
- Owner-only repos (`affiliation=owner`), public + private, sorted by `pushed`, first 100 only.
- The picker requires `GITHUB_TOKEN`; when unset, `/clone` with no arg shows a set-token/use-URL message.
- `GITHUB_TOKEN` must NEVER appear in logs or replies — `listOwnedRepos` error strings pass through `sanitizeGitError`.
- `callback_data` references repos by absolute index (Telegram's 64-byte limit); 8 repos per page.
- No behavior change for `/clone <url>` — it still validates the URL then clones.
- Mirror the existing `/project` browser conventions (per-chat state `Map`, `repo:` callback prefix routed from the `bot.on('callback_query:data')` dispatcher in `bot.ts`).

---

### Task 1: GitHub API client (`src/git/github.ts`)

**Files:**
- Create: `src/git/github.ts`
- Test: `src/git/github.test.ts`

**Interfaces:**
- Consumes: `sanitizeGitError(stderr: string, token: string | undefined): string` from `./clone.js` (already exists).
- Produces (for Tasks 2 & 3):
  - `interface Repo { name: string; fullName: string; private: boolean; cloneUrl: string; pushedAt: string }`
  - `type ListReposResult = { ok: true; repos: Repo[] } | { ok: false; error: string }`
  - `listOwnedRepos(token: string): Promise<ListReposResult>`

- [ ] **Step 1: Write the failing tests**

Create `src/git/github.test.ts`:

```typescript
import { describe, it, expect, vi, afterEach } from 'vitest';
import { listOwnedRepos } from './github';

function mockFetch(impl: (...a: unknown[]) => Promise<Response>) {
  vi.stubGlobal('fetch', vi.fn(impl));
}
afterEach(() => vi.unstubAllGlobals());

describe('listOwnedRepos', () => {
  it('parses a 200 payload, preserving order', async () => {
    mockFetch(async () => new Response(JSON.stringify([
      { name: 'foo', full_name: 'me/foo', private: true,  clone_url: 'https://github.com/me/foo.git', pushed_at: '2026-01-02T00:00:00Z' },
      { name: 'bar', full_name: 'me/bar', private: false, clone_url: 'https://github.com/me/bar.git', pushed_at: '2026-01-01T00:00:00Z' },
    ]), { status: 200 }));
    const r = await listOwnedRepos('tok');
    expect(r).toEqual({ ok: true, repos: [
      { name: 'foo', fullName: 'me/foo', private: true,  cloneUrl: 'https://github.com/me/foo.git', pushedAt: '2026-01-02T00:00:00Z' },
      { name: 'bar', fullName: 'me/bar', private: false, cloneUrl: 'https://github.com/me/bar.git', pushedAt: '2026-01-01T00:00:00Z' },
    ]});
  });

  it('returns a tokenless error on 401', async () => {
    mockFetch(async () => new Response('', { status: 401 }));
    const r = await listOwnedRepos('secret-tok');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).not.toContain('secret-tok');
      expect(r.error).toMatch(/token/i);
    }
  });

  it('returns a rate-limit message on 403', async () => {
    mockFetch(async () => new Response('', { status: 403 }));
    const r = await listOwnedRepos('tok');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/rate limit/i);
  });

  it('does not leak the token on a network error', async () => {
    mockFetch(async () => { throw new Error('boom secret-tok'); });
    const r = await listOwnedRepos('secret-tok');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).not.toContain('secret-tok');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd ~/projects/claudegram && npm test -- github`
Expected: FAIL — `Failed to resolve import "./github"`.

- [ ] **Step 3: Implement `src/git/github.ts`**

```typescript
import { sanitizeGitError } from './clone.js';

export interface Repo {
  name: string;
  fullName: string;
  private: boolean;
  cloneUrl: string;
  pushedAt: string;
}

export type ListReposResult =
  | { ok: true; repos: Repo[] }
  | { ok: false; error: string };

interface GitHubRepoApi {
  name: string;
  full_name: string;
  private: boolean;
  clone_url: string;
  pushed_at: string;
}

export async function listOwnedRepos(token: string): Promise<ListReposResult> {
  let res: Response;
  try {
    res = await fetch(
      'https://api.github.com/user/repos?affiliation=owner&sort=pushed&per_page=100',
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'claudegram',
        },
      },
    );
  } catch (e) {
    return { ok: false, error: sanitizeGitError(`Could not reach GitHub: ${(e as Error).message}`, token) };
  }

  if (res.status === 401) {
    return { ok: false, error: 'GitHub token rejected (check GITHUB_TOKEN).' };
  }
  if (res.status === 403) {
    return { ok: false, error: 'GitHub API rate limit reached, try again later.' };
  }
  if (!res.ok) {
    return { ok: false, error: sanitizeGitError(`GitHub API error (HTTP ${res.status}).`, token) };
  }

  const data = (await res.json()) as GitHubRepoApi[];
  const repos: Repo[] = data.map((r) => ({
    name: r.name,
    fullName: r.full_name,
    private: r.private,
    cloneUrl: r.clone_url,
    pushedAt: r.pushed_at,
  }));
  return { ok: true, repos };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd ~/projects/claudegram && npm test -- github`
Expected: PASS — 4 tests green.

- [ ] **Step 5: Commit**

```bash
cd ~/projects/claudegram
git add src/git/github.ts src/git/github.test.ts
git commit -m "feat: listOwnedRepos GitHub API client + tests"
```

---

### Task 2: Pure keyboard builder (`src/bot/repo-picker.ts`)

**Files:**
- Create: `src/bot/repo-picker.ts`
- Test: `src/bot/repo-picker.test.ts`

**Interfaces:**
- Consumes: `Repo` from `../git/github.js`.
- Produces (for Task 3):
  - `interface RepoPickerState { repos: Repo[]; page: number }`
  - `const PAGE_SIZE = 8` (exported)
  - `buildRepoPickerKeyboard(state: RepoPickerState): { inline_keyboard: { text: string; callback_data: string }[][] }`

- [ ] **Step 1: Write the failing tests**

Create `src/bot/repo-picker.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { buildRepoPickerKeyboard, RepoPickerState } from './repo-picker';
import type { Repo } from '../git/github';

function repo(name: string, priv = false): Repo {
  return { name, fullName: `me/${name}`, private: priv, cloneUrl: `https://github.com/me/${name}.git`, pushedAt: '2026-01-01T00:00:00Z' };
}
function repos(n: number): Repo[] {
  return Array.from({ length: n }, (_, i) => repo(`r${i}`, i % 2 === 0));
}

describe('buildRepoPickerKeyboard', () => {
  it('page 0 of 20: 8 repo rows + Next-only nav + Refresh', () => {
    const rows = buildRepoPickerKeyboard({ repos: repos(20), page: 0 }).inline_keyboard;
    expect(rows).toHaveLength(10); // 8 repos + nav + refresh
    expect(rows[0][0].callback_data).toBe('repo:open:0');
    expect(rows[8].map(b => b.callback_data)).toEqual(['repo:page:next']);
    expect(rows[9][0].callback_data).toBe('repo:refresh');
  });

  it('last page: Prev-only nav and page-absolute indices', () => {
    const rows = buildRepoPickerKeyboard({ repos: repos(20), page: 2 }).inline_keyboard; // repos 16..19
    expect(rows[0][0].callback_data).toBe('repo:open:16');
    expect(rows).toHaveLength(6); // 4 repos + nav + refresh
    expect(rows[4].map(b => b.callback_data)).toEqual(['repo:page:prev']);
  });

  it('single page: no nav row', () => {
    const rows = buildRepoPickerKeyboard({ repos: repos(5), page: 0 }).inline_keyboard;
    expect(rows).toHaveLength(6); // 5 repos + refresh, no nav
    expect(rows[5][0].callback_data).toBe('repo:refresh');
  });

  it('private repos show 🔒 and public show 📂', () => {
    const rows = buildRepoPickerKeyboard({ repos: [repo('priv', true), repo('pub', false)], page: 0 }).inline_keyboard;
    expect(rows[0][0].text).toContain('🔒');
    expect(rows[1][0].text).toContain('📂');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd ~/projects/claudegram && npm test -- repo-picker`
Expected: FAIL — `Failed to resolve import "./repo-picker"`.

- [ ] **Step 3: Implement `src/bot/repo-picker.ts`**

```typescript
import type { Repo } from '../git/github.js';

export interface RepoPickerState {
  repos: Repo[];
  page: number;
}

export const PAGE_SIZE = 8;

// Self-contained label truncation so this module stays pure/testable
// without importing the bot's command handler.
function truncateLabel(name: string, max = 24): string {
  return name.length <= max ? name : `${name.slice(0, max - 1)}…`;
}

export function buildRepoPickerKeyboard(
  state: RepoPickerState,
): { inline_keyboard: { text: string; callback_data: string }[][] } {
  const { repos, page } = state;
  const totalPages = Math.max(1, Math.ceil(repos.length / PAGE_SIZE));
  const start = page * PAGE_SIZE;
  const slice = repos.slice(start, start + PAGE_SIZE);

  const rows: { text: string; callback_data: string }[][] = [];
  slice.forEach((repo, i) => {
    const index = start + i;
    const icon = repo.private ? '🔒' : '📂';
    rows.push([{ text: `${icon} ${truncateLabel(repo.name)}`, callback_data: `repo:open:${index}` }]);
  });

  const nav: { text: string; callback_data: string }[] = [];
  if (page > 0) nav.push({ text: '◀️ Prev', callback_data: 'repo:page:prev' });
  if (page < totalPages - 1) nav.push({ text: 'Next ▶️', callback_data: 'repo:page:next' });
  if (nav.length > 0) rows.push(nav);

  rows.push([{ text: '🔄 Refresh', callback_data: 'repo:refresh' }]);
  return { inline_keyboard: rows };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd ~/projects/claudegram && npm test -- repo-picker`
Expected: PASS — 4 tests green.

- [ ] **Step 5: Commit**

```bash
cd ~/projects/claudegram
git add src/bot/repo-picker.ts src/bot/repo-picker.test.ts
git commit -m "feat: pure repo-picker keyboard builder + tests"
```

---

### Task 3: Wire the picker into `/clone` and the callback dispatcher

**Files:**
- Modify: `src/bot/handlers/command.handler.ts` (refactor `handleClone`; add `cloneIntoProject`, `openRepoPicker`, `handleRepoCallback`, `repoPickerState` map, imports)
- Modify: `src/bot/bot.ts` (import `handleRepoCallback`; route `repo:` callbacks)

**Interfaces:**
- Consumes from Task 1: `listOwnedRepos`, `Repo`. From Task 2: `buildRepoPickerKeyboard`, `RepoPickerState`, `PAGE_SIZE`.
- Produces: `handleRepoCallback(ctx: Context): Promise<void>` (exported), and an unchanged-signature `handleClone`.

- [ ] **Step 1: Add imports to `command.handler.ts`**

Near the existing `import { deriveProjectName, validateCloneUrl, runGitClone } from '../../git/clone.js';` line, add:

```typescript
import { listOwnedRepos, type Repo } from '../../git/github.js';
import { buildRepoPickerKeyboard, PAGE_SIZE, type RepoPickerState } from '../repo-picker.js';
```

- [ ] **Step 2: Add the per-chat picker-state map**

Next to `const projectBrowserState = new Map<string, ProjectBrowserState>();` (~line 127), add:

```typescript
const repoPickerState = new Map<string, RepoPickerState>();
```

- [ ] **Step 3: Refactor `handleClone` and add `cloneIntoProject` + `openRepoPicker`**

Replace the entire existing `handleClone` function with the following three functions (the clone tail becomes `cloneIntoProject`; the no-arg path becomes `openRepoPicker`):

```typescript
export async function handleClone(ctx: Context): Promise<void> {
  const keyInfo = getSessionKeyFromCtx(ctx);
  if (!keyInfo) return;
  const { sessionKey } = keyInfo;

  const text = ctx.message?.text || '';
  const parts = text.split(' ').slice(1).filter(Boolean);
  const gitUrl = parts[0];
  const explicitName = parts[1];

  if (!gitUrl) {
    await openRepoPicker(ctx, sessionKey);
    return;
  }

  const valid = validateCloneUrl(gitUrl, config.ALLOW_PRIVATE_NETWORK_URLS);
  if (!valid.ok) {
    await replyMd(ctx, `❌ ${esc(valid.reason)}`);
    return;
  }

  const name = (explicitName ?? deriveProjectName(gitUrl)).trim();
  await cloneIntoProject(ctx, sessionKey, gitUrl, name);
}

async function cloneIntoProject(
  ctx: Context,
  sessionKey: string,
  gitUrl: string,
  name: string,
): Promise<void> {
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
    await replyMd(ctx, '❌ Could not derive a valid project name\\. Pass one: `/clone <url> <name>`');
    return;
  }

  const projectPath = path.join(config.WORKSPACE_DIR, name);
  if (fs.existsSync(projectPath)) {
    await replyMd(ctx, `❌ Project "${esc(name)}" already exists\\. Use \`/project ${esc(name)}\` to open it\\.`);
    return;
  }

  await replyMd(ctx, `⏳ Cloning *${esc(name)}*…`);

  const result = await runGitClone(gitUrl, projectPath, config.GITHUB_TOKEN);
  if (!result.ok) {
    // Clean up any partial clone so a retry is fresh.
    try { fs.rmSync(projectPath, { recursive: true, force: true }); } catch { /* ignore */ }
    await replyMd(ctx, `❌ Clone failed:\n\`\`\`\n${esc(result.error)}\n\`\`\``);
    return;
  }

  sessionManager.setWorkingDirectory(sessionKey, projectPath);
  clearConversation(sessionKey);

  await replyMd(ctx, `✅ Cloned and opened: *${esc(name)}*\n\nYou can now chat with Claude about this repo\\!${projectStatusSuffix(sessionKey)}`);

  const s = sessionManager.getSession(sessionKey);
  if (s?.claudeSessionId) {
    await replyMd(ctx, resumeCommandMessage(s.claudeSessionId));
  }
}

async function openRepoPicker(ctx: Context, sessionKey: string): Promise<void> {
  if (!config.GITHUB_TOKEN) {
    await replyMd(ctx, 'Set `GITHUB_TOKEN` to browse your repos, or clone by URL: `/clone <url>`');
    return;
  }

  const result = await listOwnedRepos(config.GITHUB_TOKEN);
  if (!result.ok) {
    await replyMd(ctx, `❌ ${esc(result.error)}`);
    return;
  }
  if (result.repos.length === 0) {
    await replyMd(ctx, 'No repositories found for your account\\.');
    return;
  }

  const state: RepoPickerState = { repos: result.repos, page: 0 };
  repoPickerState.set(sessionKey, state);

  await ctx.reply('📦 Pick a repo to clone:', {
    reply_markup: buildRepoPickerKeyboard(state),
  });
}
```

- [ ] **Step 4: Add `handleRepoCallback`**

Add immediately after the three functions above:

```typescript
export async function handleRepoCallback(ctx: Context): Promise<void> {
  const keyInfo = getSessionKeyFromCtx(ctx);
  if (!keyInfo) return;
  const { sessionKey } = keyInfo;

  const data = ctx.callbackQuery?.data;
  if (!data || !data.startsWith('repo:')) return;

  const state = repoPickerState.get(sessionKey);
  const expired = async () =>
    ctx.answerCallbackQuery({ text: 'Selection expired, run /clone again' });

  if (data.startsWith('repo:open:')) {
    if (!state) { await expired(); return; }
    const index = parseInt(data.slice('repo:open:'.length), 10);
    const repo: Repo | undefined = state.repos[index];
    if (!repo) { await expired(); return; }
    await ctx.answerCallbackQuery();
    await cloneIntoProject(ctx, sessionKey, repo.cloneUrl, repo.name);
    return;
  }

  if (data === 'repo:page:prev' || data === 'repo:page:next') {
    if (!state) { await expired(); return; }
    const totalPages = Math.max(1, Math.ceil(state.repos.length / PAGE_SIZE));
    state.page = data === 'repo:page:next'
      ? Math.min(state.page + 1, totalPages - 1)
      : Math.max(state.page - 1, 0);
    await ctx.editMessageReplyMarkup({ reply_markup: buildRepoPickerKeyboard(state) });
    await ctx.answerCallbackQuery();
    return;
  }

  if (data === 'repo:refresh') {
    if (!config.GITHUB_TOKEN) { await ctx.answerCallbackQuery({ text: 'No GITHUB_TOKEN set' }); return; }
    const result = await listOwnedRepos(config.GITHUB_TOKEN);
    if (!result.ok) { await ctx.answerCallbackQuery({ text: 'Refresh failed' }); return; }
    const newState: RepoPickerState = { repos: result.repos, page: 0 };
    repoPickerState.set(sessionKey, newState);
    await ctx.editMessageReplyMarkup({ reply_markup: buildRepoPickerKeyboard(newState) });
    await ctx.answerCallbackQuery({ text: 'Refreshed' });
    return;
  }
}
```

- [ ] **Step 5: Route `repo:` callbacks in `bot.ts`**

In `src/bot/bot.ts`, add `handleRepoCallback` to the existing import from the command handler module (the same import that brings in `handleProjectCallback`). Then, in the `bot.on('callback_query:data')` dispatcher, add a branch right after the `project:` one:

```typescript
    } else if (data.startsWith('project:')) {
      await handleProjectCallback(ctx);
    } else if (data.startsWith('repo:')) {
      await handleRepoCallback(ctx);
```

- [ ] **Step 6: Typecheck, build, and run the full unit suite**

Run: `cd ~/projects/claudegram && npm run typecheck && npm run build && npm test`
Expected: typecheck clean; build emits `dist/`; all unit tests pass (Task 1's 4 + Task 2's 4 + the pre-existing 15 = 23).

- [ ] **Step 7: Manual sanity check of the typed-URL path (no regression)**

The picker callback path needs a live Telegram token to exercise, but confirm the refactor didn't break the typed-URL clone by re-running the clone smoke test from the prior feature:

```bash
cd ~/projects/claudegram
node --input-type=module -e '
import { runGitClone } from "./dist/git/clone.js";
import { existsSync, rmSync } from "node:fs";
const dest = "/tmp/clone-smoke2";
rmSync(dest, { recursive: true, force: true });
const r = await runGitClone("https://github.com/octocat/Hello-World.git", dest, undefined);
console.log("result:", r, "git present:", existsSync(dest + "/.git"));
rmSync(dest, { recursive: true, force: true });
'
```

Expected: `result: { ok: true } git present: true`.

- [ ] **Step 8: Commit**

```bash
cd ~/projects/claudegram
git add src/bot/handlers/command.handler.ts src/bot/bot.ts
git commit -m "feat: /clone with no arg opens a GitHub repo picker"
```

---

## Self-Review

**Spec coverage:**
- `/clone` no-arg opens picker; `/clone <url>` unchanged → Task 3 Step 3 (`handleClone`). ✓
- Owner-only, pushed-sorted, ≤100, public+private → Task 1 (`listOwnedRepos` query string + parse). ✓
- `src/git/github.ts` (`listOwnedRepos`, `Repo`, `ListReposResult`) + token-sanitized errors → Task 1. ✓
- `src/bot/repo-picker.ts` pure `RepoPickerState` + `buildRepoPickerKeyboard`, index-based callback_data, 8/page, 🔒/📂 → Task 2. ✓
- Per-chat state map + `handleRepoCallback` (open/page/refresh, expired-state handling) → Task 3 Steps 2, 4. ✓
- `repo:` routing in bot.ts dispatcher → Task 3 Step 5. ✓
- Shared `cloneIntoProject` (no behavior change to typed `/clone`) → Task 3 Step 3. ✓
- No-token message; empty-list message → Task 3 Step 3 (`openRepoPicker`). ✓
- Unit tests for `listOwnedRepos` (200/401/403/network, token-leak) and `buildRepoPickerKeyboard` (pagination/icons) → Tasks 1, 2. ✓

**Placeholder scan:** none — every step has concrete code or exact commands.

**Type consistency:** `Repo` (`name/fullName/private/cloneUrl/pushedAt`), `ListReposResult` (`{ ok, repos } | { ok, error }`), `RepoPickerState` (`{ repos, page }`), `PAGE_SIZE`, `buildRepoPickerKeyboard`, `listOwnedRepos`, `cloneIntoProject(ctx, sessionKey, gitUrl, name)`, and `handleRepoCallback(ctx)` are used in Task 3 exactly as defined in Tasks 1–2. `config.GITHUB_TOKEN` / `config.ALLOW_PRIVATE_NETWORK_URLS` referenced consistently. The `repo:` callback_data strings produced in Task 2 match those parsed in Task 3 (`repo:open:<i>`, `repo:page:prev|next`, `repo:refresh`).
