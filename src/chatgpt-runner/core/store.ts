import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { RunnerError } from '../shared/errors.ts';
import type { ChatGptJobRecord, JobAttachment, JobObservation, JobState, SubmitJobInput } from '../shared/types.ts';
import { ensureRunnerHome, jobsDir } from '../shared/config.ts';

export async function createDraftJob(runnerHome: string, input: SubmitJobInput): Promise<ChatGptJobRecord> {
  await ensureRunnerHome(runnerHome);
  const jobId = buildJobId();
  const jobDir = join(jobsDir(runnerHome), jobId);
  await mkdir(jobDir, { recursive: true });
  await mkdir(join(jobDir, 'snapshots'), { recursive: true });
  await mkdir(join(jobDir, 'screenshots'), { recursive: true });
  await mkdir(join(jobDir, 'diagnose'), { recursive: true });
  await mkdir(join(jobDir, 'console'), { recursive: true });
  await mkdir(join(jobDir, 'network'), { recursive: true });

  const promptPath = join(jobDir, 'prompt.md');
  await writeFile(promptPath, input.promptText, 'utf8');

  const attachments = await buildAttachmentManifest(input.attachmentPaths);
  const now = new Date().toISOString();
  const record: ChatGptJobRecord = {
    jobId,
    profile: input.profile,
    mode: input.mode,
    modelPreset: input.modelPreset,
    thinkingBudget: input.thinkingBudget,
    state: 'created',
    createdAt: now,
    updatedAt: now,
    runToken: `RUN-${randomUUID()}`,
    windowId: undefined,
    promptPath,
    promptText: input.promptText,
    attachmentPaths: input.attachmentPaths,
    attachments,
    outputDir: jobDir,
  };

  await writeJobRecord(runnerHome, record);
  await writeFile(join(jobDir, 'attachments.json'), `${JSON.stringify(attachments, null, 2)}\n`, 'utf8');
  return record;
}

export async function readJobRecord(runnerHome: string, jobId: string): Promise<ChatGptJobRecord> {
  try {
    const raw = await readFile(jobFilePath(runnerHome, jobId), 'utf8');
    return JSON.parse(raw) as ChatGptJobRecord;
  } catch {
    throw new RunnerError('JOB_NOT_FOUND', `Job not found: ${jobId}`, { job_id: jobId });
  }
}

export async function writeJobRecord(runnerHome: string, record: ChatGptJobRecord): Promise<void> {
  const next = {
    ...record,
    updatedAt: new Date().toISOString(),
  };
  await mkdir(join(jobsDir(runnerHome), record.jobId), { recursive: true });
  await writeFile(jobFilePath(runnerHome, record.jobId), `${JSON.stringify(next, null, 2)}\n`, 'utf8');
}

export async function updateJobState(
  runnerHome: string,
  record: ChatGptJobRecord,
  state: JobState,
  patch: Partial<ChatGptJobRecord> = {},
): Promise<ChatGptJobRecord> {
  const next: ChatGptJobRecord = {
    ...record,
    ...patch,
    state,
    updatedAt: new Date().toISOString(),
  };
  await writeJobRecord(runnerHome, next);
  return next;
}

export async function updateJobObservation(
  runnerHome: string,
  record: ChatGptJobRecord,
  observation: JobObservation,
): Promise<ChatGptJobRecord> {
  const next: ChatGptJobRecord = {
    ...record,
    lastObserved: observation,
    updatedAt: new Date().toISOString(),
  };
  await writeJobRecord(runnerHome, next);
  await writeFile(join(record.outputDir, 'status.json'), `${JSON.stringify(observation, null, 2)}\n`, 'utf8');
  return next;
}

export async function persistMarkdownResult(
  runnerHome: string,
  record: ChatGptJobRecord,
  markdown: string,
): Promise<ChatGptJobRecord> {
  const markdownPath = join(record.outputDir, 'result.md');
  await writeFile(markdownPath, markdown, 'utf8');
  const next: ChatGptJobRecord = {
    ...record,
    resultPaths: {
      ...record.resultPaths,
      markdown: markdownPath,
    },
    updatedAt: new Date().toISOString(),
  };
  await writeJobRecord(runnerHome, next);
  return next;
}

export async function mergeJobResultPaths(
  runnerHome: string,
  record: ChatGptJobRecord,
  patch: NonNullable<ChatGptJobRecord['resultPaths']>,
): Promise<ChatGptJobRecord> {
  const next: ChatGptJobRecord = {
    ...record,
    resultPaths: {
      ...record.resultPaths,
      ...patch,
    },
    updatedAt: new Date().toISOString(),
  };
  await writeJobRecord(runnerHome, next);
  return next;
}

export async function listJobRecords(
  runnerHome: string,
  filterState?: JobState,
): Promise<ChatGptJobRecord[]> {
  await ensureRunnerHome(runnerHome);
  const entries = await readdir(jobsDir(runnerHome), { withFileTypes: true });
  const jobs: ChatGptJobRecord[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    try {
      const job = await readJobRecord(runnerHome, entry.name);
      if (!filterState || job.state === filterState) {
        jobs.push(job);
      }
    } catch {
      // Ignore malformed entries to keep list resilient.
    }
  }

  return jobs.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

export function jobFilePath(runnerHome: string, jobId: string): string {
  return join(jobsDir(runnerHome), jobId, 'job.json');
}

function buildJobId(): string {
  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
  return `cgpt_${stamp}_${randomUUID().slice(0, 8)}`;
}

async function buildAttachmentManifest(paths: string[]): Promise<JobAttachment[]> {
  const manifest: JobAttachment[] = [];
  for (const filePath of paths) {
    const fileStat = await stat(filePath);
    if (!fileStat.isFile()) {
      throw new RunnerError('BAD_REQUEST', `Attachment is not a file: ${filePath}`, { path: filePath });
    }
    const content = await readFile(filePath);
    manifest.push({
      path: filePath,
      sha256: createHash('sha256').update(content).digest('hex'),
      size: fileStat.size,
    });
  }
  return manifest;
}
