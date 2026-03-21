import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { asJobErrorRecord, RunnerError } from '../shared/errors.ts';
import { DEFAULT_BROWSER_COMMAND_ARGS } from '../shared/config.ts';
import type {
  ChatGptJobRecord,
  ModelPreset,
  JobMode,
  JobObservation,
  JobState,
  SubmitJobInput,
  SubmitJobResult,
  ThinkingBudget,
} from '../shared/types.ts';
import { ChatGptWebAdapter, classifyObservation } from '../chatgpt-web/adapter.ts';
import { HumanBrowserDriver } from '../driver/human-browser.ts';
import {
  createDraftJob,
  listJobRecords,
  mergeJobResultPaths,
  persistMarkdownResult,
  readJobRecord,
  updateJobObservation,
  updateJobState,
} from './store.ts';

export interface RunnerContext {
  runnerHome: string;
  browserCommand: string;
  browserCommandArgs?: string[];
  guardedWindowId?: number;
  timeoutMs: number;
}

export async function submitJob(context: RunnerContext, input: SubmitJobInput): Promise<SubmitJobResult> {
  const draft = await createDraftJob(context.runnerHome, input);
  const runner = createAdapter(context, draft.profile, draft.windowId ?? context.guardedWindowId, draft.tabId);
  let current = await updateJobState(context.runnerHome, draft, 'submitting');

  try {
    const submitResult = await runner.submit(current);
    current = await updateJobState(context.runnerHome, current, 'running', {
      windowId: submitResult.windowId,
      tabId: submitResult.tabId,
      conversationUrl: submitResult.conversationUrl,
    });
    return {
      jobId: current.jobId,
      state: current.state,
      conversationUrl: current.conversationUrl,
      runToken: current.runToken,
    };
  } catch (error) {
    current = await updateJobState(context.runnerHome, current, classifyErrorState(error), {
      error: asJobErrorRecord(error),
    });
    throw error;
  }
}

export async function refreshJobStatus(context: RunnerContext, jobId: string): Promise<ChatGptJobRecord> {
  let current = await readJobRecord(context.runnerHome, jobId);
  const runner = createAdapter(context, current.profile, current.windowId ?? context.guardedWindowId, current.tabId);

  try {
    const observation = await runner.observe(current);
    current = await updateJobObservation(context.runnerHome, current, observation);
    const nextState = classifyObservation(observation);
    current = await updateJobState(context.runnerHome, current, nextState, {
      windowId: runner.getWindowId(),
      tabId: runner.getTabId(),
      conversationUrl: observation.url || current.conversationUrl,
      error: undefined,
    });
    if (nextState === 'completed' && observation.latestAssistantText) {
      current = await persistMarkdownResult(context.runnerHome, current, observation.latestAssistantText);
    }
    return current;
  } catch (error) {
    current = await updateJobState(context.runnerHome, current, classifyErrorState(error), {
      error: asJobErrorRecord(error),
    });
    throw error;
  }
}

export async function fetchJobResult(context: RunnerContext, jobId: string): Promise<ChatGptJobRecord> {
  let current = await readJobRecord(context.runnerHome, jobId);
  if (current.resultPaths?.markdown) {
    return current;
  }

  current = await refreshJobStatus(context, jobId);
  if (!current.resultPaths?.markdown) {
    throw new RunnerError('JOB_NOT_COMPLETE', `Job is not complete yet: ${jobId}`, {
      job_id: jobId,
      state: current.state,
    });
  }

  return current;
}

export async function waitForJob(
  context: RunnerContext,
  jobId: string,
  timeoutMs = 60_000,
  pollIntervalMs = 2_000,
): Promise<ChatGptJobRecord> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const current = await refreshJobStatus(context, jobId);
    if (current.state === 'completed' || current.state === 'failed' || current.state === 'manual_action_required') {
      return current;
    }
    await sleep(pollIntervalMs);
  }

  throw new RunnerError('WAIT_TIMEOUT', `Timed out waiting for job: ${jobId}`, {
    job_id: jobId,
    timeout_ms: timeoutMs,
  });
}

export async function resumeJob(context: RunnerContext, jobId: string): Promise<ChatGptJobRecord> {
  return refreshJobStatus(context, jobId);
}

