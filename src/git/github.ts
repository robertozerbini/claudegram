import { sanitizeGitError } from './clone.js';

export interface Repo {
  name: string;
  fullName: string;
  private: boolean;
  cloneUrl: string;
  pushedAt: string;
}

export type ListReposResult =
  | { ok: true; repos: Repo[] }
  | { ok: false; error: string };

interface GitHubRepoApi {
  name: string;
  full_name: string;
  private: boolean;
  clone_url: string;
  pushed_at: string;
}

export async function listOwnedRepos(token: string): Promise<ListReposResult> {
  let res: Response;
  try {
    res = await fetch(
      'https://api.github.com/user/repos?affiliation=owner&sort=pushed&per_page=100',
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'claudegram',
        },
      },
    );
  } catch (e) {
    return { ok: false, error: sanitizeGitError(`Could not reach GitHub: ${(e as Error).message}`, token) };
  }

  if (res.status === 401) {
    return { ok: false, error: 'GitHub token rejected (check GITHUB_TOKEN).' };
  }
  if (res.status === 403) {
    return { ok: false, error: 'GitHub API rate limit reached, try again later.' };
  }
  if (!res.ok) {
    return { ok: false, error: sanitizeGitError(`GitHub API error (HTTP ${res.status}).`, token) };
  }

  const data = (await res.json()) as unknown;
  if (!Array.isArray(data)) {
    return { ok: false, error: 'Unexpected response from GitHub.' };
  }
  const repos: Repo[] = (data as GitHubRepoApi[]).map((r) => ({
    name: r.name,
    fullName: r.full_name,
    private: r.private,
    cloneUrl: r.clone_url,
    pushedAt: r.pushed_at,
  }));
  return { ok: true, repos };
}
