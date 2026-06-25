import { describe, it, expect, vi, afterEach } from 'vitest';
import { listOwnedRepos } from './github';

function mockFetch(impl: (...a: unknown[]) => Promise<Response>) {
  vi.stubGlobal('fetch', vi.fn(impl));
}
afterEach(() => vi.unstubAllGlobals());

describe('listOwnedRepos', () => {
  it('parses a 200 payload, preserving order', async () => {
    mockFetch(async () => new Response(JSON.stringify([
      { name: 'foo', full_name: 'me/foo', private: true,  clone_url: 'https://github.com/me/foo.git', pushed_at: '2026-01-02T00:00:00Z' },
      { name: 'bar', full_name: 'me/bar', private: false, clone_url: 'https://github.com/me/bar.git', pushed_at: '2026-01-01T00:00:00Z' },
    ]), { status: 200 }));
    const r = await listOwnedRepos('tok');
    expect(r).toEqual({ ok: true, repos: [
      { name: 'foo', fullName: 'me/foo', private: true,  cloneUrl: 'https://github.com/me/foo.git', pushedAt: '2026-01-02T00:00:00Z' },
      { name: 'bar', fullName: 'me/bar', private: false, cloneUrl: 'https://github.com/me/bar.git', pushedAt: '2026-01-01T00:00:00Z' },
    ]});
  });

  it('returns a tokenless error on 401', async () => {
    mockFetch(async () => new Response('', { status: 401 }));
    const r = await listOwnedRepos('secret-tok');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).not.toContain('secret-tok');
      expect(r.error).toMatch(/token/i);
    }
  });

  it('returns a rate-limit message on 403', async () => {
    mockFetch(async () => new Response('', { status: 403 }));
    const r = await listOwnedRepos('tok');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/rate limit/i);
  });

  it('does not leak the token on a network error', async () => {
    mockFetch(async () => { throw new Error('boom secret-tok'); });
    const r = await listOwnedRepos('secret-tok');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).not.toContain('secret-tok');
  });

  it('returns ok:false with a friendly error when the 200 body is not an array', async () => {
    mockFetch(async () => new Response(JSON.stringify({ message: 'x' }), { status: 200 }));
    const r = await listOwnedRepos('tok');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toBeTruthy();
      expect(r.error).toMatch(/unexpected response/i);
    }
  });
});
