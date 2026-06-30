import { describe, it, expect } from 'vitest';

describe('fly config', () => {
  it('exposes fly test env fields with defaults', async () => {
    process.env.TELEGRAM_BOT_TOKEN ||= 'x';
    process.env.ALLOWED_USER_IDS ||= '1';
    delete process.env.FLY_API_TOKEN;
    delete process.env.FLYIO_DEPLOYMENT;
    const { config } = await import('./config.js');
    expect(config.FLY_TEST_ORG).toBe('personal');
    expect(config.FLY_TEST_DEFAULT_PORT).toBe(8080);
    expect(config.FLY_TEST_REGION).toBe('lax');
    expect(config.FLY_API_TOKEN).toBeUndefined();
  });

  it('falls back to FLYIO_DEPLOYMENT when FLY_API_TOKEN is unset', async () => {
    const { vi } = await import('vitest');
    vi.resetModules();
    process.env.TELEGRAM_BOT_TOKEN ||= 'x';
    process.env.ALLOWED_USER_IDS ||= '1';
    delete process.env.FLY_API_TOKEN;
    process.env.FLYIO_DEPLOYMENT = 'tok_from_alias';
    const { config } = await import('./config.js');
    expect(config.FLY_API_TOKEN).toBe('tok_from_alias');
    delete process.env.FLYIO_DEPLOYMENT;
  });
});
