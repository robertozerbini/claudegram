import { describe, it, expect } from 'vitest';
import { generateTestAppName, parseTestStartArgs, redactToken } from './helpers';

describe('generateTestAppName', () => {
  it('uses prefix and 6-char id', () => {
    expect(generateTestAppName(() => 'abc123')).toBe('claudegram-test-abc123');
  });
  it('matches the expected shape with real randomness', () => {
    expect(generateTestAppName()).toMatch(/^claudegram-test-[a-z0-9]{6}$/);
  });
});

describe('parseTestStartArgs', () => {
  it('empty -> default port, no path', () => {
    expect(parseTestStartArgs('', 8080)).toEqual({ path: undefined, port: 8080 });
  });
  it('path only', () => {
    expect(parseTestStartArgs('myapp', 8080)).toEqual({ path: 'myapp', port: 8080 });
  });
  it('path + port', () => {
    expect(parseTestStartArgs('myapp 3000', 8080)).toEqual({ path: 'myapp', port: 3000 });
  });
  it('port only (numeric first token treated as port, no path)', () => {
    expect(parseTestStartArgs('3000', 8080)).toEqual({ path: undefined, port: 3000 });
  });
});

describe('redactToken', () => {
  it('redacts every occurrence', () => {
    expect(redactToken('a SECRET b SECRET', 'SECRET')).toBe('a *** b ***');
  });
  it('no-op when token undefined/empty', () => {
    expect(redactToken('hello', undefined)).toBe('hello');
    expect(redactToken('hello', '')).toBe('hello');
  });
});
