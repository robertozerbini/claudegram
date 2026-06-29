import * as fs from 'fs';
import * as path from 'path';

function resolvePathWithinRoot(root: string, target: string): string | null {
  let resolvedRoot: string;
  try {
    resolvedRoot = fs.realpathSync(root);
  } catch {
    return null;
  }
  let resolved: string;
  try {
    resolved = fs.realpathSync(target);
  } catch {
    resolved = path.resolve(target);
  }
  if (resolved !== resolvedRoot && !resolved.startsWith(resolvedRoot + path.sep)) {
    return null;
  }
  return resolved;
}

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
