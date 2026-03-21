import { fileURLToPath } from 'node:url';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';

export const DEFAULT_RUNNER_HOME = join(homedir(), '.chatgpt-runner');
const MODULE_DIR = fileURLToPath(new URL('.', import.meta.url));
export const DEFAULT_BROWSER_COMMAND = process.env.HUMAN_BROWSER_BIN || process.execPath;
export const DEFAULT_BROWSER_COMMAND_ARGS = process.env.HUMAN_BROWSER_BIN
  ? []
  : [join(MODULE_DIR, '..', '..', 'cli', 'human-browser.ts')];
export const DEFAULT_TIMEOUT_MS = 20_000;

export function resolveRunnerHome(homePath?: string): string {
  return resolve(homePath ?? DEFAULT_RUNNER_HOME);
}

export async function ensureRunnerHome(homePath?: string): Promise<string> {
  const runnerHome = resolveRunnerHome(homePath);
  await mkdir(join(runnerHome, 'jobs'), { recursive: true });
  return runnerHome;
}

export function jobsDir(homePath?: string): string {
  return join(resolveRunnerHome(homePath), 'jobs');
}

export async function readRunnerState(homePath?: string): Promise<{ guardedWindowId?: number }> {
  const path = join(resolveRunnerHome(homePath), 'state.json');
  try {
    const raw = await readFile(path, 'utf8');
    const parsed = JSON.parse(raw) as { guardedWindowId?: number };
    return parsed;
  } catch {
    return {};
  }
}

export async function writeRunnerState(
  homePath: string | undefined,
  patch: { guardedWindowId?: number },
): Promise<void> {
  const runnerHome = await ensureRunnerHome(homePath);
  const current = await readRunnerState(runnerHome);
  const next = {
    ...current,
    ...patch,
  };
  await writeFile(join(runnerHome, 'state.json'), `${JSON.stringify(next, null, 2)}\n`, 'utf8');
}
