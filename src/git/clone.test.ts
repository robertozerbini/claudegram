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
  it('redacts a Bearer token even when token arg is undefined', () => {
    const out = sanitizeGitError(
      'fatal: unable to access: Authorization: Bearer ghp_secret123 rejected',
      undefined,
    );
    expect(out).not.toContain('ghp_secret123');
    expect(out).toContain('Bearer ***');
  });
});
