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
