import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

let root: string;
beforeEach(() => {
  process.env.TELEGRAM_BOT_TOKEN ||= 'test-token';
  process.env.ALLOWED_USER_IDS ||= '1';
  vi.resetModules();
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-tgt-')));
});
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

describe('resolveTargetDir', () => {
  it('uses sessionDir when no path arg', async () => {
    const { resolveTargetDir } = await import('./resolve-target');
    const sessionDir = fs.realpathSync(fs.mkdtempSync(path.join(root, 'proj-')));
    expect(resolveTargetDir({ sessionDir, root })).toEqual({ dir: sessionDir });
  });
  it('errors when neither path nor session', async () => {
    const { resolveTargetDir } = await import('./resolve-target');
    expect(resolveTargetDir({ root })).toHaveProperty('error');
  });
  it('resolves a valid path arg within root', async () => {
    const { resolveTargetDir } = await import('./resolve-target');
    fs.mkdirSync(path.join(root, 'myapp'));
    expect(resolveTargetDir({ pathArg: 'myapp', root })).toEqual({ dir: path.join(root, 'myapp') });
  });
  it('rejects traversal outside root', async () => {
    const { resolveTargetDir } = await import('./resolve-target');
    expect(resolveTargetDir({ pathArg: '../../etc', root })).toHaveProperty('error');
  });
});
