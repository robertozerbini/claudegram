import type { Repo } from '../git/github.js';

export interface RepoPickerState {
  repos: Repo[];
  page: number;
}

export const PAGE_SIZE = 8;

// Self-contained label truncation so this module stays pure/testable
// without importing the bot's command handler.
function truncateLabel(name: string, max = 24): string {
  return name.length <= max ? name : `${name.slice(0, max - 1)}…`;
}

export function buildRepoPickerKeyboard(
  state: RepoPickerState,
): { inline_keyboard: { text: string; callback_data: string }[][] } {
  const { repos, page } = state;
  const totalPages = Math.max(1, Math.ceil(repos.length / PAGE_SIZE));
  const start = page * PAGE_SIZE;
  const slice = repos.slice(start, start + PAGE_SIZE);

  const rows: { text: string; callback_data: string }[][] = [];
  slice.forEach((repo, i) => {
    const index = start + i;
    const icon = repo.private ? '🔒' : '📂';
    rows.push([{ text: `${icon} ${truncateLabel(repo.name)}`, callback_data: `repo:open:${index}` }]);
  });

  const nav: { text: string; callback_data: string }[] = [];
  if (page > 0) nav.push({ text: '◀️ Prev', callback_data: 'repo:page:prev' });
  if (page < totalPages - 1) nav.push({ text: 'Next ▶️', callback_data: 'repo:page:next' });
  if (nav.length > 0) rows.push(nav);

  rows.push([{ text: '🔄 Refresh', callback_data: 'repo:refresh' }]);
  return { inline_keyboard: rows };
}
