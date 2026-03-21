#!/usr/bin/env node

import { readFileSync, realpathSync } from 'node:fs';
import { cp, mkdir, rm, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve as resolvePath } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { initConfig, readConfig, rotateConfigToken } from '../shared/config.ts';
import { HBError, asStructuredError } from '../shared/errors.ts';
import type { DaemonApiResponse, DaemonConfig, SnapshotOptions, StructuredError } from '../shared/types.ts';
import { startDaemon } from '../daemon/app.ts';

interface GlobalOptions {
  json: boolean;
  configPath?: string;
  profile?: string;
  timeoutMs: number;
  queueMode: 'hold' | 'fail';
}

interface Parsed {
  command: string;
  args: string[];
  options: GlobalOptions;
}

function parseGlobalArgs(argv: string[]): Parsed {
  const args = [...argv];
  let json = false;
  let configPath: string | undefined;
  let profile: string | undefined;
  let timeoutMs = 10000;
  let queueMode: 'hold' | 'fail' = 'hold';

  while (args.length > 0) {
    const token = args[0];
    if (!token || !token.startsWith('--')) {
      break;
    }

    args.shift();

    if (token === '--json') {
      json = true;
      continue;
    }

    if (token === '--config') {
      const value = args.shift();
      if (!value) {
        throw new HBError('BAD_REQUEST', '--config requires a path');
      }
      configPath = value;
      continue;
    }

    if (token === '--profile') {
      const value = args.shift();
      if (!value) {
        throw new HBError('BAD_REQUEST', '--profile requires a profile name');
      }
      profile = value;
      continue;
    }

    if (token === '--timeout') {
      const value = args.shift();
      if (!value) {
        throw new HBError('BAD_REQUEST', '--timeout requires milliseconds');
      }
      const parsed = Number(value);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new HBError('BAD_REQUEST', '--timeout must be a positive number');
      }
      timeoutMs = parsed;
      continue;
    }

    if (token === '--queue-mode') {
      const value = args.shift();
      if (value !== 'hold' && value !== 'fail') {
        throw new HBError('BAD_REQUEST', '--queue-mode must be hold or fail');
      }
      queueMode = value;
      continue;
    }

    throw new HBError('BAD_REQUEST', `Unknown option: ${token}`);
  }

  const command = args.shift() ?? 'help';

  return {
    command,
    args,
    options: {
      json,
      configPath,
      profile,
      timeoutMs,
      queueMode,
    },
  };
}

async function main(): Promise<void> {
  const parsed = parseGlobalArgs(process.argv.slice(2));
  applyProfileToOptions(parsed.options);

  switch (parsed.command) {
    case 'help': {
      printHelp();
      return;
    }
    case 'ws': {
      await commandWs(parsed.args, parsed.options);
      return;
    }
    case 'init': {
      await commandInit(parsed.args, parsed.options);
      return;
    }
    case 'rotate-token': {
      await commandRotateToken(parsed.args, parsed.options);
      return;
    }
    case 'daemon': {
      await commandDaemon(parsed.options);
      return;
    }
    default: {
      await commandDaemonRpc(parsed.command, parsed.args, parsed.options);
    }
  }
}

function applyProfileToOptions(options: GlobalOptions): void {
  if (options.configPath || !options.profile) {
    return;
  }
  options.configPath = resolveProfileConfigPath(options.profile);
}

function resolveProfileConfigPath(profile: string): string {
  const profilesPath = resolvePath(homedir(), '.human-browser', 'profiles.json');
  const raw = readFileSync(profilesPath, 'utf8');
  const parsed = JSON.parse(raw) as {
    profiles?: Record<string, { config?: string; aliases?: string[] }>;
  };
  const profiles = parsed.profiles ?? {};
  for (const [name, entry] of Object.entries(profiles)) {
    const aliases = [name, ...(entry.aliases ?? [])].map((item) => item.toLowerCase());
    if (aliases.includes(profile.toLowerCase())) {
      if (!entry.config) {
        throw new HBError('BAD_REQUEST', `Profile has no config path: ${profile}`);
      }
      return resolvePath(entry.config.replace(/^~(?=$|\/)/, homedir()));
    }
  }
  throw new HBError('BAD_REQUEST', `Unknown profile: ${profile}`, undefined, {
    next_command: 'human-browser profile list --json',
  });
}

