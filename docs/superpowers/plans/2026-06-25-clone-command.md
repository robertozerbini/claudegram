# /clone Command Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `/clone <git-url> [name]` Telegram command that git-clones a repository into the workspace and switches the session to it, supporting private GitHub repos via a `GITHUB_TOKEN` secret.

**Architecture:** Pure, side-effect-free helpers (URL validation, project-name derivation, git-arg building, error sanitizing) live in a new self-contained `src/git/clone.ts` module with unit tests. A thin async `runGitClone` runner wraps `execFile('git', …)`. The Telegram handler `handleClone` orchestrates them, mirroring the existing `handleNewProject` flow (clone → `setWorkingDirectory` → `clearConversation` → reply).

**Tech Stack:** TypeScript (ESM, `moduleResolution: bundler`), grammY, Node `child_process`. New dev dependency: **vitest** (first test framework in this repo).

## Global Constraints

- Node `>=20`; ESM modules (`"type": "module"`).
- Relative imports in **source** files use `.js` extensions (e.g. `'../../git/clone.js'`), matching existing code. **Test** files import without extension (e.g. `'./clone'`) so vitest resolves `.ts` directly.
- HTTPS-only clone URLs. SSH/`git://`/`file://`/non-https are rejected.
- The `GITHUB_TOKEN` value must NEVER appear in logs, replies, or `.git/config` on disk.
- Git is always invoked with an argv array (never a shell string) — no shell interpolation.
- Project name must match `^[a-zA-Z0-9_-]+$` (same rule as `handleNewProject`).

---

### Task 1: Test infra + pure clone helpers

**Files:**
- Modify: `package.json` (add vitest dev dep + `test` script)
- Create: `src/git/clone.ts`
- Test: `src/git/clone.test.ts`

**Interfaces:**
- Consumes: nothing (self-contained, no relative imports).
- Produces, for Task 2:
  - `deriveProjectName(gitUrl: string): string` — last path segment of the URL with a single trailing `.git` removed. Returns `''` if none derivable.
  - `validateCloneUrl(gitUrl: string, allowPrivateNetwork: boolean): { ok: true; host: string } | { ok: false; reason: string }` — requires `https:`; rejects loopback/private/link-local/`.local`/`localhost` hosts unless `allowPrivateNetwork` is true.
  - `buildGitCloneArgs(gitUrl: string, dest: string, token: string | undefined): string[]` — argv **after** the `git` binary. Injects `-c http.extraHeader=AUTHORIZATION: basic <base64("x-access-token:"+token)>` only when `token` is set AND host is exactly `github.com`; always ends with `clone`, `--`, `gitUrl`, `dest`.
  - `sanitizeGitError(stderr: string, token: string | undefined): string` — replaces the token value and any `AUTHORIZATION: basic …` header with `***`; trims to a single tidy string.

- [ ] **Step 1: Add vitest and the test script**

Edit `package.json` — add to `scripts` and `devDependencies`:

```json
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "build": "tsc",
    "start": "node dist/index.js",
    "typecheck": "tsc --noEmit",
    "test": "vitest run"
  },
```

Then install vitest as a dev dependency:

```bash
cd ~/projects/claudegram && npm install -D vitest@^2
```

Expected: `package.json` gains `"vitest": "^2.x"` under `devDependencies`; `package-lock.json` updates.

- [ ] **Step 2: Write the failing tests**

