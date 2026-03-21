#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import { RunnerError } from '../chatgpt-runner/shared/errors.ts';
import {
  DEFAULT_BROWSER_COMMAND,
  DEFAULT_BROWSER_COMMAND_ARGS,
  DEFAULT_TIMEOUT_MS,
  ensureRunnerHome,
  readRunnerState,
} from '../chatgpt-runner/shared/config.ts';
import type { JobState } from '../chatgpt-runner/shared/types.ts';
import {
  exportJob,
  fetchJobResult,
  listJobs,
  normalizeModelPreset,
  normalizeMode,
  normalizeThinkingBudget,
  refreshJobStatus,
  resumeJob,
  submitJob,
  summarizeJob,
  summarizeObservation,
  type RunnerContext,
  waitForJob,
} from '../chatgpt-runner/core/runner.ts';

interface GlobalOptions {
  json: boolean;
  runnerHome?: string;
  browserCommand: string;
  timeoutMs: number;
}

interface ParsedArgs {
  command: string;
  args: string[];
  options: GlobalOptions;
}

async function main(): Promise<void> {
  try {
    const parsed = parseGlobalArgs(process.argv.slice(2));
    const runnerHome = await ensureRunnerHome(parsed.options.runnerHome);
    const runnerState = await readRunnerState(runnerHome);
    const context: RunnerContext = {
      runnerHome,
      browserCommand: parsed.options.browserCommand,
      browserCommandArgs: parsed.options.browserCommand === DEFAULT_BROWSER_COMMAND ? DEFAULT_BROWSER_COMMAND_ARGS : [],
      guardedWindowId: runnerState.guardedWindowId,
      timeoutMs: parsed.options.timeoutMs,
    };

    switch (parsed.command) {
      case 'submit':
        await commandSubmit(context, parsed.args, parsed.options);
        return;
      case 'status':
        await commandStatus(context, parsed.args, parsed.options);
        return;
      case 'fetch':
        await commandFetch(context, parsed.args, parsed.options);
        return;
      case 'wait':
        await commandWait(context, parsed.args, parsed.options);
        return;
      case 'resume':
        await commandResume(context, parsed.args, parsed.options);
        return;
      case 'export':
        await commandExport(context, parsed.args, parsed.options);
        return;
      case 'list':
        await commandList(context, parsed.args, parsed.options);
        return;
      case 'help':
      default:
        printHelp();
    }
  } catch (error) {
    handleError(error);
  }
}

function parseGlobalArgs(argv: string[]): ParsedArgs {
  const args = [...argv];
  let json = false;
  let runnerHome: string | undefined;
  let browserCommand = DEFAULT_BROWSER_COMMAND;
  let timeoutMs = DEFAULT_TIMEOUT_MS;

  while (args.length > 0) {
    const token = args[0];
    if (!token?.startsWith('--')) {
      break;
    }
    args.shift();

    if (token === '--json') {
      json = true;
      continue;
    }
    if (token === '--runner-home') {
      runnerHome = requireValue(args, '--runner-home');
      continue;
    }
    if (token === '--browser-command') {
      browserCommand = requireValue(args, '--browser-command');
      continue;
    }
    if (token === '--timeout') {
      const raw = requireValue(args, '--timeout');
      const parsed = Number(raw);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new RunnerError('BAD_REQUEST', '--timeout must be a positive integer');
      }
      timeoutMs = parsed;
      continue;
    }
    throw new RunnerError('BAD_REQUEST', `Unknown option: ${token}`);
  }

  return {
    command: args.shift() ?? 'help',
    args,
    options: {
      json,
      runnerHome,
      browserCommand,
      timeoutMs,
    },
  };
}