async function commandInit(args: string[], options: GlobalOptions): Promise<void> {
  let host = '127.0.0.1';
  let port = 18765;
  let maxEvents = 500;
  let force = false;
  let showToken = false;
  let backendType: 'extension' | 'cdp' = 'extension';
  let seedUserDataDir: string | undefined;
  let seedProfileDirectory: string | undefined;
  const cdp: NonNullable<DaemonConfig['cdp']> = {
    browser_ws_url: undefined,
    browser_http_url: undefined,
    executable_path: undefined,
    user_data_dir: undefined,
    profile_directory: 'Default',
    remote_debugging_port: 9222,
    launch_args: [],
  };

  for (let i = 0; i < args.length; i += 1) {
    const token = args[i];

    if (token === '--host') {
      const value = args[i + 1];
      if (!value) {
        throw new HBError('BAD_REQUEST', '--host requires a value');
      }
      host = value;
      i += 1;
      continue;
    }

    if (token === '--port') {
      const value = args[i + 1];
      if (!value) {
        throw new HBError('BAD_REQUEST', '--port requires a value');
      }
      const parsed = Number(value);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new HBError('BAD_REQUEST', '--port must be a positive number');
      }
      port = parsed;
      i += 1;
      continue;
    }

    if (token === '--max-events') {
      const value = args[i + 1];
      if (!value) {
        throw new HBError('BAD_REQUEST', '--max-events requires a value');
      }
      const parsed = Number(value);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new HBError('BAD_REQUEST', '--max-events must be a positive number');
      }
      maxEvents = parsed;
      i += 1;
      continue;
    }

    if (token === '--force') {
      force = true;
      continue;
    }

    if (token === '--show-token') {
      // Security default: never print secrets unless user explicitly opts in.
      showToken = true;
      continue;
    }

    if (token === '--backend') {
      const value = args[i + 1];
      if (value !== 'extension' && value !== 'cdp') {
        throw new HBError('BAD_REQUEST', '--backend must be extension or cdp');
      }
      backendType = value;
      i += 1;
      continue;
    }

    if (token === '--cdp-url') {
      const value = args[i + 1];
      if (!value) {
        throw new HBError('BAD_REQUEST', '--cdp-url requires a value');
      }
      if (value.startsWith('ws://') || value.startsWith('wss://')) {
        cdp.browser_ws_url = value;
      } else {
        cdp.browser_http_url = value;
      }
      i += 1;
      continue;
    }

    if (token === '--chrome-executable') {
      const value = args[i + 1];
      if (!value) {
        throw new HBError('BAD_REQUEST', '--chrome-executable requires a value');
      }
      cdp.executable_path = value;
      i += 1;
      continue;
    }

    if (token === '--user-data-dir') {
      const value = args[i + 1];
      if (!value) {
        throw new HBError('BAD_REQUEST', '--user-data-dir requires a value');
      }
      cdp.user_data_dir = value;
      i += 1;
      continue;
    }

    if (token === '--profile-directory') {
      const value = args[i + 1];
      if (!value) {
        throw new HBError('BAD_REQUEST', '--profile-directory requires a value');
      }
      cdp.profile_directory = value;
      i += 1;
      continue;
    }

    if (token === '--remote-debugging-port') {
      const value = args[i + 1];
      if (!value) {
        throw new HBError('BAD_REQUEST', '--remote-debugging-port requires a value');
      }
      const parsed = Number(value);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new HBError('BAD_REQUEST', '--remote-debugging-port must be a positive number');
      }
      cdp.remote_debugging_port = parsed;
      i += 1;
      continue;
    }

    if (token === '--chrome-arg') {
      const value = args[i + 1];
      if (!value) {
        throw new HBError('BAD_REQUEST', '--chrome-arg requires a value');
      }
      cdp.launch_args.push(value);
      i += 1;
      continue;
    }

    if (token === '--seed-user-data-dir') {
      const value = args[i + 1];
      if (!value) {
        throw new HBError('BAD_REQUEST', '--seed-user-data-dir requires a value');
      }
      seedUserDataDir = value;
      i += 1;
      continue;
    }

    if (token === '--seed-profile-directory') {
      const value = args[i + 1];
      if (!value) {
        throw new HBError('BAD_REQUEST', '--seed-profile-directory requires a value');
      }
      seedProfileDirectory = value;
      i += 1;
      continue;
    }

    throw new HBError('BAD_REQUEST', `Unknown init option: ${token}`);
  }

  if (seedUserDataDir || seedProfileDirectory) {
    if (backendType !== 'cdp') {
      throw new HBError('BAD_REQUEST', '--seed-user-data-dir/--seed-profile-directory require --backend cdp');
    }
    if (!seedUserDataDir || !seedProfileDirectory) {
      throw new HBError('BAD_REQUEST', 'Both --seed-user-data-dir and --seed-profile-directory are required together');
    }
    if (!cdp.user_data_dir) {
      cdp.user_data_dir = resolvePath(join(homedir(), '.human-browser', 'seeded-chrome', seedProfileDirectory.replace(/\s+/g, '-')));
    }
    if (!cdp.profile_directory || cdp.profile_directory === 'Default') {
      cdp.profile_directory = seedProfileDirectory;
    }
  }

  const { path, config, alreadyExisted } = await initConfig({
    configPath: options.configPath,
    host,
    port,
    maxEvents,
    force,
    backendType,
    cdp: backendType === 'cdp' ? cdp : undefined,
  });

  if (backendType === 'cdp' && seedUserDataDir && seedProfileDirectory) {
    await seedChromeProfile({
      sourceUserDataDir: seedUserDataDir,
      sourceProfileDirectory: seedProfileDirectory,
      targetUserDataDir: config.cdp?.user_data_dir ?? cdp.user_data_dir ?? '',
      targetProfileDirectory: config.cdp?.profile_directory ?? cdp.profile_directory ?? seedProfileDirectory,
    });
  }

  const output = {
    config_path: path,
    replaced_existing: alreadyExisted,
    daemon_http_url: `http://${config.daemon.host}:${config.daemon.port}`,
    extension_ws_url: `ws://${config.daemon.host}:${config.daemon.port}/bridge`,
    token: showToken ? config.auth.token : '[hidden]',
    token_hidden: !showToken,
    backend: config.backend?.type ?? 'extension',
    cdp: config.backend?.type === 'cdp' ? config.cdp : undefined,
    seeded_from: seedUserDataDir && seedProfileDirectory ? {
      user_data_dir: seedUserDataDir,
      profile_directory: seedProfileDirectory,
    } : undefined,
  };

  if (options.json) {
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
    return;
  }

  process.stdout.write(`config_path: ${output.config_path}\n`);
  process.stdout.write(`daemon_http_url: ${output.daemon_http_url}\n`);
  process.stdout.write(`extension_ws_url: ${output.extension_ws_url}\n`);
  process.stdout.write(`token: ${output.token}\n`);
  process.stdout.write(`backend: ${output.backend}\n`);
  if (output.cdp) {
    process.stdout.write(`cdp: ${JSON.stringify(output.cdp)}\n`);
  }
  if (output.seeded_from) {
    process.stdout.write(`seeded_from: ${JSON.stringify(output.seeded_from)}\n`);
  }
  if (output.token_hidden) {
    process.stdout.write('hint: use `human-browser init --show-token` to print token\n');
  }
}

async function commandDaemon(options: GlobalOptions): Promise<void> {
  const config = await readConfig(options.configPath);
  const daemon = await startDaemon(config);

  process.stdout.write(
    `[human-browser] daemon listening at http://${daemon.host}:${daemon.port} and ws://${daemon.host}:${daemon.port}/bridge\n`,
  );

  const shutdown = async (signal: string): Promise<void> => {
    process.stdout.write(`[human-browser] received ${signal}, shutting down\n`);
    await daemon.close();
    process.exit(0);
  };

  process.on('SIGINT', () => {
    void shutdown('SIGINT');
  });

  process.on('SIGTERM', () => {
    void shutdown('SIGTERM');
  });

  await new Promise<void>(() => {
    // Keep process alive.
  });
}

async function commandWs(args: string[], options: GlobalOptions): Promise<void> {
  let showToken = false;

  for (const token of args) {
    if (token === '--show-token') {
      // Security default: avoid accidental token leaks in shell history / pasted logs.
      showToken = true;
      continue;
    }
    throw new HBError('BAD_REQUEST', `Unknown ws option: ${token}`);
  }

  const config = await readConfig(options.configPath);
  const data = {
    ws_url: `ws://${config.daemon.host}:${config.daemon.port}/bridge`,
    token: showToken ? config.auth.token : '[hidden]',
    token_hidden: !showToken,
  };

  if (options.json) {
    process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
    return;
  }

  process.stdout.write(`ws_url: ${data.ws_url}\n`);
  process.stdout.write(`token: ${data.token}\n`);
  if (data.token_hidden) {
    process.stdout.write('hint: use `human-browser ws --show-token` to print token\n');
  }
}

