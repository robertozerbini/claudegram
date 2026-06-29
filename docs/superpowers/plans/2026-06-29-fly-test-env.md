# Ephemeral Fly.io Test Environments Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `/teststart`, `/teststop`, `/teststatus` Telegram commands that deploy the current session's workspace project as a throwaway Fly.io app, return a live URL, and tear it down.

**Architecture:** A `flyctl` wrapper module shells out to the bundled `fly` binary using Fly's remote builders (no local Docker). A persisted single-slot state module tracks the one active test app. Three command handlers (matching the existing `handleRestartBot` style) orchestrate deploy/destroy/status. Pure helpers (arg parsing, app-name generation, token redaction) are unit-tested; glue (spawn, Dockerfile, registration, docs) is verified by command.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), grammY, vitest, Fly Machines/flyctl.

## Global Constraints

- TypeScript for all source; functional style; **no `any`**.
- ESM imports use `.js` extension on relative paths (e.g. `import { x } from './y.js'`).
- Tests are colocated `*.test.ts`, run with `npx vitest run <file>`; import from source without extension (e.g. `from './test-env'`).
- `FLY_API_TOKEN` passed to subprocesses **only** via `env`, never as a CLI arg; redacted from all logs and replies.
- Path args validated with `resolvePathWithinRoot` from `src/utils/workspace-guard.js`.
- Errors scrubbed with `sanitizeError` from `src/utils/sanitize.js` before logging/replying.
- Telegram replies use `replyMd` + MarkdownV2 escaping via `esc` (alias of `escapeMarkdownV2`).
- One active test app globally. Default port `8080`. App naming: `claudegram-test-<6-char-id>`.
- `docs/index.html` MUST be updated (per `CLAUDE.md`): one `session` feature card + three command rows.

---

### Task 1: Config — Fly env vars

**Files:**
- Modify: `src/config.ts` (add fields to `envSchema`, after the OpenCode block ~line 220)
- Test: `src/config.fly.test.ts` (create)

**Interfaces:**
- Produces: `config.FLY_API_TOKEN?: string`, `config.FLY_TEST_ORG: string`, `config.FLY_TEST_DEFAULT_PORT: number`, `config.FLY_TEST_REGION: string`.

- [ ] **Step 1: Write the failing test**

```typescript
// src/config.fly.test.ts
import { describe, it, expect } from 'vitest';

describe('fly config', () => {
  it('exposes fly test env fields with defaults', async () => {
    process.env.TELEGRAM_BOT_TOKEN ||= 'x';
    process.env.ALLOWED_USER_IDS ||= '1';
    const { config } = await import('./config');
    expect(config.FLY_TEST_ORG).toBe('personal');
    expect(config.FLY_TEST_DEFAULT_PORT).toBe(8080);
    expect(config.FLY_TEST_REGION).toBe('lax');
    expect('FLY_API_TOKEN' in config).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/config.fly.test.ts`
Expected: FAIL — `config.FLY_TEST_ORG` is `undefined`.

- [ ] **Step 3: Add the fields**

In `src/config.ts`, add inside the `z.object({ ... })` (before the closing `})` of `envSchema`):

```typescript
  // Ephemeral Fly.io test environments (/teststart, /teststop, /teststatus)
  FLY_API_TOKEN: z.string().optional(),
  FLY_TEST_ORG: z.string().default('personal'),
  FLY_TEST_DEFAULT_PORT: z
    .string()
    .default('8080')
    .transform((val) => parseInt(val, 10)),
  FLY_TEST_REGION: z.string().default('lax'),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/config.fly.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/config.ts src/config.fly.test.ts
git commit -m "feat: add Fly.io test-env config vars"
```

---

### Task 2: Fly helpers — pure functions (args, app name, token redaction)

**Files:**
- Create: `src/fly/helpers.ts`
- Test: `src/fly/helpers.test.ts`

