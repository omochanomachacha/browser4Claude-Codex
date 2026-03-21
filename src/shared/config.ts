import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { HBError } from './errors.ts';
import type { DaemonConfig } from './types.ts';

export const DEFAULT_CONFIG_PATH = join(homedir(), '.human-browser', 'config.json');
const LOOPBACK_HOST = '127.0.0.1';

function newToken(exclude?: string): string {
  let token = randomUUID().replaceAll('-', '');
  if (exclude && token === exclude) {
    token = randomUUID().replaceAll('-', '');
  }
  return token;
}

export function resolveConfigPath(configPath?: string): string {
  return configPath ?? DEFAULT_CONFIG_PATH;
}

export async function readConfig(configPath?: string): Promise<DaemonConfig> {
  const resolved = resolveConfigPath(configPath);
  let raw: string;

  try {
    raw = await readFile(resolved, 'utf8');
  } catch {
    throw new HBError(
      'BAD_REQUEST',
      `Config not found: ${resolved}`,
      { config_path: resolved },
      { next_command: 'human-browser init' },
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new HBError('BAD_REQUEST', `Invalid JSON config: ${resolved}`, { config_path: resolved });
  }

  validateConfig(parsed, resolved);
  return normalizeConfig(parsed as DaemonConfig);
}

function assertLoopbackHost(host: string, path: string): void {
  // The daemon is intentionally local-only. Enforcing loopback here prevents
  // accidental exposure to LAN/WAN when users edit config by hand.
  if (host !== LOOPBACK_HOST) {
    throw new HBError('BAD_REQUEST', `Config.daemon.host must be ${LOOPBACK_HOST}`, {
      config_path: path,
      host,
    });
  }
}

function validateConfig(input: unknown, path: string): asserts input is DaemonConfig {
  if (!input || typeof input !== 'object') {
    throw new HBError('BAD_REQUEST', 'Config must be an object', { config_path: path });
  }

  const cfg = input as Record<string, unknown>;
  const daemon = cfg.daemon as Record<string, unknown> | undefined;
  const auth = cfg.auth as Record<string, unknown> | undefined;
  const diagnostics = cfg.diagnostics as Record<string, unknown> | undefined;
  const backend = cfg.backend as Record<string, unknown> | undefined;
  const cdp = cfg.cdp as Record<string, unknown> | undefined;

  if (!daemon || typeof daemon.host !== 'string' || typeof daemon.port !== 'number') {
    throw new HBError('BAD_REQUEST', 'Config.daemon.host and config.daemon.port are required', {
      config_path: path,
    });
  }
  assertLoopbackHost(daemon.host, path);

  if (!auth || typeof auth.token !== 'string' || auth.token.length < 24) {
    throw new HBError('BAD_REQUEST', 'Config.auth.token is required and must be at least 24 characters', {
      config_path: path,
    });
  }

  if (!diagnostics || typeof diagnostics.max_events !== 'number') {
    throw new HBError('BAD_REQUEST', 'Config.diagnostics.max_events is required', {
      config_path: path,
    });
  }

  if (backend !== undefined) {
    if (!backend || (backend.type !== 'extension' && backend.type !== 'cdp')) {
      throw new HBError('BAD_REQUEST', 'Config.backend.type must be extension or cdp', {
        config_path: path,
      });
    }
  }

  if (cdp !== undefined) {
    validateCdpConfig(cdp, path);
  }
}

export async function initConfig(options: {
  configPath?: string;
  host: string;
  port: number;
  maxEvents: number;
  force: boolean;
  backendType?: 'extension' | 'cdp';
  cdp?: DaemonConfig['cdp'];
}): Promise<{ path: string; config: DaemonConfig; alreadyExisted: boolean }> {
  const resolved = resolveConfigPath(options.configPath);
  if (options.host !== LOOPBACK_HOST) {
    throw new HBError('BAD_REQUEST', `--host must be ${LOOPBACK_HOST}`, {
      host: options.host,
    });
  }

  let exists = false;
  let reusedToken: string | null = null;
  try {
    const existingRaw = await readFile(resolved, 'utf8');
    exists = true;
    if (options.force) {
      reusedToken = extractReusableToken(existingRaw);
    }
  } catch {
    exists = false;
  }

  if (exists && !options.force) {
    throw new HBError('BAD_REQUEST', `Config already exists: ${resolved}`, { config_path: resolved }, {
      next_command: 'human-browser init --force',
    });
  }

  const config: DaemonConfig = {
    daemon: {
      host: options.host,
      port: options.port,
    },
    auth: {
      token: reusedToken ?? newToken(),
    },
    diagnostics: {
      max_events: options.maxEvents,
    },
    backend: {
      type: options.backendType ?? 'extension',
    },
    cdp: options.backendType === 'cdp'
      ? sanitizeCdpConfig(options.cdp)
      : undefined,
  };

  await mkdir(dirname(resolved), { recursive: true });
  // The token inside config is a secret shared with the extension.
  // Keep file permissions strict even if the file already existed.
  await writeFile(resolved, `${JSON.stringify(config, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await chmod(resolved, 0o600);

  return {
    path: resolved,
    config: normalizeConfig(config),
    alreadyExisted: exists,
  };
}

export async function rotateConfigToken(configPath?: string): Promise<{ path: string; config: DaemonConfig }> {
  const resolved = resolveConfigPath(configPath);
  const existing = await readConfig(configPath);
  const rotated: DaemonConfig = {
    ...existing,
    auth: {
      ...existing.auth,
      token: newToken(existing.auth.token),
    },
  };

  await mkdir(dirname(resolved), { recursive: true });
  await writeFile(resolved, `${JSON.stringify(rotated, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await chmod(resolved, 0o600);

  return {
    path: resolved,
    config: normalizeConfig(rotated),
  };
}

function normalizeConfig(input: DaemonConfig): DaemonConfig {
  const backendType = input.backend?.type ?? 'extension';
  return {
    ...input,
    backend: {
      type: backendType,
    },
    cdp: backendType === 'cdp' ? sanitizeCdpConfig(input.cdp) : input.cdp,
  };
}

function sanitizeCdpConfig(input?: DaemonConfig['cdp']): DaemonConfig['cdp'] {
  if (!input) {
    return {
      remote_debugging_port: 9222,
      profile_directory: 'Default',
      launch_args: [],
    };
  }

  return {
    browser_ws_url: typeof input.browser_ws_url === 'string' && input.browser_ws_url.length > 0 ? input.browser_ws_url : undefined,
    browser_http_url: typeof input.browser_http_url === 'string' && input.browser_http_url.length > 0 ? input.browser_http_url : undefined,
    executable_path: typeof input.executable_path === 'string' && input.executable_path.length > 0 ? input.executable_path : undefined,
    user_data_dir: typeof input.user_data_dir === 'string' && input.user_data_dir.length > 0 ? input.user_data_dir : undefined,
    profile_directory: typeof input.profile_directory === 'string' && input.profile_directory.length > 0 ? input.profile_directory : 'Default',
    remote_debugging_port: typeof input.remote_debugging_port === 'number' && Number.isFinite(input.remote_debugging_port)
      ? input.remote_debugging_port
      : 9222,
    launch_args: Array.isArray(input.launch_args)
      ? input.launch_args.filter((value): value is string => typeof value === 'string' && value.length > 0)
      : [],
  };
}

function validateCdpConfig(cdp: Record<string, unknown>, path: string): void {
  const stringFields = ['browser_ws_url', 'browser_http_url', 'executable_path', 'user_data_dir', 'profile_directory'] as const;
  for (const field of stringFields) {
    const value = cdp[field];
    if (value !== undefined && typeof value !== 'string') {
      throw new HBError('BAD_REQUEST', `Config.cdp.${field} must be a string`, {
        config_path: path,
      });
    }
  }

  if (cdp.remote_debugging_port !== undefined) {
    const value = cdp.remote_debugging_port;
    if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
      throw new HBError('BAD_REQUEST', 'Config.cdp.remote_debugging_port must be a positive integer', {
        config_path: path,
      });
    }
  }

  if (cdp.launch_args !== undefined) {
    if (!Array.isArray(cdp.launch_args) || cdp.launch_args.some((value) => typeof value !== 'string')) {
      throw new HBError('BAD_REQUEST', 'Config.cdp.launch_args must be an array of strings', {
        config_path: path,
      });
    }
  }
}

function extractReusableToken(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== 'object') {
    return null;
  }

  const token = (parsed as Record<string, unknown>).auth;
  if (!token || typeof token !== 'object') {
    return null;
  }

  const value = (token as Record<string, unknown>).token;
  if (typeof value !== 'string' || value.length < 24) {
    return null;
  }

  return value;
}