async function commandRotateToken(args: string[], options: GlobalOptions): Promise<void> {
  let showToken = false;

  for (const token of args) {
    if (token === '--show-token') {
      // Security default: avoid accidental token leaks in shell history / pasted logs.
      showToken = true;
      continue;
    }
    throw new HBError('BAD_REQUEST', `Unknown rotate-token option: ${token}`);
  }

  const { path, config } = await rotateConfigToken(options.configPath);
  const data = {
    config_path: path,
    ws_url: `ws://${config.daemon.host}:${config.daemon.port}/bridge`,
    token: showToken ? config.auth.token : '[hidden]',
    token_hidden: !showToken,
    daemon_restart_required: true,
  };

  if (options.json) {
    process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
    return;
  }

  process.stdout.write(`config_path: ${data.config_path}\n`);
  process.stdout.write(`ws_url: ${data.ws_url}\n`);
  process.stdout.write(`token: ${data.token}\n`);
  process.stdout.write(`daemon_restart_required: ${String(data.daemon_restart_required)}\n`);
  if (data.token_hidden) {
    process.stdout.write('hint: use `human-browser rotate-token --show-token` to print token\n');
  }
  process.stdout.write('note: restart daemon and update extension token to apply rotation\n');
}

async function commandDaemonRpc(command: string, args: string[], options: GlobalOptions): Promise<void> {
  const config = await readConfig(options.configPath);
  const request = toDaemonRequest(command, args);
  const data = await callDaemon(config, request.command, request.args, options);

  if (options.json) {
    process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
    return;
  }

  renderText(command, data);
}