**Interfaces:**
- Produces:
  - `generateTestAppName(rand?: () => string): string` — returns `claudegram-test-<6 lowercase alnum>`.
  - `parseTestStartArgs(argString: string, defaultPort: number): { path?: string; port: number }` — splits on whitespace; first token = path (optional), a trailing all-digits token = port, else `defaultPort`.
  - `redactToken(text: string, token?: string): string` — replaces every occurrence of a non-empty `token` with `***`.

- [ ] **Step 1: Write the failing test**

```typescript
// src/fly/helpers.test.ts
import { describe, it, expect } from 'vitest';
import { generateTestAppName, parseTestStartArgs, redactToken } from './helpers';

describe('generateTestAppName', () => {
  it('uses prefix and 6-char id', () => {
    expect(generateTestAppName(() => 'abc123')).toBe('claudegram-test-abc123');
  });
  it('matches the expected shape with real randomness', () => {
    expect(generateTestAppName()).toMatch(/^claudegram-test-[a-z0-9]{6}$/);
  });
});

describe('parseTestStartArgs', () => {
  it('empty -> default port, no path', () => {
    expect(parseTestStartArgs('', 8080)).toEqual({ path: undefined, port: 8080 });
  });
  it('path only', () => {
    expect(parseTestStartArgs('myapp', 8080)).toEqual({ path: 'myapp', port: 8080 });
  });
  it('path + port', () => {
    expect(parseTestStartArgs('myapp 3000', 8080)).toEqual({ path: 'myapp', port: 3000 });
  });
  it('port only (numeric first token treated as port, no path)', () => {
    expect(parseTestStartArgs('3000', 8080)).toEqual({ path: undefined, port: 3000 });
  });
});

describe('redactToken', () => {
  it('redacts every occurrence', () => {
    expect(redactToken('a SECRET b SECRET', 'SECRET')).toBe('a *** b ***');
  });
  it('no-op when token undefined/empty', () => {
    expect(redactToken('hello', undefined)).toBe('hello');
    expect(redactToken('hello', '')).toBe('hello');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/fly/helpers.test.ts`
Expected: FAIL — cannot find module `./helpers`.

- [ ] **Step 3: Write the implementation**

```typescript
// src/fly/helpers.ts

/** Random 6-char lowercase alphanumeric id. */
function randomId(): string {
  return Math.random().toString(36).slice(2, 8).padEnd(6, '0');
}

export function generateTestAppName(rand: () => string = randomId): string {
  return `claudegram-test-${rand()}`;
}

export function parseTestStartArgs(
  argString: string,
  defaultPort: number,
): { path?: string; port: number } {
  const tokens = argString.trim().split(/\s+/).filter(Boolean);
  const isPort = (t: string) => /^\d+$/.test(t);

  if (tokens.length === 0) return { path: undefined, port: defaultPort };
  // Single numeric token = port (no path); otherwise first token is the path.
  if (tokens.length === 1 && isPort(tokens[0])) {
    return { path: undefined, port: parseInt(tokens[0], 10) };
  }
  const path = tokens[0];
  const last = tokens[tokens.length - 1];
  const port = tokens.length > 1 && isPort(last) ? parseInt(last, 10) : defaultPort;
  return { path, port };
}

export function redactToken(text: string, token?: string): string {
  if (!token) return text;
  return text.split(token).join('***');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/fly/helpers.test.ts`
Expected: PASS (all 8 cases).

- [ ] **Step 5: Commit**

```bash
git add src/fly/helpers.ts src/fly/helpers.test.ts
git commit -m "feat: pure helpers for Fly test-env (args, app name, token redaction)"
```

---

### Task 3: Test-env state — single-slot persisted tracker

**Files:**
- Create: `src/fly/test-env.ts`
- Test: `src/fly/test-env.test.ts`

