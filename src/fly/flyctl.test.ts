import { describe, it, expect, beforeEach, vi } from 'vitest';

beforeEach(() => {
  process.env.TELEGRAM_BOT_TOKEN ||= 'test-token';
  process.env.ALLOWED_USER_IDS ||= '1';
  vi.resetModules();
});

describe('buildFlyToml', () => {
  it('includes app name, region, and http_service port', async () => {
    const m = await import('./flyctl');
    const toml = m.buildFlyToml('claudegram-test-abc123', 'lax', 3000);
    expect(toml).toContain('app = "claudegram-test-abc123"');
    expect(toml).toContain('primary_region = "lax"');
    expect(toml).toContain('internal_port = 3000');
    expect(toml).toContain('force_https = true');
    expect(toml).toContain('[http_service]');
  });
});