export function toDaemonRequest(
  command: string,
  args: string[],
): {
  command: string;
  args: Record<string, unknown>;
} {
  switch (command) {
    case 'state': {
      const parsed = parseSnapshotArgs(args);
      return {
        command: 'snapshot',
        args: {
          target: parsed.target,
          interactive: parsed.options.interactive ?? true,
          cursor: parsed.options.cursor ?? true,
          compact: parsed.options.compact ?? true,
          ...parsed.options,
        },
      };
    }
    case 'status':
    case 'tabs':
    case 'windows':
    case 'reconnect':
    case 'reset': {
      return { command, args: {} };
    }
    case 'new-tab':
    case 'create-tab': {
      const url = args[0];
      if (!url) {
        throw new HBError('BAD_REQUEST', 'new-tab requires <url>');
      }
      const parsed = parseMixedFlags(args.slice(1), ['--window'], ['--background']);
      return {
        command: 'create_tab',
        args: {
          url,
          active: !parsed.booleans.has('--background'),
          window_id: parsed.values['--window'] === undefined ? undefined : parseWindow(parsed.values['--window']),
        },
      };
    }
    case 'use': {
      const target = args[0];
      if (!target) {
        throw new HBError('BAD_REQUEST', 'use requires <active|tab_id>');
      }
      return {
        command,
        args: {
          target: target === 'active' ? 'active' : Number(target),
        },
      };
    }
    case 'use-window': {
      const target = args[0];
      if (!target) {
        throw new HBError('BAD_REQUEST', 'use-window requires <current|window_id>');
      }
      return {
        command: 'use_window',
        args: {
          target: target === 'current' ? 'current' : Number(target),
        },
      };
    }
    case 'guard-window': {
      const target = args[0];
      if (!target) {
        throw new HBError('BAD_REQUEST', 'guard-window requires <current|window_id>');
      }
      return {
        command: 'guard_window',
        args: {
          target: target === 'current' ? 'current' : Number(target),
        },
      };
    }
    case 'unguard-window': {
      return {
        command: 'unguard_window',
        args: {},
      };
    }
    case 'snapshot': {
      const parsed = parseSnapshotArgs(args);
      return {
        command,
        args: {
          target: parsed.target,
          ...parsed.options,
        },
      };
    }
    case 'click': {
      const selectorOrRef = args[0];
      if (!selectorOrRef) {
        throw new HBError('BAD_REQUEST', 'click requires <selector|@ref|index>');
      }
      const parsed = parseNamedFlags(args.slice(1), ['--snapshot', '--tab']);
      const ref = parseRefArg(selectorOrRef);
      const index = parseIndexArg(selectorOrRef);

      if (ref) {
        const snapshotId = parsed['--snapshot'];
        if (!snapshotId) {
          throw new HBError('BAD_REQUEST', 'click with ref requires --snapshot <snapshot_id>');
        }
        return {
          command,
          args: {
            ref,
            snapshot_id: snapshotId,
            tab_id: parsed['--tab'] === undefined ? undefined : parseTab(parsed['--tab']),
          },
        };
      }

      if (index !== null) {
        return {
          command,
          args: {
            index,
            snapshot_id: parsed['--snapshot'],
            tab_id: parsed['--tab'] === undefined ? undefined : parseTab(parsed['--tab']),
          },
        };
      }

      return {
        command,
        args: {
          selector: selectorOrRef,
          tab_id: parsed['--tab'] === undefined ? undefined : parseTab(parsed['--tab']),
        },
      };
    }
    case 'input':
    case 'fill': {
      const selectorOrRef = args[0];
      const value = args[1];
      if (!selectorOrRef || value === undefined) {
        throw new HBError('BAD_REQUEST', `${command} requires <selector|@ref|index> <value>`);
      }
      const parsed = parseNamedFlags(args.slice(2), ['--snapshot', '--tab']);
      const ref = parseRefArg(selectorOrRef);
      const index = parseIndexArg(selectorOrRef);

      if (ref) {
        const snapshotId = parsed['--snapshot'];
        if (!snapshotId) {
          throw new HBError('BAD_REQUEST', `${command} with ref requires --snapshot <snapshot_id>`);
        }
        return {
          command: 'fill',
          args: {
            ref,
            value,
            snapshot_id: snapshotId,
            tab_id: parsed['--tab'] === undefined ? undefined : parseTab(parsed['--tab']),
          },
        };
      }

      if (index !== null) {
        return {
          command: 'fill',
          args: {
            index,
            value,
            snapshot_id: parsed['--snapshot'],
            tab_id: parsed['--tab'] === undefined ? undefined : parseTab(parsed['--tab']),
          },
        };
      }

      return {
        command: 'fill',
        args: {
          selector: selectorOrRef,
          value,
          tab_id: parsed['--tab'] === undefined ? undefined : parseTab(parsed['--tab']),
        },
      };
    }
    case 'upload': {
      const parsed = parseUploadArgs(args);
      const ref = parseRefArg(parsed.selectorOrRef);
      const index = parseIndexArg(parsed.selectorOrRef);

      if (ref) {
        if (!parsed.snapshotId) {
          throw new HBError('BAD_REQUEST', 'upload with ref requires --snapshot <snapshot_id>');
        }
        return {
          command,
          args: {
            ref,
            files: parsed.files,
            snapshot_id: parsed.snapshotId,
          },
        };
      }

      if (index !== null) {
        return {
          command,
          args: {
            index,
            files: parsed.files,
            snapshot_id: parsed.snapshotId,
            tab_id: parsed.tabId,
          },
        };
      }

      return {
        command,
        args: {
          selector: parsed.selectorOrRef,
          files: parsed.files,
          tab_id: parsed.tabId,
        },
      };
    }
    case 'keys':
    case 'keypress': {
      const tabFlagIndex = args.findIndex((token) => token === '--tab');
      const keyArgs = tabFlagIndex === -1 ? args : args.slice(0, tabFlagIndex);
      const flagArgs = tabFlagIndex === -1 ? [] : args.slice(tabFlagIndex);
      const key = keyArgs.join(' ');
      if (!key) {
        throw new HBError('BAD_REQUEST', `${command} requires <key>`);
      }
      const parsed = parseNamedFlags(flagArgs, ['--tab']);
      return {
        command: 'keypress',
        args: {
          key,
          tab_id: parsed['--tab'] === undefined ? undefined : parseTab(parsed['--tab']),
        },
      };
    }
    case 'scroll': {
      if (args[0] === 'up' || args[0] === 'down' || args[0] === 'left' || args[0] === 'right') {
        const direction = args[0];
        const amountRaw = args[1] ?? '500';
        const amount = Number(amountRaw);
        if (!Number.isFinite(amount) || amount <= 0) {
          throw new HBError('BAD_REQUEST', 'scroll amount must be a positive number');
        }
        const parsed = parseNamedFlags(args.slice(args[1] === undefined ? 1 : 2), ['--tab']);
        const sign = direction === 'up' || direction === 'left' ? -1 : 1;
        const x = direction === 'left' || direction === 'right' ? sign * amount : 0;
        const y = direction === 'up' || direction === 'down' ? sign * amount : 0;
        return {
          command,
          args: {
            x,
            y,
            tab_id: parsed['--tab'] === undefined ? undefined : parseTab(parsed['--tab']),
          },
        };
      }

      const xRaw = args[0];
      const yRaw = args[1];
      if (xRaw === undefined || yRaw === undefined) {
        throw new HBError('BAD_REQUEST', 'scroll requires <x> <y> or <up|down|left|right> [amount]');
      }
      const x = Number(xRaw);
      const y = Number(yRaw);
      if (!Number.isFinite(x) || !Number.isFinite(y)) {
        throw new HBError('BAD_REQUEST', 'scroll values must be numeric');
      }
      const parsed = parseNamedFlags(args.slice(2), ['--tab']);
      return {
        command,
        args: {
          x,
          y,
          tab_id: parsed['--tab'] === undefined ? undefined : parseTab(parsed['--tab']),
        },
      };
    }
    case 'navigate': {
      const url = args[0];
      if (!url) {
        throw new HBError('BAD_REQUEST', 'navigate requires <url>');
      }
      const parsed = parseNamedFlags(args.slice(1), ['--tab']);
      return {
        command,
        args: {
          url,
          tab_id: parsed['--tab'] === undefined ? undefined : parseTab(parsed['--tab']),
        },
      };
    }
    case 'open':
    case 'goto': {
      const url = args[0];
      if (!url) {
        throw new HBError('BAD_REQUEST', `${command} requires <url>`);
      }
      const parsed = parseNamedFlags(args.slice(1), ['--tab']);
      return {
        command: 'open',
        args: {
          url,
          tab_id: parsed['--tab'] === undefined ? undefined : parseTab(parsed['--tab']),
        },
      };
    }
    case 'close': {
      const parsed = parseNamedFlags(args, ['--tab']);
      return {
        command,
        args: {
          tab_id: parsed['--tab'] === undefined ? undefined : parseTab(parsed['--tab']),
        },
      };
    }
    case 'hover': {
      const selectorOrRef = args[0];
      if (!selectorOrRef) {
        throw new HBError('BAD_REQUEST', 'hover requires <selector|@ref|index>');
      }
      const parsed = parseNamedFlags(args.slice(1), ['--snapshot', '--tab']);
      const ref = parseRefArg(selectorOrRef);
      const index = parseIndexArg(selectorOrRef);

      if (ref) {
        const snapshotId = parsed['--snapshot'];
        if (!snapshotId) {
          throw new HBError('BAD_REQUEST', 'hover with ref requires --snapshot <snapshot_id>');
        }
        return {
          command,
          args: {
            ref,
            snapshot_id: snapshotId,
            tab_id: parsed['--tab'] === undefined ? undefined : parseTab(parsed['--tab']),
          },
        };
      }

      if (index !== null) {
        return {
          command,
          args: {
            index,
            snapshot_id: parsed['--snapshot'],
            tab_id: parsed['--tab'] === undefined ? undefined : parseTab(parsed['--tab']),
          },
        };
      }

      return {
        command,
        args: {
          selector: selectorOrRef,
          tab_id: parsed['--tab'] === undefined ? undefined : parseTab(parsed['--tab']),
        },
      };
    }
    case 'screenshot': {
      const { path, rest } = parseOptionalPathArg(args);
      const parsed = parseMixedFlags(rest, ['--tab'], ['--full']);
      return {
        command,
        args: {
          path,
          full_page: parsed.booleans.has('--full'),
          tab_id: parsed.values['--tab'] === undefined ? undefined : parseTab(parsed.values['--tab']),
        },
      };
    }
    case 'pdf': {
      const path = args[0];
      if (!path) {
        throw new HBError('BAD_REQUEST', 'pdf requires <path>');
      }
      const parsed = parseNamedFlags(args.slice(1), ['--tab']);
      return {
        command,
        args: {
          path,
          tab_id: parsed['--tab'] === undefined ? undefined : parseTab(parsed['--tab']),
        },
      };
    }
    case 'eval': {
      const script = args[0];
      if (!script) {
        throw new HBError('BAD_REQUEST', 'eval requires <javascript>');
      }
      const parsed = parseNamedFlags(args.slice(1), ['--tab']);
      return {
        command: 'eval',
        args: {
          script,
          tab_id: parsed['--tab'] === undefined ? undefined : parseTab(parsed['--tab']),
        },
      };
    }
    case 'text': {
      const selectorOrRef = args[0];
      if (!selectorOrRef) {
        throw new HBError('BAD_REQUEST', 'text requires <selector|@ref|index>');
      }
      const parsed = parseNamedFlags(args.slice(1), ['--snapshot', '--tab']);
      const ref = parseRefArg(selectorOrRef);
      const index = parseIndexArg(selectorOrRef);
      if (ref) {
        const snapshotId = parsed['--snapshot'];
        if (!snapshotId) {
          throw new HBError('BAD_REQUEST', 'text with ref requires --snapshot <snapshot_id>');
        }
        return {
          command: 'text',
          args: {
            ref,
            snapshot_id: snapshotId,
            tab_id: parsed['--tab'] === undefined ? undefined : parseTab(parsed['--tab']),
          },
        };
      }
      if (index !== null) {
        return {
          command: 'text',
          args: {
            index,
            snapshot_id: parsed['--snapshot'],
            tab_id: parsed['--tab'] === undefined ? undefined : parseTab(parsed['--tab']),
          },
        };
      }
      return {
        command: 'text',
        args: {
          selector: selectorOrRef,
          tab_id: parsed['--tab'] === undefined ? undefined : parseTab(parsed['--tab']),
        },
      };
    }
    case 'html': {
      const selectorOrRef = args[0];
      const parsed = parseNamedFlags(args.slice(selectorOrRef ? 1 : 0), ['--snapshot', '--tab']);
      if (!selectorOrRef) {
        return {
          command: 'html',
          args: {
            tab_id: parsed['--tab'] === undefined ? undefined : parseTab(parsed['--tab']),
          },
        };
      }
      const ref = parseRefArg(selectorOrRef);
      const index = parseIndexArg(selectorOrRef);
      if (ref) {
        const snapshotId = parsed['--snapshot'];
        if (!snapshotId) {
          throw new HBError('BAD_REQUEST', 'html with ref requires --snapshot <snapshot_id>');
        }
        return {
          command: 'html',
          args: {
            ref,
            snapshot_id: snapshotId,
            tab_id: parsed['--tab'] === undefined ? undefined : parseTab(parsed['--tab']),
          },
        };
      }
      if (index !== null) {
        return {
          command: 'html',
          args: {
            index,
            snapshot_id: parsed['--snapshot'],
            tab_id: parsed['--tab'] === undefined ? undefined : parseTab(parsed['--tab']),
          },
        };
      }
      return {
        command: 'html',
        args: {
          selector: selectorOrRef,
          tab_id: parsed['--tab'] === undefined ? undefined : parseTab(parsed['--tab']),
        },
      };
    }
    case 'get': {
      const type = args[0];
      if (type === 'text') {
        return toDaemonRequest('text', args.slice(1));
      }
      if (type === 'html') {
        return toDaemonRequest('html', args.slice(1));
      }
      throw new HBError('BAD_REQUEST', 'get supports only text|html');
    }
    case 'wait':
    case 'wait-for': {
      const parsed = parseWaitArgs(args);
      return {
        command: 'wait',
        args: parsed,
      };
    }
    case 'cookies': {
      return parseCookiesCommand(args);
    }
    case 'network': {
      return parseNetworkCommand(args);
    }
    case 'console': {
      return parseConsoleCommand(args);
    }
    case 'diagnose': {
      const parsed = parseNamedFlags(args, ['--limit']);
      const limit = parsed['--limit'];
      return {
        command,
        args: {
          limit: limit === undefined ? 50 : Number(limit),
        },
      };
    }
    default:
      throw new HBError('BAD_REQUEST', `Unknown command: ${command}`);
  }
}