**Interfaces:**
- Consumes: `atomicWriteFileSync` from `src/utils/atomic-write.js`.
- Produces:
  - `type TestEnv = { appName: string; url: string; targetDir: string; port: number; startedAt: number }`
  - `getTestEnv(): TestEnv | null`
  - `setTestEnv(env: TestEnv): void`
  - `clearTestEnv(): void`
  - `testEnvStatePath(): string` — `<WORKSPACE_DIR>/.claudegram/test-env.json` (exported for tests).

Persistence: state file under `getWorkspaceRoot()` (from `src/utils/workspace-guard.js`). In-memory cache loaded lazily on first `getTestEnv`. `setTestEnv`/`clearTestEnv` update cache **and** disk. Disk errors are caught and logged via `sanitizeError`, never thrown (state must never wedge the command).

- [ ] **Step 1: Write the failing test**

```typescript
// src/fly/test-env.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-testenv-'));
  process.env.WORKSPACE_DIR = tmp;
  vi.resetModules();
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  delete process.env.WORKSPACE_DIR;
});

describe('test-env state', () => {
  it('starts empty', async () => {
    const m = await import('./test-env');
    expect(m.getTestEnv()).toBeNull();
  });

  it('set then get returns the env', async () => {
    const m = await import('./test-env');
    const env = { appName: 'claudegram-test-abc123', url: 'https://x.fly.dev', targetDir: tmp, port: 8080, startedAt: 1 };
    m.setTestEnv(env);
    expect(m.getTestEnv()).toEqual(env);
  });

  it('persists across module reloads (reads from disk)', async () => {
    const m1 = await import('./test-env');
    const env = { appName: 'claudegram-test-abc123', url: 'https://x.fly.dev', targetDir: tmp, port: 8080, startedAt: 1 };
    m1.setTestEnv(env);
    vi.resetModules();
    const m2 = await import('./test-env');
    expect(m2.getTestEnv()).toEqual(env);
  });

  it('clear removes state and file', async () => {
    const m = await import('./test-env');
    m.setTestEnv({ appName: 'a', url: 'u', targetDir: tmp, port: 8080, startedAt: 1 });
    m.clearTestEnv();
    expect(m.getTestEnv()).toBeNull();
    expect(fs.existsSync(m.testEnvStatePath())).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/fly/test-env.test.ts`
Expected: FAIL — cannot find module `./test-env`.

- [ ] **Step 3: Write the implementation**

```typescript
// src/fly/test-env.ts
import * as fs from 'fs';
import * as path from 'path';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { getWorkspaceRoot } from '../utils/workspace-guard.js';
import { sanitizeError } from '../utils/sanitize.js';

export type TestEnv = {
  appName: string;
  url: string;
  targetDir: string;
  port: number;
  startedAt: number;
};

export function testEnvStatePath(): string {
  return path.join(getWorkspaceRoot(), '.claudegram', 'test-env.json');
}

let cache: TestEnv | null | undefined; // undefined = not loaded yet

function load(): TestEnv | null {
  try {
    const raw = fs.readFileSync(testEnvStatePath(), 'utf8');
    const parsed = JSON.parse(raw) as TestEnv;
    if (parsed && typeof parsed.appName === 'string') return parsed;
    return null;
  } catch {
    return null; // missing or corrupt -> treat as empty
  }
}

export function getTestEnv(): TestEnv | null {
  if (cache === undefined) cache = load();
  return cache;
}

export function setTestEnv(env: TestEnv): void {
  cache = env;
  try {
    const file = testEnvStatePath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    atomicWriteFileSync(file, JSON.stringify(env, null, 2));
  } catch (err) {
    console.error('[TestEnv] Failed to persist state:', sanitizeError(err));
  }
}

export function clearTestEnv(): void {
  cache = null;
  try {
    fs.rmSync(testEnvStatePath(), { force: true });
  } catch (err) {
    console.error('[TestEnv] Failed to clear state:', sanitizeError(err));
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/fly/test-env.test.ts`
Expected: PASS (4 cases).

- [ ] **Step 5: Commit**

```bash
git add src/fly/test-env.ts src/fly/test-env.test.ts
git commit -m "feat: persisted single-slot test-env state tracker"
```

