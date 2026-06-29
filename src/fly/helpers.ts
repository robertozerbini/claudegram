/** Random 6-char lowercase alphanumeric id. */
function randomId(): string {
  return Math.random().toString(36).slice(2, 8).padEnd(6, '0');
}

export function generateTestAppName(rand: () => string = randomId): string {
  return `claudegram-test-${rand()}`;
}

export function parseTestStartArgs(
  argString: string,
  defaultPort: number,
): { path?: string; port: number } {
  const tokens = argString.trim().split(/\s+/).filter(Boolean);
  const isPort = (t: string) => /^\d+$/.test(t);

  if (tokens.length === 0) return { path: undefined, port: defaultPort };
  // Single numeric token = port (no path); otherwise first token is the path.
  if (tokens.length === 1 && isPort(tokens[0])) {
    return { path: undefined, port: parseInt(tokens[0], 10) };
  }
  const path = tokens[0];
  const last = tokens[tokens.length - 1];
  const port = tokens.length > 1 && isPort(last) ? parseInt(last, 10) : defaultPort;
  return { path, port };
}

export function redactToken(text: string, token?: string): string {
  if (!token) return text;
  return text.split(token).join('***');
}