function parseNamedFlags(args: string[], allowedFlags: string[]): Record<string, string> {
  const allowed = new Set(allowedFlags);
  const map: Record<string, string> = {};

  for (let i = 0; i < args.length; i += 1) {
    const token = args[i];
    if (!allowed.has(token)) {
      throw new HBError('BAD_REQUEST', `Unknown flag: ${token}`);
    }

    const value = args[i + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new HBError('BAD_REQUEST', `Flag requires a value: ${token}`);
    }

    map[token] = value;
    i += 1;
  }

  return map;
}

function parseMixedFlags(
  args: string[],
  valueFlags: string[],
  booleanFlags: string[],
): { values: Record<string, string>; booleans: Set<string> } {
  const values = parseNamedFlagsAllowBooleans(args, valueFlags, booleanFlags);
  const parsedValues: Record<string, string> = {};
  const parsedBooleans = new Set<string>();

  for (const [key, value] of Object.entries(values)) {
    if (value === '__boolean_true__') {
      parsedBooleans.add(key);
      continue;
    }
    parsedValues[key] = value;
  }

  return {
    values: parsedValues,
    booleans: parsedBooleans,
  };
}

function parseNamedFlagsAllowBooleans(
  args: string[],
  valueFlags: string[],
  booleanFlags: string[],
): Record<string, string> {
  const values = new Set(valueFlags);
  const booleans = new Set(booleanFlags);
  const map: Record<string, string> = {};

  for (let i = 0; i < args.length; i += 1) {
    const token = args[i];
    if (values.has(token)) {
      const value = args[i + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new HBError('BAD_REQUEST', `Flag requires a value: ${token}`);
      }
      map[token] = value;
      i += 1;
      continue;
    }

    if (booleans.has(token)) {
      map[token] = '__boolean_true__';
      continue;
    }

    throw new HBError('BAD_REQUEST', `Unknown flag: ${token}`);
  }

  return map;
}

function parseOptionalPathArg(args: string[]): { path?: string; rest: string[] } {
  if (args.length === 0) {
    return { rest: [] };
  }
  if (args[0]?.startsWith('--')) {
    return { rest: args };
  }
  return {
    path: args[0],
    rest: args.slice(1),
  };
}