---

### Task 4: flyctl wrapper — deploy / destroy / appExists

**Files:**
- Create: `src/fly/flyctl.ts`
- Test: `src/fly/flyctl.test.ts`

**Interfaces:**
- Consumes: `config.FLY_API_TOKEN` from `src/config.js`; `redactToken` from `./helpers.js`; `sanitizeError` from `src/utils/sanitize.js`.
- Produces:
  - `type DeployOptions = { appName: string; dir: string; port: number; region: string; org: string; onProgress?: (line: string) => void }`
  - `deployApp(opts: DeployOptions): Promise<{ url: string }>`
  - `destroyApp(appName: string): Promise<void>`
  - `appExists(appName: string): Promise<boolean>`
  - `buildFlyToml(appName: string, region: string, port: number): string` — exported pure helper (unit-tested).
  - `runFly(args: string[], opts: { cwd?: string; onProgress?: (line: string) => void }): Promise<{ code: number; stdout: string; stderr: string }>` — exported for handler error reporting; spawns `fly` with `FLY_API_TOKEN` in env, redacts the token from captured streams.

Notes for the implementer:
- Spawn the `fly` binary via `child_process.spawn('fly', args, { cwd, env: { ...process.env, FLY_API_TOKEN: config.FLY_API_TOKEN } })`. Never put the token in `args`.
- Stream `stdout`/`stderr` line-by-line to `onProgress` (after `redactToken`). Accumulate redacted output for the resolved result.
- `deployApp`: write `buildFlyToml(...)` to `<dir>/.fly-test.toml`; run `fly apps create <appName> -o <org>` then `fly deploy --app <appName> --config <dir>/.fly-test.toml --remote-only --yes`. On non-zero exit, throw `Error` with redacted stderr. Return `{ url: \`https://\${appName}.fly.dev\` }`.
- `destroyApp`: `fly apps destroy <appName> --yes`. Throw on non-zero exit (handler decides whether to swallow).
- `appExists`: `fly status --app <appName>`; resolve `true` on exit 0, `false` otherwise.
- Only `buildFlyToml` is unit-tested here (spawning real `fly` is out of scope for unit tests); the spawn paths are covered by manual verification in Task 9.

- [ ] **Step 1: Write the failing test**

```typescript
// src/fly/flyctl.test.ts
import { describe, it, expect } from 'vitest';
import { buildFlyToml } from './flyctl';

describe('buildFlyToml', () => {
  it('includes app name, region, and http_service port', () => {
    const toml = buildFlyToml('claudegram-test-abc123', 'lax', 3000);
    expect(toml).toContain('app = "claudegram-test-abc123"');
    expect(toml).toContain('primary_region = "lax"');
    expect(toml).toContain('internal_port = 3000');
    expect(toml).toContain('force_https = true');
    expect(toml).toContain('[http_service]');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/fly/flyctl.test.ts`
Expected: FAIL — cannot find module `./flyctl`.

- [ ] **Step 3: Write the implementation**

