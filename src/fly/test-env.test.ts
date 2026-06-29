import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-testenv-'));
  process.env.WORKSPACE_DIR = tmp;
  process.env.TELEGRAM_BOT_TOKEN ||= 'test-token';
  process.env.ALLOWED_USER_IDS ||= '1';
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