Create `src/git/clone.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import {
  deriveProjectName,
  validateCloneUrl,
  buildGitCloneArgs,
  sanitizeGitError,
} from './clone';

describe('deriveProjectName', () => {
  it('strips a trailing .git', () => {
    expect(deriveProjectName('https://github.com/acme/foo.git')).toBe('foo');
  });
  it('works without .git', () => {
    expect(deriveProjectName('https://github.com/acme/foo')).toBe('foo');
  });
  it('ignores a trailing slash', () => {
    expect(deriveProjectName('https://github.com/acme/foo/')).toBe('foo');
  });
  it('returns empty string when nothing derivable', () => {
    expect(deriveProjectName('https://github.com')).toBe('');
  });
});

describe('validateCloneUrl', () => {
  it('accepts a public https url', () => {
    expect(validateCloneUrl('https://github.com/acme/foo.git', false))
      .toEqual({ ok: true, host: 'github.com' });
  });
  it('rejects non-https schemes', () => {
    expect(validateCloneUrl('git@github.com:acme/foo.git', false).ok).toBe(false);
    expect(validateCloneUrl('git://github.com/acme/foo.git', false).ok).toBe(false);
    expect(validateCloneUrl('file:///etc/passwd', false).ok).toBe(false);
    expect(validateCloneUrl('http://github.com/acme/foo.git', false).ok).toBe(false);
  });
  it('rejects garbage', () => {
    expect(validateCloneUrl('not a url', false).ok).toBe(false);
  });
  it('rejects localhost and private hosts by default', () => {
    expect(validateCloneUrl('https://localhost/x.git', false).ok).toBe(false);
    expect(validateCloneUrl('https://127.0.0.1/x.git', false).ok).toBe(false);
    expect(validateCloneUrl('https://10.0.0.5/x.git', false).ok).toBe(false);
    expect(validateCloneUrl('https://192.168.1.1/x.git', false).ok).toBe(false);
    expect(validateCloneUrl('https://172.16.0.1/x.git', false).ok).toBe(false);
    expect(validateCloneUrl('https://169.254.0.1/x.git', false).ok).toBe(false);
    expect(validateCloneUrl('https://box.local/x.git', false).ok).toBe(false);
  });
  it('allows private hosts when flag is set', () => {
    expect(validateCloneUrl('https://192.168.1.1/x.git', true).ok).toBe(true);
  });
});

describe('buildGitCloneArgs', () => {
  it('builds plain args when no token', () => {
    expect(buildGitCloneArgs('https://github.com/acme/foo.git', '/w/foo', undefined))
      .toEqual(['clone', '--', 'https://github.com/acme/foo.git', '/w/foo']);
  });
  it('injects an auth header for github when token set', () => {
    const args = buildGitCloneArgs('https://github.com/acme/foo.git', '/w/foo', 'tok123');
    const b64 = Buffer.from('x-access-token:tok123').toString('base64');
    expect(args).toEqual([
      '-c', `http.extraHeader=AUTHORIZATION: basic ${b64}`,
      'clone', '--', 'https://github.com/acme/foo.git', '/w/foo',
    ]);
  });
  it('does NOT inject a token for non-github hosts', () => {
    expect(buildGitCloneArgs('https://gitlab.com/acme/foo.git', '/w/foo', 'tok123'))
      .toEqual(['clone', '--', 'https://gitlab.com/acme/foo.git', '/w/foo']);
  });
});

describe('sanitizeGitError', () => {
  it('redacts the token value', () => {
    const out = sanitizeGitError('fatal: auth failed for tok123 here', 'tok123');
    expect(out).not.toContain('tok123');
    expect(out).toContain('***');
  });
  it('redacts an AUTHORIZATION header', () => {
    const out = sanitizeGitError('... AUTHORIZATION: basic eHl6 ...', undefined);
    expect(out).not.toContain('eHl6');
  });
  it('is a no-op for clean text', () => {
    expect(sanitizeGitError('Repository not found', undefined)).toContain('Repository not found');
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd ~/projects/claudegram && npm test`
Expected: FAIL — `Failed to resolve import "./clone"` / module has no such exports.

- [ ] **Step 4: Implement `src/git/clone.ts`**

Create `src/git/clone.ts`:

```typescript
// Pure helpers for the /clone command. No side effects, no relative imports —
// kept isolated so the URL/auth/sanitizing logic is unit-testable.

/** Last path segment of a git URL with one trailing `.git` removed. */
export function deriveProjectName(gitUrl: string): string {
  const cleaned = gitUrl.trim().replace(/\/+$/, '');
  const lastSlash = cleaned.lastIndexOf('/');
  const segment = lastSlash >= 0 ? cleaned.slice(lastSlash + 1) : '';
  return segment.replace(/\.git$/, '');
}

type Validation =
  | { ok: true; host: string }
  | { ok: false; reason: string };

/** True when a hostname is loopback/private/link-local and must be blocked. */
function isPrivateHost(host: string): boolean {
  const h = host.toLowerCase();
  if (h === 'localhost' || h.endsWith('.local')) return true;
  if (h === '::1') return true;
  if (/^127\./.test(h)) return true;
  if (/^10\./.test(h)) return true;
  if (/^192\.168\./.test(h)) return true;
  if (/^169\.254\./.test(h)) return true;
  if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(h)) return true;
  return false;
}

/** Require https and (unless allowed) a public host. */
export function validateCloneUrl(gitUrl: string, allowPrivateNetwork: boolean): Validation {
  let url: URL;
  try {
    url = new URL(gitUrl.trim());
  } catch {
    return { ok: false, reason: 'That does not look like a valid URL.' };
  }
  if (url.protocol !== 'https:') {
    return { ok: false, reason: 'Only https:// repository URLs are supported.' };
  }
  if (!allowPrivateNetwork && isPrivateHost(url.hostname)) {
    return { ok: false, reason: 'Refusing to clone from a private/localhost address.' };
  }
  return { ok: true, host: url.hostname };
}

/**
 * Argv (after the `git` binary) for cloning `gitUrl` into `dest`.
 * Injects a GitHub auth header via `http.extraHeader` only for github.com so
 * the token is never written to the cloned repo's `.git/config`.
 */
export function buildGitCloneArgs(
  gitUrl: string,
  dest: string,
  token: string | undefined,
): string[] {
  const args: string[] = [];
  let host = '';
  try {
    host = new URL(gitUrl).hostname.toLowerCase();
  } catch {
    /* validateCloneUrl is the gatekeeper; treat as non-github here */
  }
  if (token && host === 'github.com') {
    const basic = Buffer.from(`x-access-token:${token}`).toString('base64');
    args.push('-c', `http.extraHeader=AUTHORIZATION: basic ${basic}`);
  }
  args.push('clone', '--', gitUrl, dest);
  return args;
}

/** Strip the token value and any AUTHORIZATION header from git stderr. */
export function sanitizeGitError(stderr: string, token: string | undefined): string {
  let out = stderr;
  if (token) out = out.split(token).join('***');
  out = out.replace(/AUTHORIZATION:\s*basic\s+\S+/gi, 'AUTHORIZATION: basic ***');
  return out.trim();
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd ~/projects/claudegram && npm test`
Expected: PASS — all four describe blocks green.