```typescript
// src/fly/flyctl.ts
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { config } from '../config.js';
import { redactToken } from './helpers.js';

export type DeployOptions = {
  appName: string;
  dir: string;
  port: number;
  region: string;
  org: string;
  onProgress?: (line: string) => void;
};

export function buildFlyToml(appName: string, region: string, port: number): string {
  return [
    `app = "${appName}"`,
    `primary_region = "${region}"`,
    '',
    '[http_service]',
    `  internal_port = ${port}`,
    '  force_https = true',
    '  auto_stop_machines = true',
    '  auto_start_machines = true',
    '  min_machines_running = 0',
    '',
  ].join('\n');
}

export function runFly(
  args: string[],
  opts: { cwd?: string; onProgress?: (line: string) => void } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const token = config.FLY_API_TOKEN;
    const child = spawn('fly', args, {
      cwd: opts.cwd,
      env: { ...process.env, FLY_API_TOKEN: token },
    });
    let stdout = '';
    let stderr = '';
    const onChunk = (buf: Buffer, sink: 'out' | 'err') => {
      const text = redactToken(buf.toString(), token);
      if (sink === 'out') stdout += text; else stderr += text;
      if (opts.onProgress) {
        for (const line of text.split('\n')) {
          if (line.trim()) opts.onProgress(line.trim());
        }
      }
    };
    child.stdout.on('data', (b) => onChunk(b, 'out'));
    child.stderr.on('data', (b) => onChunk(b, 'err'));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

export async function deployApp(opts: DeployOptions): Promise<{ url: string }> {
  const { appName, dir, port, region, org, onProgress } = opts;

  // Reuse the project's own fly.toml if present; `--app <appName>` overrides the
  // `app` field on the CLI so we never mutate the user's file. Otherwise generate
  // a throwaway config in the repo. Either way the app name comes from <appName>.
  const ownConfig = path.join(dir, 'fly.toml');
  let configPath: string;
  if (fs.existsSync(ownConfig)) {
    configPath = ownConfig;
  } else {
    configPath = path.join(dir, '.fly-test.toml');
    fs.writeFileSync(configPath, buildFlyToml(appName, region, port));
  }

  const create = await runFly(['apps', 'create', appName, '-o', org], { cwd: dir, onProgress });
  if (create.code !== 0) {
    throw new Error(`fly apps create failed: ${create.stderr || create.stdout}`);
  }

  const deploy = await runFly(
    ['deploy', '--app', appName, '--config', configPath, '--remote-only', '--yes'],
    { cwd: dir, onProgress },
  );
  if (deploy.code !== 0) {
    throw new Error(`fly deploy failed: ${deploy.stderr || deploy.stdout}`);
  }
  return { url: `https://${appName}.fly.dev` };
}

export async function destroyApp(appName: string): Promise<void> {
  const res = await runFly(['apps', 'destroy', appName, '--yes']);
  if (res.code !== 0) {
    throw new Error(`fly apps destroy failed: ${res.stderr || res.stdout}`);
  }
}

