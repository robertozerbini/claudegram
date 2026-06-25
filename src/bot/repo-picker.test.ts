import { describe, it, expect } from 'vitest';
import { buildRepoPickerKeyboard, RepoPickerState } from './repo-picker';
import type { Repo } from '../git/github';

function repo(name: string, priv = false): Repo {
  return { name, fullName: `me/${name}`, private: priv, cloneUrl: `https://github.com/me/${name}.git`, pushedAt: '2026-01-01T00:00:00Z' };
}
function repos(n: number): Repo[] {
  return Array.from({ length: n }, (_, i) => repo(`r${i}`, i % 2 === 0));
}

describe('buildRepoPickerKeyboard', () => {
  it('page 0 of 20: 8 repo rows + Next-only nav + Refresh', () => {
    const rows = buildRepoPickerKeyboard({ repos: repos(20), page: 0 }).inline_keyboard;
    expect(rows).toHaveLength(10); // 8 repos + nav + refresh
    expect(rows[0][0].callback_data).toBe('repo:open:0');
    expect(rows[8].map(b => b.callback_data)).toEqual(['repo:page:next']);
    expect(rows[9][0].callback_data).toBe('repo:refresh');
  });

  it('last page: Prev-only nav and page-absolute indices', () => {
    const rows = buildRepoPickerKeyboard({ repos: repos(20), page: 2 }).inline_keyboard; // repos 16..19
    expect(rows[0][0].callback_data).toBe('repo:open:16');
    expect(rows).toHaveLength(6); // 4 repos + nav + refresh
    expect(rows[4].map(b => b.callback_data)).toEqual(['repo:page:prev']);
  });

  it('single page: no nav row', () => {
    const rows = buildRepoPickerKeyboard({ repos: repos(5), page: 0 }).inline_keyboard;
    expect(rows).toHaveLength(6); // 5 repos + refresh, no nav
    expect(rows[5][0].callback_data).toBe('repo:refresh');
  });

  it('private repos show 🔒 and public show 📂', () => {
    const rows = buildRepoPickerKeyboard({ repos: [repo('priv', true), repo('pub', false)], page: 0 }).inline_keyboard;
    expect(rows[0][0].text).toContain('🔒');
    expect(rows[1][0].text).toContain('📂');
  });
});
