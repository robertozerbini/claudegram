import * as path from 'path';
import { resolvePathWithinRoot } from '../utils/workspace-guard.js';

export function resolveTargetDir(args: {
  pathArg?: string;
  sessionDir?: string;
  root: string;
}): { dir: string } | { error: string } {
  const { pathArg, sessionDir, root } = args;
  if (pathArg) {
    const resolved = resolvePathWithinRoot(root, path.join(root, pathArg));
    if (!resolved) return { error: `Path \`${pathArg}\` is outside the workspace or does not exist.` };
    return { dir: resolved };
  }
  if (sessionDir) return { dir: sessionDir };
  return { error: 'No active project. Open one with /project or pass a path: `/teststart <path>`.' };
}