async function commandSubmit(context: RunnerContext, args: string[], options: GlobalOptions): Promise<void> {
  let profile = '';
  let mode = 'chat';
  let model = '';
  let thinkingBudget = '';
  let prompt = '';
  let promptFile = '';
  const attachments: string[] = [];

  while (args.length > 0) {
    const token = args.shift();
    if (!token) {
      break;
    }
    if (token === '--profile') {
      profile = requireValue(args, '--profile');
      continue;
    }
    if (token === '--mode') {
      mode = requireValue(args, '--mode');
      continue;
    }
    if (token === '--model') {
      model = requireValue(args, '--model');
      continue;
    }
    if (token === '--thinking-budget') {
      thinkingBudget = requireValue(args, '--thinking-budget');
      continue;
    }
    if (token === '--prompt') {
      prompt = requireValue(args, '--prompt');
      continue;
    }
    if (token === '--prompt-file') {
      promptFile = requireValue(args, '--prompt-file');
      continue;
    }
    if (token === '--attach') {
      attachments.push(requireValue(args, '--attach'));
      continue;
    }
    throw new RunnerError('BAD_REQUEST', `Unknown submit option: ${token}`);
  }

  if (!profile) {
    throw new RunnerError('BAD_REQUEST', '--profile is required');
  }
  if (!prompt && !promptFile) {
    throw new RunnerError('BAD_REQUEST', '--prompt or --prompt-file is required');
  }
  if (prompt && promptFile) {
    throw new RunnerError('BAD_REQUEST', 'Use either --prompt or --prompt-file, not both');
  }

  const normalizedMode = normalizeMode(mode);
  const normalizedModel = normalizeModelPreset(model);
  const normalizedBudget = normalizeThinkingBudget(thinkingBudget);
  const promptText = promptFile ? await readFile(promptFile, 'utf8') : prompt;
  const result = await submitJob(context, {
    profile,
    mode: normalizedMode,
    modelPreset: normalizedMode === 'gpt_pro' && !normalizedModel ? 'pro' : normalizedModel,
    thinkingBudget: normalizedBudget,
    promptText,
    attachmentPaths: attachments,
  });

  printResult(
    options.json,
    {
      ok: true,
      data: result,
    },
    `submitted ${result.jobId} (${result.state})`,
  );
}

async function commandStatus(context: RunnerContext, args: string[], options: GlobalOptions): Promise<void> {
  const jobId = args.shift();
  if (!jobId) {
    throw new RunnerError('BAD_REQUEST', 'status requires <job_id>');
  }
  const record = await refreshJobStatus(context, jobId);
  printResult(
    options.json,
    {
      ok: true,
      data: {
        ...summarizeJob(record),
        observation: summarizeObservation(record.lastObserved),
      },
    },
    `${record.jobId}: ${record.state}`,
  );
}

async function commandFetch(context: RunnerContext, args: string[], options: GlobalOptions): Promise<void> {
  const jobId = args.shift();
  if (!jobId) {
    throw new RunnerError('BAD_REQUEST', 'fetch requires <job_id>');
  }
  const record = await fetchJobResult(context, jobId);
  printResult(
    options.json,
    {
      ok: true,
      data: {
        ...summarizeJob(record),
        observation: summarizeObservation(record.lastObserved),
      },
    },
    record.resultPaths?.markdown ?? `${record.jobId}: completed`,
  );
}

async function commandWait(context: RunnerContext, args: string[], options: GlobalOptions): Promise<void> {
  const jobId = args.shift();
  if (!jobId) {
    throw new RunnerError('BAD_REQUEST', 'wait requires <job_id>');
  }
  let timeoutMs = 60_000;
  let pollIntervalMs = 2_000;

  while (args.length > 0) {
    const token = args.shift();
    if (token === '--timeout-ms') {
      timeoutMs = Number(requireValue(args, '--timeout-ms'));
      continue;
    }
    if (token === '--poll-interval-ms') {
      pollIntervalMs = Number(requireValue(args, '--poll-interval-ms'));
      continue;
    }
    throw new RunnerError('BAD_REQUEST', `Unknown wait option: ${token}`);
  }

  const record = await waitForJob(context, jobId, timeoutMs, pollIntervalMs);
  printResult(
    options.json,
    {
      ok: true,
      data: {
        ...summarizeJob(record),
        observation: summarizeObservation(record.lastObserved),
      },
    },
    `${record.jobId}: ${record.state}`,
  );
}

