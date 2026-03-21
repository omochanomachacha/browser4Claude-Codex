#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import * as z from 'zod/v4';
import {
  DEFAULT_BROWSER_COMMAND,
  DEFAULT_BROWSER_COMMAND_ARGS,
  DEFAULT_TIMEOUT_MS,
  ensureRunnerHome,
  readRunnerState,
} from '../chatgpt-runner/shared/config.ts';
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

async function main(): Promise<void> {
  const runnerHome = await ensureRunnerHome(process.env.CHATGPT_RUNNER_HOME);
  const runnerState = await readRunnerState(runnerHome);
  const context: RunnerContext = {
    runnerHome,
    browserCommand: process.env.CHATGPT_RUNNER_BROWSER_COMMAND || DEFAULT_BROWSER_COMMAND,
    browserCommandArgs: process.env.CHATGPT_RUNNER_BROWSER_COMMAND ? [] : DEFAULT_BROWSER_COMMAND_ARGS,
    guardedWindowId: runnerState.guardedWindowId,
    timeoutMs: Number(process.env.CHATGPT_RUNNER_TIMEOUT_MS || DEFAULT_TIMEOUT_MS),
  };

  const server = new McpServer({
    name: 'chatgpt-runner',
    version: '0.1.0',
  });

  server.registerTool(
    'chatgpt_submit',
    {
      description: 'Submit a ChatGPT job via the local browser-backed subscription session.',
      inputSchema: {
        profile: z.string(),
        mode: z.enum(['chat', 'gpt_pro', 'deep_research']).default('chat'),
        prompt: z.string(),
        attachments: z.array(z.string()).optional(),
        model: z.enum(['auto', 'instant', 'thinking', 'pro', 'extended-pro']).optional(),
        thinking_budget: z.enum(['light', 'standard', 'extended', 'heavy']).optional(),
      },
    },
    async ({ profile, mode, prompt, attachments, model, thinking_budget }) => {
      const result = await submitJob(context, {
        profile,
        mode: normalizeMode(mode),
        modelPreset: normalizeModelPreset(model),
        thinkingBudget: normalizeThinkingBudget(thinking_budget),
        promptText: prompt,
        attachmentPaths: attachments ?? [],
      });
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }], structuredContent: result };
    },
  );

  server.registerTool(
    'chatgpt_status',
    {
      description: 'Refresh and return the current status of a ChatGPT job.',
      inputSchema: { job_id: z.string() },
    },
    async ({ job_id }) => {
      const record = await refreshJobStatus(context, job_id);
      const payload = { ...summarizeJob(record), observation: summarizeObservation(record.lastObserved) };
      return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }], structuredContent: payload };
    },
  );

  server.registerTool(
    'chatgpt_wait',
    {
      description: 'Poll a ChatGPT job until completion or timeout.',
      inputSchema: {
        job_id: z.string(),
        timeout_ms: z.number().optional(),
        poll_interval_ms: z.number().optional(),
      },
    },
    async ({ job_id, timeout_ms, poll_interval_ms }) => {
      const record = await waitForJob(context, job_id, timeout_ms ?? 60_000, poll_interval_ms ?? 2_000);
      const payload = { ...summarizeJob(record), observation: summarizeObservation(record.lastObserved) };
      return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }], structuredContent: payload };
    },
  );

  server.registerTool(
    'chatgpt_fetch',
    {
      description: 'Fetch the final markdown result of a completed ChatGPT job.',
      inputSchema: { job_id: z.string() },
    },
    async ({ job_id }) => {
      const record = await fetchJobResult(context, job_id);
      const payload = { ...summarizeJob(record), observation: summarizeObservation(record.lastObserved) };
      return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }], structuredContent: payload };
    },
  );

  server.registerTool(
    'chatgpt_export',
    {
      description: 'Export a ChatGPT job result as markdown, html, or pdf.',
      inputSchema: {
        job_id: z.string(),
        format: z.enum(['markdown', 'html', 'pdf']).default('markdown'),
      },
    },
    async ({ job_id, format }) => {
      const record = await exportJob(context, job_id, format);
      const payload = { ...summarizeJob(record), observation: summarizeObservation(record.lastObserved) };
      return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }], structuredContent: payload };
    },
  );

  server.registerTool(
    'chatgpt_resume',
    {
      description: 'Resume a persisted job by re-observing its current state.',
      inputSchema: { job_id: z.string() },
    },
    async ({ job_id }) => {
      const record = await resumeJob(context, job_id);
      const payload = { ...summarizeJob(record), observation: summarizeObservation(record.lastObserved) };
      return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }], structuredContent: payload };
    },
  );

  server.registerTool(
    'chatgpt_list',
    {
      description: 'List locally persisted ChatGPT jobs.',
      inputSchema: {
        state: z.enum(['created', 'submitting', 'running', 'completed', 'failed', 'manual_action_required']).optional(),
      },
    },
    async ({ state }) => {
      const jobs = (await listJobs(context, state)).map((record) => summarizeJob(record));
      return {
        content: [{ type: 'text', text: JSON.stringify(jobs, null, 2) }],
        structuredContent: { jobs },
      };
    },
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
