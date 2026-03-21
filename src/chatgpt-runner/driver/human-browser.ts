import { execFile as execFileCallback } from 'node:child_process';
import { mkdir, rmdir } from 'node:fs/promises';
import { promisify } from 'node:util';
import { RunnerError } from '../shared/errors.ts';
import type { BrowserCommandResult, BrowserDriver, BrowserDriverOptions } from '../shared/types.ts';

const execFile = promisify(execFileCallback);

export class HumanBrowserDriver implements BrowserDriver {
  private readonly profile: string;
  private readonly browserCommand: string;
  private readonly browserCommandArgs: string[];
  private readonly defaultTimeoutMs: number;
  private readonly lockPath?: string;
  private windowId?: number;
  private tabId?: number;
  private lockDepth = 0;

  constructor(options: BrowserDriverOptions) {
    this.profile = options.profile;
    this.browserCommand = options.browserCommand;
    this.browserCommandArgs = options.browserCommandArgs ?? [];
    this.defaultTimeoutMs = options.defaultTimeoutMs;
    this.lockPath = options.lockPath;
    this.windowId = options.initialWindowId;
    this.tabId = options.initialTabId;
  }

  getWindowId(): number | undefined {
    return this.windowId;
  }

  getTabId(): number | undefined {
    return this.tabId;
  }

  async createTab(url = 'about:blank'): Promise<{ tabId: number; windowId?: number }> {
    return this.withLock(async () => {
      const payload = await this.runJsonCommand('new-tab', [url, ...this.explicitWindowArgs()]);
      const tabId = Number(payload.tab_id);
      if (!Number.isFinite(tabId)) {
        throw new RunnerError('BROWSER_COMMAND_FAILED', 'create_tab did not return a numeric tab id', {
          payload,
        });
      }
      const windowId = Number(payload.window_id);
      this.tabId = tabId;
      if (Number.isFinite(windowId)) {
        this.windowId = windowId;
      }
      await this.runJsonCommand('use', [String(tabId)]);
      return {
        tabId,
        windowId: Number.isFinite(windowId) ? windowId : this.windowId,
      };
    });
  }

  async open(url: string): Promise<BrowserCommandResult> {
    return this.withTabSelection(async () => {
      const result = await this.runJsonCommand('navigate', [url, ...this.explicitTabArgs()]);
      await this.waitForUrl(url);
      return result;
    });
  }

  async click(selector: string): Promise<BrowserCommandResult> {
    return this.withTabSelection(async () => this.runJsonCommand('click', [selector, ...this.explicitTabArgs()]));
  }

  async upload(selector: string, files: string[]): Promise<BrowserCommandResult> {
    return this.withTabSelection(async () => this.runJsonCommand('upload', [selector, ...files, ...this.explicitTabArgs()]));
  }

  async pdf(path: string): Promise<BrowserCommandResult> {
    return this.withTabSelection(async () => this.runJsonCommand('pdf', [path, ...this.explicitTabArgs()]));
  }

  async eval<T = unknown>(script: string): Promise<T> {
    return this.withTabSelection(async () => {
      const payload = await this.runJsonCommand('eval', [script, ...this.explicitTabArgs()]);
      return this.unwrapResult(payload) as T;
    });
  }

  private async withTabSelection<T>(callback: () => Promise<T>): Promise<T> {
    return this.withLock(async () => {
      if (typeof this.tabId === 'number') {
        await this.runJsonCommand('use', [String(this.tabId)]);
      } else {
        await this.runJsonCommand('use', ['active']);
      }
      return callback();
    });
  }

  private async withLock<T>(callback: () => Promise<T>): Promise<T> {
    if (!this.lockPath) {
      return callback();
    }
    if (this.lockDepth > 0) {
      this.lockDepth += 1;
      try {
        return await callback();
      } finally {
        this.lockDepth -= 1;
      }
    }
    await acquireLock(this.lockPath, Math.max(this.defaultTimeoutMs * 6, 120_000));
    this.lockDepth = 1;
    try {
      return await callback();
    } finally {
      this.lockDepth = 0;
      await releaseLock(this.lockPath);
    }
  }

  private async waitForUrl(targetUrl: string): Promise<void> {
    const startedAt = Date.now();
    while (Date.now() - startedAt < this.defaultTimeoutMs) {
      try {
        const currentUrl = await this.eval<string>('location.href');
        if (urlsMatch(currentUrl, targetUrl)) {
          return;
        }
      } catch {
        // Ignore and retry while navigation is in flight.
      }
      await sleep(250);
    }

    throw new RunnerError('BROWSER_COMMAND_FAILED', 'Timed out waiting for browser to reach target URL', {
      target_url: targetUrl,
    });
  }

  private async runJsonCommand(command: string, args: string[]): Promise<BrowserCommandResult> {
    const argv = buildBrowserArgs({
      browserCommandArgs: this.browserCommandArgs,
      profile: this.profile,
      timeoutMs: this.defaultTimeoutMs,
      command,
      args,
    });

    try {
      const { stdout } = await execFile(this.browserCommand, argv, {
        cwd: process.cwd(),
        maxBuffer: 4 * 1024 * 1024,
      });
      return parseBrowserJson(stdout.trim());
    } catch (error) {
      const details = error instanceof Error ? { message: error.message } : undefined;
      throw new RunnerError('BROWSER_COMMAND_FAILED', `human-browser ${command} failed`, details);
    }
  }

  private unwrapResult(payload: BrowserCommandResult): unknown {
    return normalizeBrowserValue(payload.result);
  }
  private explicitTabArgs(): string[] {
    return typeof this.tabId === 'number' ? ['--tab', String(this.tabId)] : [];
  }

  private explicitWindowArgs(): string[] {
    return typeof this.windowId === 'number' ? ['--window', String(this.windowId)] : [];
  }
}

export function buildBrowserArgs(input: {
  browserCommandArgs?: string[];
  profile: string;
  timeoutMs: number;
  command: string;
  args: string[];
}): string[] {
  return [...(input.browserCommandArgs ?? []), '--profile', input.profile, '--timeout', String(input.timeoutMs), input.command, ...input.args];
}

function parseBrowserJson(raw: string): BrowserCommandResult {
  if (!raw) {
    return {};
  }

  try {
    return JSON.parse(raw) as BrowserCommandResult;
  } catch {
    throw new RunnerError('BROWSER_COMMAND_FAILED', 'human-browser returned non-JSON output', {
      raw,
    });
  }
}

function urlsMatch(currentUrl: string, targetUrl: string): boolean {
  const current = trimTrailingSlash(currentUrl);
  const target = trimTrailingSlash(targetUrl);
  return current === target || current.startsWith(`${target}?`) || current.startsWith(`${target}#`);
}

function trimTrailingSlash(value: string): string {
  return value.endsWith('/') ? value.slice(0, -1) : value;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function acquireLock(lockPath: string, timeoutMs: number): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      await mkdir(lockPath);
      return;
    } catch {
      await sleep(100);
    }
  }
  throw new RunnerError('BROWSER_COMMAND_FAILED', 'Timed out waiting for browser lock', {
    lock_path: lockPath,
  });
}

async function releaseLock(lockPath: string): Promise<void> {
  try {
    await rmdir(lockPath);
  } catch {
    // Ignore stale lock cleanup errors.
  }
}

function normalizeBrowserValue(value: unknown): unknown {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
      try {
        return JSON.parse(trimmed);
      } catch {
        return value;
      }
    }
    return value;
  }

  if (value && typeof value === 'object' && 'result' in value) {
    return normalizeBrowserValue((value as Record<string, unknown>).result);
  }

  return value;
}