function parseWaitArgs(args: string[]): Record<string, unknown> {
  const parsed: Record<string, string> = {};
  const positional: string[] = [];

  for (let i = 0; i < args.length; i += 1) {
    const token = args[i];
    if (!token.startsWith('--')) {
      positional.push(token);
      continue;
    }

    if (!['--text', '--url', '--load', '--fn', '--timeout', '--tab'].includes(token)) {
      throw new HBError('BAD_REQUEST', `Unknown flag: ${token}`);
    }

    const value = args[i + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new HBError('BAD_REQUEST', `Flag requires a value: ${token}`);
    }
    parsed[token] = value;
    i += 1;
  }

  const payload: Record<string, unknown> = {};

  const tabRaw = parsed['--tab'];
  if (tabRaw !== undefined) {
    payload.tab_id = parseTab(tabRaw);
  }

  const timeoutRaw = parsed['--timeout'];
  if (timeoutRaw !== undefined) {
    const timeout = Number(timeoutRaw);
    if (!Number.isFinite(timeout) || timeout <= 0) {
      throw new HBError('BAD_REQUEST', '--timeout must be a positive number');
    }
    payload.timeout_ms = timeout;
  }

  const text = parsed['--text'];
  if (text !== undefined) {
    payload.text = text;
  }

  const urlPattern = parsed['--url'];
  if (urlPattern !== undefined) {
    payload.url_pattern = urlPattern;
  }

  const loadState = parsed['--load'];
  if (loadState !== undefined) {
    payload.load_state = loadState;
  }

  const expression = parsed['--fn'];
  if (expression !== undefined) {
    payload.expression = expression;
  }

  if (positional.length > 1) {
    throw new HBError('BAD_REQUEST', 'wait accepts at most one positional argument');
  }

  const position = positional[0];
  if (position !== undefined) {
    const raw = position;
    const ms = Number(raw);
    if (Number.isFinite(ms) && ms > 0) {
      payload.sleep_ms = ms;
    } else {
      payload.selector = raw;
    }
  }

  const conditions = [
    payload.selector !== undefined,
    payload.sleep_ms !== undefined,
    payload.text !== undefined,
    payload.url_pattern !== undefined,
    payload.load_state !== undefined,
    payload.expression !== undefined,
  ].filter(Boolean).length;

  if (conditions === 0) {
    throw new HBError('BAD_REQUEST', 'wait requires selector|milliseconds|--text|--url|--load|--fn');
  }

  if (conditions > 1) {
    throw new HBError('BAD_REQUEST', 'wait accepts only one wait condition at a time');
  }

  return payload;
}

function parseUploadArgs(args: string[]): {
  selectorOrRef: string;
  files: string[];
  snapshotId?: string;
  tabId?: number | 'active';
} {
  const selectorOrRef = args[0];
  if (!selectorOrRef) {
    throw new HBError('BAD_REQUEST', 'upload requires <selector|@ref> <file_path...>');
  }

  const files: string[] = [];
  let snapshotId: string | undefined;
  let tabId: number | 'active' | undefined;

  for (let i = 1; i < args.length; i += 1) {
    const token = args[i];
    if (token === '--snapshot') {
      const value = args[i + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new HBError('BAD_REQUEST', 'Flag requires a value: --snapshot');
      }
      snapshotId = value;
      i += 1;
      continue;
    }

    if (token === '--tab') {
      const value = args[i + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new HBError('BAD_REQUEST', 'Flag requires a value: --tab');
      }
      tabId = parseTab(value);
      i += 1;
      continue;
    }

    if (token.startsWith('--')) {
      throw new HBError('BAD_REQUEST', `Unknown flag: ${token}`);
    }

    files.push(token);
  }

  if (files.length === 0) {
    throw new HBError('BAD_REQUEST', 'upload requires at least one <file_path>');
  }

  return {
    selectorOrRef,
    files,
    snapshotId,
    tabId,
  };
}

function parseCookiesCommand(args: string[]): { command: string; args: Record<string, unknown> } {
  const sub = args[0];

  if (!sub || sub === 'get') {
    return { command: 'cookies_get', args: {} };
  }

  if (sub === 'set') {
    const name = args[1];
    const value = args[2];
    if (!name || value === undefined) {
      throw new HBError('BAD_REQUEST', 'cookies set requires <name> <value>');
    }
    const parsed = parseNamedFlags(args.slice(3), ['--url']);
    return {
      command: 'cookies_set',
      args: {
        name,
        value,
        url: parsed['--url'],
      },
    };
  }

  if (sub === 'delete') {
    const name = args[1];
    if (!name) {
      throw new HBError('BAD_REQUEST', 'cookies delete requires <name>');
    }
    const parsed = parseNamedFlags(args.slice(2), ['--url']);
    return {
      command: 'cookies_delete',
      args: {
        name,
        url: parsed['--url'],
      },
    };
  }

  if (sub === 'clear') {
    return { command: 'cookies_clear', args: {} };
  }

  throw new HBError('BAD_REQUEST', 'cookies supports get|set|delete|clear');
}

function parseNetworkCommand(args: string[]): { command: string; args: Record<string, unknown> } {
  const sub = args[0] ?? 'dump';

  if (sub === 'start') {
    const parsed = parseNamedFlags(args.slice(1), ['--tab']);
    return {
      command: 'network_start',
      args: {
        tab_id: parsed['--tab'] === undefined ? undefined : parseTab(parsed['--tab']),
      },
    };
  }

  if (sub === 'stop') {
    const parsed = parseNamedFlags(args.slice(1), ['--tab']);
    return {
      command: 'network_stop',
      args: {
        tab_id: parsed['--tab'] === undefined ? undefined : parseTab(parsed['--tab']),
      },
    };
  }

  if (sub === 'dump' || sub === 'requests') {
    const mixed = parseMixedFlags(args.slice(1), ['--filter', '--tab'], ['--clear']);
    return {
      command: 'network_dump',
      args: {
        filter: mixed.values['--filter'],
        clear: mixed.booleans.has('--clear'),
        tab_id: mixed.values['--tab'] === undefined ? undefined : parseTab(mixed.values['--tab']),
      },
    };
  }

  throw new HBError('BAD_REQUEST', 'network supports start|stop|dump|requests');
}