export async function exportJob(
  context: RunnerContext,
  jobId: string,
  format: 'markdown' | 'html' | 'pdf',
): Promise<ChatGptJobRecord> {
  let current = await readJobRecord(context.runnerHome, jobId);
  await mkdir(current.outputDir, { recursive: true });

  if (format === 'markdown') {
    return fetchJobResult(context, jobId);
  }

  if (format === 'html') {
    current = await fetchJobResult(context, jobId);
    const markdownPath = current.resultPaths?.markdown;
    if (!markdownPath) {
      throw new RunnerError('EXPORT_FAILED', `No markdown result available for job: ${jobId}`, {
        job_id: jobId,
      });
    }
    const markdown = await readFile(markdownPath, 'utf8');
    const htmlPath = join(current.outputDir, 'result.html');
    await writeFile(htmlPath, renderHtmlExport(current, markdown), 'utf8');
    return mergeJobResultPaths(context.runnerHome, current, { html: htmlPath });
  }

  if (!current.conversationUrl) {
    throw new RunnerError('EXPORT_FAILED', `No conversation URL available for job: ${jobId}`, {
      job_id: jobId,
    });
  }

  const runner = createAdapter(context, current.profile, current.windowId, current.tabId);
  const pdfPath = join(current.outputDir, `${basename(current.outputDir)}.pdf`);
  await runner.exportPdf(current.conversationUrl, pdfPath);
  return mergeJobResultPaths(context.runnerHome, current, { pdf: pdfPath });
}

export async function listJobs(context: RunnerContext, state?: JobState): Promise<ChatGptJobRecord[]> {
  return listJobRecords(context.runnerHome, state);
}

function createAdapter(context: RunnerContext, profile: string, initialWindowId?: number, initialTabId?: number): ChatGptWebAdapter {
  return new ChatGptWebAdapter(
    new HumanBrowserDriver({
      profile,
      browserCommand: context.browserCommand,
      browserCommandArgs: context.browserCommandArgs ?? DEFAULT_BROWSER_COMMAND_ARGS,
      defaultTimeoutMs: context.timeoutMs,
      lockPath: join(context.runnerHome, '.browser-lock'),
      initialWindowId,
      initialTabId,
    }),
  );
}

function classifyErrorState(error: unknown): JobState {
  if (error instanceof RunnerError && (error.code === 'LOGIN_REQUIRED' || error.code === 'CAPTCHA_REQUIRED')) {
    return 'manual_action_required';
  }
  return 'failed';
}

export function normalizeMode(mode?: string): JobMode {
  if (!mode || mode === 'chat') {
    return 'chat';
  }
  if (mode === 'gpt_pro' || mode === 'deep_research') {
    return mode;
  }
  throw new RunnerError('BAD_REQUEST', `Unsupported mode: ${mode}`, { mode });
}

export function normalizeModelPreset(model?: string): ModelPreset | undefined {
  if (!model) {
    return undefined;
  }

  const normalized = model.toLowerCase().replaceAll('-', '_');
  if (normalized === 'extended_pro') {
    return 'pro';
  }
  if (normalized === 'auto' || normalized === 'instant' || normalized === 'thinking' || normalized === 'pro') {
    return normalized;
  }

  throw new RunnerError('BAD_REQUEST', `Unsupported model preset: ${model}`, { model });
}

export function normalizeThinkingBudget(budget?: string): ThinkingBudget | undefined {
  if (!budget) {
    return undefined;
  }

  const normalized = budget.toLowerCase();
  if (normalized === 'light' || normalized === 'standard' || normalized === 'extended' || normalized === 'heavy') {
    return normalized;
  }

  throw new RunnerError('BAD_REQUEST', `Unsupported thinking budget: ${budget}`, { budget });
}

export function summarizeJob(record: ChatGptJobRecord): Record<string, unknown> {
  return {
    job_id: record.jobId,
    state: record.state,
    mode: record.mode,
    model: record.modelPreset,
    thinking_budget: record.thinkingBudget,
    profile: record.profile,
    window_id: record.windowId,
    tab_id: record.tabId,
    conversation_url: record.conversationUrl,
    updated_at: record.updatedAt,
    latest_assistant_hash: record.lastObserved?.latestAssistantHash,
    result_markdown: record.resultPaths?.markdown,
    result_html: record.resultPaths?.html,
    result_pdf: record.resultPaths?.pdf,
    error: record.error,
  };
}

export function summarizeObservation(observation?: JobObservation): Record<string, unknown> | undefined {
  if (!observation) {
    return undefined;
  }
  return {
    observed_at: observation.observedAt,
    url: observation.url,
    busy: observation.busy,
    assistant_turn_count: observation.assistantTurnCount,
    latest_assistant_hash: observation.latestAssistantHash,
    generating_hint: observation.generatingHint,
    error_hint: observation.errorHint,
  };
}

function renderHtmlExport(record: ChatGptJobRecord, markdown: string): string {
  const escaped = markdown.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <title>${escapeHtml(record.jobId)}</title>
    <style>
      body { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; margin: 32px; line-height: 1.5; }
      pre { white-space: pre-wrap; word-break: break-word; }
      .meta { color: #555; margin-bottom: 24px; }
    </style>
  </head>
  <body>
    <div class="meta">
      <div>job: ${escapeHtml(record.jobId)}</div>
      <div>mode: ${escapeHtml(record.mode)}</div>
      <div>profile: ${escapeHtml(record.profile)}</div>
      <div>conversation: ${escapeHtml(record.conversationUrl ?? '')}</div>
    </div>
    <pre>${escaped}</pre>
  </body>
</html>
`;
}

function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
