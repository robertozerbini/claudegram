// Pure helpers for the /clone command. No side effects, no relative imports —
// kept isolated so the URL/auth/sanitizing logic is unit-testable.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** Last path segment of a git URL with one trailing `.git` removed. */
export function deriveProjectName(gitUrl: string): string {
  let pathname: string;
  try {
    pathname = new URL(gitUrl.trim()).pathname;
  } catch {
    const cleaned = gitUrl.trim().replace(/\/+$/, '');
    const lastSlash = cleaned.lastIndexOf('/');
    pathname = lastSlash >= 0 ? cleaned.slice(lastSlash + 1) : '';
    return pathname.replace(/\.git$/, '');
  }
  const cleaned = pathname.replace(/\/+$/, '');
  const lastSlash = cleaned.lastIndexOf('/');
  const segment = lastSlash >= 0 ? cleaned.slice(lastSlash + 1) : cleaned;
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
  out = out.replace(/Bearer\s+\S+/gi, 'Bearer ***');
  return out.trim();
}

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