function parseConsoleCommand(args: string[]): { command: string; args: Record<string, unknown> } {
  const sub = args[0];

  if (sub === 'start') {
    const parsed = parseNamedFlags(args.slice(1), ['--tab']);
    return {
      command: 'console_start',
      args: {
        tab_id: parsed['--tab'] === undefined ? undefined : parseTab(parsed['--tab']),
      },
    };
  }

  if (sub === 'stop') {
    const parsed = parseNamedFlags(args.slice(1), ['--tab']);
    return {
      command: 'console_stop',
      args: {
        tab_id: parsed['--tab'] === undefined ? undefined : parseTab(parsed['--tab']),
      },
    };
  }

  if (sub === 'dump') {
    const mixed = parseMixedFlags(args.slice(1), ['--tab'], ['--clear']);
    return {
      command: 'console_dump',
      args: {
        clear: mixed.booleans.has('--clear'),
        tab_id: mixed.values['--tab'] === undefined ? undefined : parseTab(mixed.values['--tab']),
      },
    };
  }

  const mixed = parseMixedFlags(args, ['--tab'], ['--clear']);
  return {
    command: 'console_dump',
    args: {
      clear: mixed.booleans.has('--clear'),
      tab_id: mixed.values['--tab'] === undefined ? undefined : parseTab(mixed.values['--tab']),
    },
  };
}

function parseSnapshotArgs(args: string[]): { target?: number | 'active'; options: SnapshotOptions } {
  const options: SnapshotOptions = {};
  let target: number | 'active' | undefined;

  for (let i = 0; i < args.length; i += 1) {
    const token = args[i];

    if (token === '--interactive') {
      options.interactive = true;
      continue;
    }

    if (token === '--cursor') {
      options.cursor = true;
      continue;
    }

    if (token === '--compact') {
      options.compact = true;
      continue;
    }

    if (token === '--tab') {
      const value = args[i + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new HBError('BAD_REQUEST', 'Flag requires a value: --tab');
      }
      target = parseTab(value);
      i += 1;
      continue;
    }

    if (token === '--depth') {
      const value = args[i + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new HBError('BAD_REQUEST', 'Flag requires a value: --depth');
      }
      const depth = Number(value);
      if (!Number.isInteger(depth) || depth < 0) {
        throw new HBError('BAD_REQUEST', '--depth must be a non-negative integer');
      }
      options.depth = depth;
      i += 1;
      continue;
    }

    if (token === '--selector') {
      const value = args[i + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new HBError('BAD_REQUEST', 'Flag requires a value: --selector');
      }
      options.selector = value;
      i += 1;
      continue;
    }

    throw new HBError('BAD_REQUEST', `Unknown flag: ${token}`);
  }

  return { target, options };
}

function parseTab(raw: string): number | 'active' {
  if (raw === 'active') {
    return 'active';
  }

  const numeric = Number(raw);
  if (!Number.isFinite(numeric)) {
    throw new HBError('BAD_REQUEST', `tab must be numeric or active: ${raw}`);
  }

  return numeric;
}

function parseWindow(raw: string): number | 'current' {
  if (raw === 'current') {
    return 'current';
  }

  const numeric = Number(raw);
  if (!Number.isFinite(numeric)) {
    throw new HBError('BAD_REQUEST', `window must be numeric or current: ${raw}`);
  }

  return numeric;
}

function parseRefArg(raw: string): string | null {
  if (/^@e\d+$/.test(raw)) {
    return raw.slice(1);
  }

  if (/^ref=e\d+$/.test(raw)) {
    return raw.slice(4);
  }

  if (/^e\d+$/.test(raw)) {
    return raw;
  }

  return null;
}

function parseIndexArg(raw: string): number | null {
  if (!/^\d+$/.test(raw)) {
    return null;
  }
  const numeric = Number(raw);
  if (!Number.isInteger(numeric) || numeric <= 0) {
    return null;
  }
  return numeric;
}

async function callDaemon(
  config: DaemonConfig,
  command: string,
  args: Record<string, unknown>,
  options: GlobalOptions,
): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetch(`http://${config.daemon.host}:${config.daemon.port}/v1/command`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-hb-token': config.auth.token,
      },
      body: JSON.stringify({
        command,
        args,
        queue_mode: options.queueMode,
        timeout_ms: options.timeoutMs,
      }),
    });
  } catch (error) {
    throw new HBError(
      'DISCONNECTED',
      'Daemon is not reachable',
      {
        daemon_http_url: `http://${config.daemon.host}:${config.daemon.port}`,
        cause: error instanceof Error ? error.message : String(error),
      },
      {
        next_command: 'human-browser daemon',
      },
    );
  }

  let payload: DaemonApiResponse;
  try {
    payload = (await response.json()) as DaemonApiResponse;
  } catch {
    throw new HBError('INTERNAL', 'Daemon returned invalid JSON');
  }

  if (!payload.ok) {
    throw new HBError(payload.error.code, payload.error.message, payload.error.details, payload.error.recovery);
  }

  return payload.data as Record<string, unknown>;
}

function renderText(command: string, data: Record<string, unknown>): void {
  switch (command) {
    case 'state': {
      process.stdout.write(`${formatStateOutput(data)}\n`);
      return;
    }
    case 'snapshot': {
      process.stdout.write(`snapshot_id=${String(data.snapshot_id)} tab_id=${String(data.tab_id)}\n`);
      process.stdout.write(`${String(data.tree)}\n`);
      return;
    }
    case 'status':
    case 'diagnose': {
      process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
      return;
    }
    default: {
      process.stdout.write(`${JSON.stringify(data)}\n`);
    }
  }
}

function formatStateOutput(data: Record<string, unknown>): string {
  const lines = [`snapshot_id=${String(data.snapshot_id)} tab_id=${String(data.tab_id)}`];
  const refs = data.refs;
  if (!refs || typeof refs !== 'object' || Array.isArray(refs)) {
    return lines.join('\n');
  }

  const entries = Object.entries(refs as Record<string, { role?: unknown; name?: unknown; selector?: unknown; nth?: unknown }>)
    .map(([ref, meta]) => {
      const index = parseIndexArg(ref.slice(1));
      if (index === null) {
        return null;
      }
      const role = typeof meta.role === 'string' ? meta.role : 'element';
      const name = typeof meta.name === 'string' && meta.name.length > 0 ? JSON.stringify(meta.name) : '(unnamed)';
      const selector = typeof meta.selector === 'string' ? meta.selector : '';
      return {
        index,
        line: `${index}. [${role}] ${name} ${selector}`.trim(),
      };
    })
    .filter((entry): entry is { index: number; line: string } => entry !== null)
    .sort((a, b) => a.index - b.index);

  if (entries.length === 0) {
    lines.push('(no interactive elements)');
    return lines.join('\n');
  }

  for (const entry of entries) {
    lines.push(entry.line);
  }

  return lines.join('\n');
}

