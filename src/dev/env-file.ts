/**
 * `.env.local`: where persona passwords and authenticator secrets live. Git must ignore it; the seed
 * script checks before writing, keeps every other line as it was, and never prints the values.
 */
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

/** Parses `KEY=value` lines (optional `export`, quotes, and `#` comments). */
export function parseEnvFile(content: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of content.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m?.[1]) continue;
    let value = (m[2] ?? '').trim();
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.length >= 2 && value.endsWith(quote)) value = value.slice(1, -1);
    else value = value.replace(/\s+#.*$/, '');
    out.set(m[1], value);
  }
  return out;
}

const SECTION = '# auth-kit personas: test accounts in the sandbox pool only. Never real credentials. Written by `npx auth-kit seed-personas`.';

/** Returns `content` with each key set: replaced in place where it exists, appended under one comment otherwise. */
export function updateEnvContent(content: string, updates: ReadonlyMap<string, string>): string {
  const remaining = new Map(updates);
  const lines = content === '' ? [] : content.split(/\r?\n/);
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of lines) {
    const key = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line)?.[1];
    if (key !== undefined && updates.has(key)) {
      if (seen.has(key)) continue; // drop duplicates of a key we manage
      seen.add(key);
      out.push(`${key}=${updates.get(key)}`);
      remaining.delete(key);
    } else out.push(line);
  }
  if (remaining.size > 0) {
    if (!out.includes(SECTION)) {
      if (out.length > 0 && out[out.length - 1] !== '') out.push('');
      out.push(SECTION);
    }
    for (const [key, value] of remaining) out.push(`${key}=${value}`);
  }
  return `${out.join('\n')}\n`;
}

/** Reads an env file, or an empty map if it doesn't exist. */
export async function readEnvFile(path: string): Promise<{ exists: boolean; content: string; values: Map<string, string> }> {
  try {
    const content = await readFile(path, 'utf8');
    return { exists: true, content, values: parseEnvFile(content) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { exists: false, content: '', values: new Map() };
    throw error;
  }
}

/** Sets keys in an env file atomically (temp file, then rename), readable only by you. */
export async function writeEnvValues(path: string, updates: ReadonlyMap<string, string>): Promise<void> {
  if (updates.size === 0) return;
  for (const [key, value] of updates) {
    if (/[\r\n]/.test(value) || /[\s#"'$`\\]/.test(value)) throw new Error(`auth-kit: refusing to write an unsafe value for ${key}.`);
  }
  const { content } = await readEnvFile(path);
  const next = updateEnvContent(content, updates);
  const temp = join(dirname(path), `.${basename(path)}.${process.pid}.tmp`);
  await writeFile(temp, next, { mode: 0o600 });
  await rename(temp, path);
}

/**
 * A password for a persona: 36 characters with upper- and lowercase letters, digits, and a symbol, so
 * it passes any Cognito password policy, and nothing an env file would mangle (no `$`, quotes, `#`).
 */
export function generatePersonaPassword(random: (size: number) => Buffer = randomBytes): string {
  return `Aa1-${random(24).toString('base64url')}`;
}

export type GitIgnoreStatus = 'ignored' | 'not-ignored' | 'no-repo';

/** Asks git whether a path is ignored (`git check-ignore`). Outside a repository there's nothing to commit. */
export function gitIgnoreStatus(path: string): Promise<GitIgnoreStatus> {
  return new Promise((resolve) => {
    execFile('git', ['check-ignore', '-q', basename(path)], { cwd: dirname(path) }, (error) => {
      if (!error) return resolve('ignored');
      const code = (error as { code?: number | string }).code;
      resolve(code === 1 ? 'not-ignored' : 'no-repo');
    });
  });
}