- [ ] **Step 6: Commit**

```bash
cd ~/projects/claudegram
git add package.json package-lock.json src/git/clone.ts src/git/clone.test.ts
git commit -m "feat: pure helpers + tests for /clone (vitest)"
```

---

### Task 2: GITHUB_TOKEN config, runGitClone runner, handler & registration

**Files:**
- Modify: `src/config.ts` (add `GITHUB_TOKEN`)
- Modify: `.env.example` (document `GITHUB_TOKEN`)
- Modify: `src/git/clone.ts` (add the `runGitClone` runner)
- Modify: `src/bot/handlers/command.handler.ts` (add `handleClone`, export it, add to help text)
- Modify: `src/bot/bot.ts` (register command + add to menu)

**Interfaces:**
- Consumes from Task 1: `deriveProjectName`, `validateCloneUrl`, `buildGitCloneArgs`, `sanitizeGitError`.
- Produces:
  - `runGitClone(gitUrl: string, dest: string, token: string | undefined): Promise<{ ok: true } | { ok: false; error: string }>` (in `src/git/clone.ts`) — runs `execFile('git', buildGitCloneArgs(...))`, returns sanitized error on failure.
  - `handleClone(ctx: Context): Promise<void>` (exported from `command.handler.ts`).

- [ ] **Step 1: Add `GITHUB_TOKEN` to config**

In `src/config.ts`, add to the zod schema next to `ANTHROPIC_API_KEY` (around line 23):

```typescript
  ANTHROPIC_API_KEY: z.string().optional(), // Optional - uses Claude Max subscription if not set
  GITHUB_TOKEN: z.string().optional(),       // Optional - enables private GitHub clones via /clone
```

Verify the schema is fed from `process.env` (it already is); no other change needed.

- [ ] **Step 2: Document it in `.env.example`**

Add under the `── Claude ──` block (or a new `── Git ──` block) in `.env.example`:

```bash
# ── Git ──────────────────────────────────────────────────────
# Optional GitHub token (classic or fine-grained) for cloning PRIVATE repos
# with /clone. Leave empty for public repos only.
# GITHUB_TOKEN=ghp_...
```

- [ ] **Step 3: Add the `runGitClone` runner to `src/git/clone.ts`**

Append to `src/git/clone.ts` (this part touches the filesystem/process, so it is verified manually, not unit-tested):

```typescript
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** Clone `gitUrl` into `dest`. Resolves with a sanitized error on failure. */
export async function runGitClone(
  gitUrl: string,
  dest: string,
  token: string | undefined,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const args = buildGitCloneArgs(gitUrl, dest, token);
  try {
    await execFileAsync('git', args, { timeout: 120_000 });
    return { ok: true };
  } catch (e) {
    const stderr = (e as { stderr?: string }).stderr ?? (e as Error).message ?? 'git clone failed';
    return { ok: false, error: sanitizeGitError(String(stderr), token) };
  }
}
```

Put the two `import` lines at the TOP of the file (above the helper functions).

- [ ] **Step 4: Implement `handleClone` in `command.handler.ts`**

At the top of `src/bot/handlers/command.handler.ts`, add the import (with `.js` extension):