async function commandResume(context: RunnerContext, args: string[], options: GlobalOptions): Promise<void> {
  const jobId = args.shift();
  if (!jobId) {
    throw new RunnerError('BAD_REQUEST', 'resume requires <job_id>');
  }
  const record = await resumeJob(context, jobId);
  printResult(
    options.json,
    {
      ok: true,
      data: {
        ...summarizeJob(record),
        observation: summarizeObservation(record.lastObserved),
      },
    },
    `${record.jobId}: ${record.state}`,
  );
}

async function commandExport(context: RunnerContext, args: string[], options: GlobalOptions): Promise<void> {
  const jobId = args.shift();
  if (!jobId) {
    throw new RunnerError('BAD_REQUEST', 'export requires <job_id>');
  }
  let format: 'markdown' | 'html' | 'pdf' = 'markdown';

  while (args.length > 0) {
    const token = args.shift();
    if (token === '--format') {
      const value = requireValue(args, '--format');
      if (value !== 'markdown' && value !== 'html' && value !== 'pdf') {
        throw new RunnerError('BAD_REQUEST', `Unsupported export format: ${value}`);
      }
      format = value;
      continue;
    }
    throw new RunnerError('BAD_REQUEST', `Unknown export option: ${token}`);
  }

  const record = await exportJob(context, jobId, format);
  printResult(
    options.json,
    {
      ok: true,
      data: {
        ...summarizeJob(record),
        observation: summarizeObservation(record.lastObserved),
      },
    },
    record.resultPaths?.[format] ?? `${record.jobId}: exported ${format}`,
  );
}

async function commandList(context: RunnerContext, args: string[], options: GlobalOptions): Promise<void> {
  let state: JobState | undefined;
  while (args.length > 0) {
    const token = args.shift();
    if (token === '--state') {
      state = requireValue(args, '--state') as JobState;
      continue;
    }
    throw new RunnerError('BAD_REQUEST', `Unknown list option: ${token}`);
  }
  const jobs = await listJobs(context, state);
  printResult(
    options.json,
    {
      ok: true,
      data: jobs.map((job) => summarizeJob(job)),
    },
    jobs.map((job) => `${job.jobId}\t${job.state}\t${job.mode}`).join('\n'),
  );
}

function requireValue(args: string[], flag: string): string {
  const value = args.shift();
  if (!value) {
    throw new RunnerError('BAD_REQUEST', `${flag} requires a value`);
  }
  return value;
}

function printResult(json: boolean, payload: Record<string, unknown>, text: string): void {
  if (json) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return;
  }
  process.stdout.write(`${text}\n`);
}

function handleError(error: unknown): never {
  if (error instanceof RunnerError) {
    process.stderr.write(
      `${JSON.stringify({ ok: false, error: { code: error.code, message: error.message, details: error.details } }, null, 2)}\n`,
    );
    process.exit(1);
  }

  if (error instanceof Error) {
    process.stderr.write(`${JSON.stringify({ ok: false, error: { code: 'INTERNAL', message: error.message } }, null, 2)}\n`);
    process.exit(1);
  }

  process.stderr.write(`${JSON.stringify({ ok: false, error: { code: 'INTERNAL', message: 'Unknown error' } }, null, 2)}\n`);
  process.exit(1);
}

function printHelp(): void {
  process.stdout.write(`chatgpt-runner

Usage:
  chatgpt-runner [--json] [--runner-home PATH] [--browser-command CMD] [--timeout MS] <command>

Commands:
  submit --profile <name> [--mode chat|gpt_pro|deep_research] [--model auto|instant|thinking|pro|extended-pro] [--thinking-budget light|standard|extended|heavy] (--prompt TEXT | --prompt-file FILE) [--attach FILE...]
  status <job_id>
  fetch <job_id>
  wait <job_id> [--timeout-ms N] [--poll-interval-ms N]
  resume <job_id>
  export <job_id> [--format markdown|html|pdf]
  list [--state created|submitting|running|completed|failed|manual_action_required]
`);
}

void main();