export async function appExists(appName: string): Promise<boolean> {
  const res = await runFly(['status', '--app', appName]);
  return res.code === 0;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/fly/flyctl.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/fly/flyctl.ts src/fly/flyctl.test.ts
git commit -m "feat: flyctl wrapper (deploy/destroy/status) with token redaction"
```

---

### Task 5: Command handlers — /teststart, /teststop, /teststatus

**Files:**
- Modify: `src/bot/handlers/command.handler.ts` (add three exported handlers near `handleRestartBot` ~line 1324; add imports at top)
- Test: `src/fly/resolve-target.ts` (create — extracted testable helper) + `src/fly/resolve-target.test.ts` (create)

**Interfaces:**
- Consumes: `getTestEnv`, `setTestEnv`, `clearTestEnv` from `src/fly/test-env.js`; `deployApp`, `destroyApp` from `src/fly/flyctl.js`; `generateTestAppName`, `parseTestStartArgs` from `src/fly/helpers.js`; `resolvePathWithinRoot`, `getWorkspaceRoot` from `src/utils/workspace-guard.js`; `sessionManager`, `getSessionKeyFromCtx`, `config`, `replyMd`, `esc`, `sanitizeError` (already imported in the handler file).
- Produces (in `resolve-target.ts`):
  - `resolveTargetDir(args: { pathArg?: string; sessionDir?: string; root: string }): { dir: string } | { error: string }` — if `pathArg` given, return `resolvePathWithinRoot(root, join(root, pathArg))` or an error; else use `sessionDir` if set, else error "No active project".
- Produces (in handler): `handleTestStart`, `handleTestStop`, `handleTestStatus` (each `(ctx: Context) => Promise<void>`).

- [ ] **Step 1: Write the failing test (pure target resolver)**

```typescript
// src/fly/resolve-target.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { resolveTargetDir } from './resolve-target';

let root: string;
beforeEach(() => { root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-tgt-'))); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

describe('resolveTargetDir', () => {
  it('uses sessionDir when no path arg', () => {
    const sessionDir = fs.realpathSync(fs.mkdtempSync(path.join(root, 'proj-')));
    expect(resolveTargetDir({ sessionDir, root })).toEqual({ dir: sessionDir });
  });
  it('errors when neither path nor session', () => {
    expect(resolveTargetDir({ root })).toHaveProperty('error');
  });
  it('resolves a valid path arg within root', () => {
    fs.mkdirSync(path.join(root, 'myapp'));
    expect(resolveTargetDir({ pathArg: 'myapp', root })).toEqual({ dir: path.join(root, 'myapp') });
  });
  it('rejects traversal outside root', () => {
    expect(resolveTargetDir({ pathArg: '../../etc', root })).toHaveProperty('error');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/fly/resolve-target.test.ts`
Expected: FAIL — cannot find module `./resolve-target`.

- [ ] **Step 3a: Write the resolver**

```typescript
// src/fly/resolve-target.ts
import * as path from 'path';
import { resolvePathWithinRoot } from '../utils/workspace-guard.js';

export function resolveTargetDir(args: {
  pathArg?: string;
  sessionDir?: string;
  root: string;
}): { dir: string } | { error: string } {
  const { pathArg, sessionDir, root } = args;
  if (pathArg) {
    const resolved = resolvePathWithinRoot(root, path.join(root, pathArg));
    if (!resolved) return { error: `Path \`${pathArg}\` is outside the workspace or does not exist.` };
    return { dir: resolved };
  }
  if (sessionDir) return { dir: sessionDir };
  return { error: 'No active project. Open one with /project or pass a path: `/teststart <path>`.' };
}
```

- [ ] **Step 3b: Add handler imports**

At the top of `src/bot/handlers/command.handler.ts`, add:

```typescript
import { getTestEnv, setTestEnv, clearTestEnv } from '../../fly/test-env.js';
import { deployApp, destroyApp } from '../../fly/flyctl.js';
import { generateTestAppName, parseTestStartArgs } from '../../fly/helpers.js';
import { resolveTargetDir } from '../../fly/resolve-target.js';
import { getWorkspaceRoot } from '../../utils/workspace-guard.js';
```

(`fs`, `path`, `os`, `sessionManager`, `getSessionKeyFromCtx`, `config`, `esc`, `sanitizeError`, `replyMd` are already imported.)

- [ ] **Step 3c: Add the three handlers** (place after `handleRestartCallback`, before `handleCancel`)

```typescript
export async function handleTestStart(ctx: Context): Promise<void> {
  if (!config.FLY_API_TOKEN) {
    await replyMd(ctx, '❌ Fly API token not configured\\. Set `FLY_API_TOKEN` via `fly secrets set`\\.');
    return;
  }

  const existing = getTestEnv();
  if (existing) {
    await replyMd(ctx, `ℹ️ A test environment is already running:\n${esc(existing.url)}\n\nUse /teststop first\\.`);
    return;
  }

  const root = getWorkspaceRoot();
  const sessionKey = getSessionKeyFromCtx(ctx)?.sessionKey;
  const sessionDir = sessionKey ? sessionManager.getSession(sessionKey)?.workingDirectory : undefined;
  const argString = (ctx.match as string | undefined)?.trim() ?? '';
  const { path: pathArg, port } = parseTestStartArgs(argString, config.FLY_TEST_DEFAULT_PORT);

  const resolved = resolveTargetDir({ pathArg, sessionDir, root });
  if ('error' in resolved) {
    await replyMd(ctx, `❌ ${esc(resolved.error)}`);
    return;
  }
  const dir = resolved.dir;

  if (!fs.existsSync(path.join(dir, 'Dockerfile'))) {
    await replyMd(ctx, '❌ No `Dockerfile` in the target project\\. Ask the agent to add one, then retry\\.');
    return;
  }

  const appName = generateTestAppName();
  await replyMd(ctx, `🚀 Deploying \`${esc(path.basename(dir))}\` to \`${esc(appName)}\`\\.\n\n⏳ This can take a few minutes\\.`);

  const TIMEOUT_MS = 10 * 60 * 1000;
  try {
    const result = await Promise.race([
      deployApp({ appName, dir, port, region: config.FLY_TEST_REGION, org: config.FLY_TEST_ORG }),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error('Deploy timed out after 10 minutes')), TIMEOUT_MS)),
    ]);
    setTestEnv({ appName, url: result.url, targetDir: dir, port, startedAt: Date.now() });
    await replyMd(ctx, `✅ Test environment ready:\n${esc(result.url)}\n\nUse /teststop to tear it down\\.`);
  } catch (err) {
    console.error('[TestStart] Deploy failed:', sanitizeError(err));
    try { await destroyApp(appName); } catch (e) { console.error('[TestStart] Cleanup failed:', sanitizeError(e)); }
    await replyMd(ctx, `❌ Deploy failed:\n\`${esc(sanitizeError(err))}\``);
  }
}

export async function handleTestStop(ctx: Context): Promise<void> {
  const env = getTestEnv();
  if (!env) {
    await replyMd(ctx, 'ℹ️ No active test environment\\.');
    return;
  }
  await replyMd(ctx, `🧹 Destroying \`${esc(env.appName)}\`\\.\\.\\.`);
  try {
    await destroyApp(env.appName);
    clearTestEnv();
    await replyMd(ctx, '✅ Test environment destroyed\\.');
  } catch (err) {
    console.error('[TestStop] Destroy failed:', sanitizeError(err));
    clearTestEnv(); // never let local state wedge
    await replyMd(ctx, `⚠️ Destroy reported an error \\(local state cleared\\):\n\`${esc(sanitizeError(err))}\``);
  }
}

export async function handleTestStatus(ctx: Context): Promise<void> {
  const env = getTestEnv();
  if (!env) {
    await replyMd(ctx, 'ℹ️ No active test environment\\. Start one with /teststart\\.');
    return;
  }
  const mins = Math.round((Date.now() - env.startedAt) / 60000);
  await replyMd(
    ctx,
    `🧪 *Test environment active*\n\n*App:* \`${esc(env.appName)}\`\n*URL:* ${esc(env.url)}\n*Uptime:* ${mins} min`,
  );
}
```

- [ ] **Step 4: Run resolver test + typecheck**

Run: `npx vitest run src/fly/resolve-target.test.ts && npm run build`
Expected: tests PASS; `npm run build` (tsc) completes with no errors.

- [ ] **Step 5: Commit**

```bash
git add src/fly/resolve-target.ts src/fly/resolve-target.test.ts src/bot/handlers/command.handler.ts
git commit -m "feat: /teststart /teststop /teststatus handlers"
```

---

### Task 6: Register commands in bot.ts

**Files:**
- Modify: `src/bot/bot.ts` (import block ~line 24, registration block ~line 173 near `restartbot`)

**Interfaces:**
- Consumes: `handleTestStart`, `handleTestStop`, `handleTestStatus` from Task 5.

- [ ] **Step 1: Add imports**

In the `import { ... } from '.../command.handler.js'` block in `src/bot/bot.ts`, add:

```typescript
  handleTestStart,
  handleTestStop,
  handleTestStatus,
```

- [ ] **Step 2: Register commands** (after `bot.command('restartbot', handleRestartBot);`)

```typescript
  bot.command('teststart', handleTestStart);
  bot.command('teststop', handleTestStop);
  bot.command('teststatus', handleTestStatus);
```

- [ ] **Step 3: Verify build**

Run: `npm run build`
Expected: tsc completes, no errors.

- [ ] **Step 4: Commit**

```bash
git add src/bot/bot.ts
git commit -m "feat: register test-env commands"
```

---

### Task 7: Bundle flyctl in the Docker image

**Files:**
- Modify: `Dockerfile` (runtime stage `apt-get install` block + add flyctl install)

**Interfaces:** none (infra).

- [ ] **Step 1: Add flyctl install to the runtime stage**

In `Dockerfile`, in the **runtime** stage, after the existing `apt-get install ... yt-dlp ...` block and before switching to the `node` user, add:

```dockerfile
# flyctl: lets the in-container agent deploy ephemeral test apps (/teststart).
# Installs to /root/.fly; expose it on PATH for all users.
RUN curl -L https://fly.io/install.sh | sh
ENV FLYCTL_INSTALL="/root/.fly"
ENV PATH="$FLYCTL_INSTALL/bin:$PATH"
```

(If `curl` is not already installed in the runtime stage, add `curl` to the `apt-get install` package list in the same stage.)

- [ ] **Step 2: Verify the Dockerfile builds the flyctl layer**

Run: `docker build -t claudegram-flytest . 2>&1 | tail -20` (this builds the final/runtime stage by default; if Docker is unavailable locally, defer to the Task 9 deploy verification). Then confirm: `docker run --rm --entrypoint fly claudegram-flytest version`
Expected: prints a `flyctl` version string.

- [ ] **Step 3: Commit**

```bash
git add Dockerfile
git commit -m "build: bundle flyctl for ephemeral test deploys"
```

---

### Task 8: Update docs/index.html (MANDATORY per CLAUDE.md)

**Files:**
- Modify: `docs/index.html` (features grid + commands grid)

**Interfaces:** none.

- [ ] **Step 1: Add the feature card**

In the features grid, add a card with `data-category="session"`:

```html
<div class="feature-card" data-category="session">
  <div class="feature-icon">🧪</div>
  <h3>Test Environments</h3>
  <p>Spin up ephemeral Fly.io containers for live testing, get a shareable URL, and tear them down — all from Telegram.</p>
</div>
```

- [ ] **Step 2: Add the three command rows**

In the appropriate category section of the commands grid (session/management):

```html
<div class="command-row">
  <code class="command-code">/teststart &lt;path&gt; &lt;port&gt;</code>
  <span class="command-desc">Deploy a workspace project as an ephemeral Fly.io test app and return its URL</span>
</div>
<div class="command-row">
  <code class="command-code">/teststop</code>
  <span class="command-desc">Destroy the active test app</span>
</div>
<div class="command-row">
  <code class="command-code">/teststatus</code>
  <span class="command-desc">Show whether a test environment is running and its URL</span>
</div>
```

- [ ] **Step 3: Verify the additions are present**

Run: `grep -c 'teststart\|teststop\|teststatus' docs/index.html`
Expected: `3` (or more if `/teststart` appears in surrounding copy).

- [ ] **Step 4: Commit**

```bash
git add docs/index.html
git commit -m "docs: add test-environment feature card and commands"
```

---

### Task 9: Full-suite verification

- [ ] **Step 1: Run the whole test suite**

Run: `npx vitest run`
Expected: all tests pass, including the new `src/fly/*.test.ts` and `src/config.fly.test.ts`.

- [ ] **Step 2: Typecheck/build**

Run: `npm run build`
Expected: tsc completes with no errors.

- [ ] **Step 3: Manual smoke (deploy-time, requires Fly access)**

This exercises the spawn paths that unit tests intentionally skip. On a machine with `fly` on PATH and `FLY_API_TOKEN` set, in a Telegram chat:
1. `/clone` a small repo that has a `Dockerfile` exposing port 8080.
2. `/teststart` → expect "Deploying…" then a `https://claudegram-test-<id>.fly.dev` URL; open it.
3. `/teststatus` → shows the app + URL + uptime.
4. `/teststop` → "destroyed"; `/teststatus` → "No active test environment".
5. Confirm `fly apps list` no longer shows the test app.

- [ ] **Step 4: No commit** (verification only).
