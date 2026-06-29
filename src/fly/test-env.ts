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
