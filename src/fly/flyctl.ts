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
  signal?: AbortSignal;
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
  opts: { cwd?: string; onProgress?: (line: string) => void; signal?: AbortSignal } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const token = config.FLY_API_TOKEN;
    const child = spawn('fly', args, {
      cwd: opts.cwd,
      env: { ...process.env, FLY_API_TOKEN: token },
    });
    const onAbort = () => {
      try { child.kill('SIGTERM'); } catch { /* already gone */ }
    };
    if (opts.signal) {
      if (opts.signal.aborted) onAbort();
      else opts.signal.addEventListener('abort', onAbort, { once: true });
    }
    const cleanup = () => {
      if (opts.signal) opts.signal.removeEventListener('abort', onAbort);
    };
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
    child.on('error', (err) => { cleanup(); reject(err); });
    child.on('close', (code) => { cleanup(); resolve({ code: code ?? 1, stdout, stderr }); });
  });
}

export async function deployApp(opts: DeployOptions): Promise<{ url: string }> {
  const { appName, dir, port, region, org, onProgress, signal } = opts;

  // Reuse the project's own fly.toml if present; `--app <appName>` overrides the
  // `app` field on the CLI so we never mutate the user's file. Otherwise generate
  // a throwaway config and remove it afterward so it never lingers in the repo.
  // NOTE: when the project ships its own fly.toml, that file governs the service
  // port; the /teststart port arg is intentionally not injected here.
  const ownConfig = path.join(dir, 'fly.toml');
  const usesOwnConfig = fs.existsSync(ownConfig);
  const configPath = usesOwnConfig ? ownConfig : path.join(dir, '.fly-test.toml');
  if (!usesOwnConfig) {
    fs.writeFileSync(configPath, buildFlyToml(appName, region, port));
  }

  try {
    const create = await runFly(['apps', 'create', appName, '-o', org], { cwd: dir, onProgress, signal });
    if (create.code !== 0) {
      throw new Error(redactToken(`fly apps create failed: ${create.stderr || create.stdout}`, config.FLY_API_TOKEN));
    }

    const deploy = await runFly(
      ['deploy', '--app', appName, '--config', configPath, '--remote-only', '--yes'],
      { cwd: dir, onProgress, signal },
    );
    if (deploy.code !== 0) {
      throw new Error(redactToken(`fly deploy failed: ${deploy.stderr || deploy.stdout}`, config.FLY_API_TOKEN));
    }
    return { url: `https://${appName}.fly.dev` };
  } finally {
    if (!usesOwnConfig) {
      try { fs.rmSync(configPath, { force: true }); } catch { /* best-effort cleanup */ }
    }
  }
}

export async function destroyApp(appName: string): Promise<void> {
  const res = await runFly(['apps', 'destroy', appName, '--yes']);
  if (res.code !== 0) {
    const combined = `${res.stderr}\n${res.stdout}`;
    // An app that doesn't exist is already in the desired state — treat as success
    // so timeout/restart cleanup never throws on a never-created app.
    if (/not\s+found|could\s+not\s+find|does\s+not\s+exist|no\s+such/i.test(combined)) {
      return;
    }
    throw new Error(redactToken(`fly apps destroy failed: ${res.stderr || res.stdout}`, config.FLY_API_TOKEN));
  }
}
