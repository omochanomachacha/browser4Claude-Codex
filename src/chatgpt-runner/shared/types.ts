export type JobMode = 'chat' | 'gpt_pro' | 'deep_research';
export type ModelPreset = 'auto' | 'instant' | 'thinking' | 'pro';
export type ThinkingBudget = 'light' | 'standard' | 'extended' | 'heavy';

export type JobState =
  | 'created'
  | 'submitting'
  | 'running'
  | 'completed'
  | 'failed'
  | 'manual_action_required';

export interface JobAttachment {
  path: string;
  sha256: string;
  size: number;
}

export interface JobResultPaths {
  markdown?: string;
  html?: string;
  json?: string;
  pdf?: string;
  screenshot?: string;
}

export interface JobErrorRecord {
  code: string;
  message: string;
}

export interface JobObservation {
  observedAt: string;
  url: string;
  title: string;
  busy: boolean;
  shareButtonVisible: boolean;
  latestAssistantText: string;
  latestAssistantHash?: string;
  assistantTurnCount: number;
  generatingHint: boolean;
  loginRequired: boolean;
  captchaRequired: boolean;
  errorHint?: string;
  rawSignals: Record<string, unknown>;
}

export interface ChatGptJobRecord {
  jobId: string;
  profile: string;
  mode: JobMode;
  modelPreset?: ModelPreset;
  thinkingBudget?: ThinkingBudget;
  state: JobState;
  createdAt: string;
  updatedAt: string;
  runToken: string;
  windowId?: number;
  tabId?: number;
  conversationUrl?: string;
  promptPath: string;
  promptText: string;
  attachmentPaths: string[];
  attachments: JobAttachment[];
  outputDir: string;
  resultPaths?: JobResultPaths;
  lastObserved?: JobObservation;
  error?: JobErrorRecord;
}

export interface SubmitJobInput {
  profile: string;
  mode: JobMode;
  modelPreset?: ModelPreset;
  thinkingBudget?: ThinkingBudget;
  promptText: string;
  attachmentPaths: string[];
}

export interface SubmitJobResult {
  jobId: string;
  state: JobState;
  conversationUrl?: string;
  runToken: string;
}

export interface BrowserCommandResult<T = unknown> {
  tabId?: number;
  windowId?: number;
  url?: string;
  result?: T;
  [key: string]: unknown;
}

export interface BrowserDriverOptions {
  profile: string;
  browserCommand: string;
  browserCommandArgs?: string[];
  defaultTimeoutMs: number;
  lockPath?: string;
  initialWindowId?: number;
  initialTabId?: number;
}

export interface BrowserDriver {
  createTab(url?: string): Promise<{ tabId: number; windowId?: number }>;
  getWindowId(): number | undefined;
  getTabId(): number | undefined;
  open(url: string): Promise<BrowserCommandResult>;
  click(selector: string): Promise<BrowserCommandResult>;
  upload(selector: string, files: string[]): Promise<BrowserCommandResult>;
  pdf(path: string): Promise<BrowserCommandResult>;
  eval<T = unknown>(script: string): Promise<T>;
}
