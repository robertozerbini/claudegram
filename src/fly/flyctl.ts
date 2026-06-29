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