```typescript
import { deriveProjectName, validateCloneUrl, runGitClone } from '../../git/clone.js';
```

Add `handleClone` immediately after `handleNewProject` (after line ~738). It mirrors `handleNewProject` but clones first:

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
    await replyMd(ctx, 'Usage: `/clone <git-url> [name]`');
    return;
  }

  const valid = validateCloneUrl(gitUrl, config.ALLOW_PRIVATE_NETWORK_URLS);
  if (!valid.ok) {
    await replyMd(ctx, `❌ ${esc(valid.reason)}`);
    return;
  }

  const name = (explicitName ?? deriveProjectName(gitUrl)).trim();
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
```

- [ ] **Step 5: Add `/clone` to the help text**

In `handleStart`'s welcome string and in `handleCommands`'s listing, add a line beside `/newproject`. In `handleStart` (near line 343):

```typescript
• \`/newproject <name>\` \\- Create a new project
• \`/clone <url> \\[name\\]\` \\- Clone a git repo and open it
```

Add the equivalent `/clone` line wherever `handleCommands` enumerates project commands (search for the `/newproject` line in that function and add `/clone` right after it, using the same escaping style already present there).

- [ ] **Step 6: Register the command in `bot.ts`**

In `src/bot/bot.ts`, add the import alongside the other `command.handler` imports, then register beneath `handleNewProject` (after line 163):

```typescript
  bot.command('newproject', handleNewProject);
  bot.command('clone', handleClone);
```

And add `clone` to the `commandList` array passed to `setMyCommands` (near line 140), e.g.:

```typescript
    { command: 'clone', description: '📥 Clone a git repo and open it' },
```

Place it right after the `newproject` entry (line ~109). The descriptions in
this array are emoji-prefixed — match that style.

- [ ] **Step 7: Typecheck and build**

Run: `cd ~/projects/claudegram && npm run typecheck && npm run build && npm test`
Expected: typecheck clean, build emits `dist/`, all unit tests still PASS.

- [ ] **Step 8: Manual end-to-end clone (public repo, no token)**

Run a throwaway script to exercise `runGitClone` without Telegram:

```bash
cd ~/projects/claudegram
node --input-type=module -e '
import { runGitClone } from "./dist/git/clone.js";
import { existsSync, rmSync } from "node:fs";
const dest = "/tmp/clone-smoke";
rmSync(dest, { recursive: true, force: true });
const r = await runGitClone("https://github.com/octocat/Hello-World.git", dest, undefined);
console.log("result:", r);
console.log(".git present:", existsSync(dest + "/.git"));
rmSync(dest, { recursive: true, force: true });
'
```

Expected: `result: { ok: true }` and `.git present: true`.

- [ ] **Step 9: Commit**

```bash
cd ~/projects/claudegram
git add src/config.ts .env.example src/git/clone.ts src/bot/handlers/command.handler.ts src/bot/bot.ts
git commit -m "feat: add /clone command (private repos via GITHUB_TOKEN)"
```

---

## Self-Review

**Spec coverage:**
- `/clone <git-url> [name]` + name derivation → Task 2 Step 4 (`handleClone`), Task 1 (`deriveProjectName`). ✓
- Mirrors `handleNewProject` (switch dir + clear conversation) → Task 2 Step 4. ✓
- Name collision / invalid-name errors → Task 2 Step 4. ✓
- GITHUB_TOKEN config + private GitHub auth via `http.extraHeader`, no token on disk → Task 2 Steps 1, 3; Task 1 `buildGitCloneArgs`. ✓
- HTTPS-only + SSRF/private-host rejection → Task 1 `validateCloneUrl`. ✓
- Token never logged / never in replies (sanitizer) → Task 1 `sanitizeGitError`, Task 2 Step 4 error path. ✓
- Clean failure removes partial dir → Task 2 Step 4. ✓
- argv (no shell injection) → Task 1 `buildGitCloneArgs`, Task 2 `runGitClone`. ✓
- `.env.example` documents GITHUB_TOKEN → Task 2 Step 2. ✓
- Help text / command menu → Task 2 Steps 5, 6. ✓

**Placeholder scan:** none — all steps contain concrete code or exact commands.

**Type consistency:** `deriveProjectName`, `validateCloneUrl` (`{ ok, host }`/`{ ok, reason }`), `buildGitCloneArgs`, `sanitizeGitError`, `runGitClone` (`{ ok } | { ok, error }`), and `handleClone(ctx)` are used in Task 2 exactly as defined in Task 1 / their interface blocks. `config.GITHUB_TOKEN` and `config.ALLOW_PRIVATE_NETWORK_URLS` are referenced consistently.
