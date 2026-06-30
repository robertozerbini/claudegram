import { describe, it, expect } from 'vitest';

describe('fly config', () => {
  it('exposes fly test env fields with defaults', async () => {
    process.env.TELEGRAM_BOT_TOKEN ||= 'x';
    process.env.ALLOWED_USER_IDS ||= '1';
    delete process.env.FLY_API_TOKEN;
    const { config } = await import('./config.js');
    expect(config.FLY_TEST_ORG).toBe('personal');
    expect(config.FLY_TEST_DEFAULT_PORT).toBe(8080);
    expect(config.FLY_TEST_REGION).toBe('lax');
    expect(config.FLY_API_TOKEN).toBeUndefined();
  });
});