async function seedChromeProfile(input: {
  sourceUserDataDir: string;
  sourceProfileDirectory: string;
  targetUserDataDir: string;
  targetProfileDirectory: string;
}): Promise<void> {
  const sourceRoot = resolvePath(input.sourceUserDataDir);
  const sourceProfileDir = resolvePath(sourceRoot, input.sourceProfileDirectory);
  const targetRoot = resolvePath(input.targetUserDataDir);
  const targetProfileDir = resolvePath(targetRoot, input.targetProfileDirectory);
  const sourceLocalState = resolvePath(sourceRoot, 'Local State');
  const targetLocalState = resolvePath(targetRoot, 'Local State');

  const sourceRootStat = await safeStat(sourceRoot);
  if (!sourceRootStat?.isDirectory()) {
    throw new HBError('BAD_REQUEST', `Seed source user data dir not found: ${sourceRoot}`);
  }

  const profileStat = await safeStat(sourceProfileDir);
  if (!profileStat?.isDirectory()) {
    throw new HBError('BAD_REQUEST', `Seed source profile dir not found: ${sourceProfileDir}`);
  }

  const localStateStat = await safeStat(sourceLocalState);
  if (!localStateStat?.isFile()) {
    throw new HBError('BAD_REQUEST', `Seed source Local State not found: ${sourceLocalState}`);
  }

  await mkdir(targetRoot, { recursive: true });
  await rm(targetProfileDir, { recursive: true, force: true });
  await rm(targetLocalState, { force: true });

  await cp(sourceLocalState, targetLocalState);
  await cp(sourceProfileDir, targetProfileDir, {
    recursive: true,
    force: true,
    filter: (path) => {
      const name = path.split('/').pop() ?? '';
      if (name === 'LOCK' || name === 'SingletonLock' || name === 'SingletonCookie' || name === 'SingletonSocket') {
        return false;
      }
      return true;
    },
  });
}

async function safeStat(path: string): Promise<import('node:fs').Stats | null> {
  try {
    return await stat(path);
  } catch {
    return null;
  }
}

function printHelp(): void {
  process.stdout.write(
    [
      'human-browser CLI',
      '',
      'Usage:',
      '  human-browser [--json] [--config <path>] [--timeout <ms>] [--queue-mode hold|fail] <command> [args]',
      '',
      'Commands:',
      '  ws [--show-token]',
      '  init [--host 127.0.0.1] [--port 18765] [--max-events 500] [--force] [--show-token]',
      '       [--backend extension|cdp] [--cdp-url <http://127.0.0.1:9222|ws://...>]',
      '       [--chrome-executable <path>] [--user-data-dir <path>] [--profile-directory <name>]',
      '       [--remote-debugging-port <port>] [--chrome-arg <arg> ...]',
      '       [--seed-user-data-dir <path>] [--seed-profile-directory <name>]',
      '  rotate-token [--show-token]',
      '  daemon',
      '  status',
      '  tabs',
      '  windows',
      '  use <active|tab_id>',
      '  use-window <current|window_id>',
      '  guard-window <current|window_id>',
      '  unguard-window',
      '  new-tab <url> [--background] [--window <current|window_id>]',
      '  state [--tab <active|tab_id>] [--interactive] [--cursor] [--compact] [--depth <N>] [--selector <css>]',
      '  snapshot [--tab <active|tab_id>] [--interactive] [--cursor] [--compact] [--depth <N>] [--selector <css>]',
      '  click <selector|@ref|index> [--snapshot <snapshot_id>]',
      '  input <selector|@ref|index> <value> [--snapshot <snapshot_id>]',
      '  fill <selector|@ref|index> <value> [--snapshot <snapshot_id>]',
      '  upload <selector|@ref|index> <file_path...> [--snapshot <snapshot_id>] [--tab <active|tab_id>]',
      '  keys <key> [--tab <active|tab_id>]',
      '  keypress <key> [--tab <active|tab_id>]',
      '  scroll <x> <y> [--tab <active|tab_id>]',
      '  scroll <up|down|left|right> [amount] [--tab <active|tab_id>]',
      '  navigate <url> [--tab <active|tab_id>]',
      '  open <url> [--tab <active|tab_id>]',
      '  close [--tab <active|tab_id>]',
      '  hover <selector|@ref|index> [--snapshot <snapshot_id>]',
      '  screenshot [path] [--full] [--tab <active|tab_id>]',
      '  pdf <path> [--tab <active|tab_id>]',
      '  eval <javascript> [--tab <active|tab_id>]',
      '  get text <selector|@ref|index> [--snapshot <snapshot_id>]',
      '  get html [selector|@ref|index] [--snapshot <snapshot_id>]',
      '  wait <selector|milliseconds> [--timeout <ms>] [--tab <active|tab_id>]',
      '  wait --text <text> [--timeout <ms>] [--tab <active|tab_id>]',
      '  wait --url <pattern> [--timeout <ms>] [--tab <active|tab_id>]',
      '  wait --load <load|domcontentloaded|networkidle> [--timeout <ms>] [--tab <active|tab_id>]',
      '  wait --fn <expression> [--timeout <ms>] [--tab <active|tab_id>]',
      '  cookies [get]',
      '  cookies set <name> <value> [--url <url>]',
      '  cookies delete <name> [--url <url>]',
      '  cookies clear',
      '  network start|stop [--tab <active|tab_id>]',
      '  network dump|requests [--filter <text>] [--clear] [--tab <active|tab_id>]',
      '  console [start|stop|dump] [--clear] [--tab <active|tab_id>]',
      '  reconnect',
      '  reset',
      '  diagnose [--limit <N>]',
      '',
    ].join('\n'),
  );
}

try {
  if (isCliEntryPoint()) {
    await main();
  }
} catch (error) {
  if (isCliEntryPoint()) {
    const structured = asStructuredError(error) as StructuredError;
    process.stderr.write(`${JSON.stringify({ ok: false, error: structured }, null, 2)}\n`);
    process.exit(1);
  }
  throw error;
}

function isCliEntryPoint(): boolean {
  const argvEntry = process.argv[1];
  if (!argvEntry) {
    return false;
  }
  try {
    const currentPath = realpathSync(fileURLToPath(import.meta.url));
    const invokedPath = realpathSync(argvEntry);
    return currentPath === invokedPath;
  } catch {
    return import.meta.url === pathToFileURL(argvEntry).href;
  }
}
