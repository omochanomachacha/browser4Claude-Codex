import type { JobErrorRecord } from './types.ts';

export type RunnerErrorCode =
  | 'BAD_REQUEST'
  | 'JOB_NOT_FOUND'
  | 'JOB_NOT_COMPLETE'
  | 'WAIT_TIMEOUT'
  | 'MODE_NOT_SUPPORTED'
  | 'BROWSER_COMMAND_FAILED'
  | 'LOGIN_REQUIRED'
  | 'CAPTCHA_REQUIRED'
  | 'UPLOAD_FAILED'
  | 'SUBMIT_FAILED'
  | 'EXPORT_FAILED'
  | 'INTERNAL';

export class RunnerError extends Error {
  public readonly code: RunnerErrorCode;
  public readonly details?: Record<string, unknown>;

  constructor(code: RunnerErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'RunnerError';
    this.code = code;
    this.details = details;
  }
}

export function asJobErrorRecord(error: unknown): JobErrorRecord {
  if (error instanceof RunnerError) {
    return {
      code: error.code,
      message: error.message,
    };
  }

  if (error instanceof Error) {
    return {
      code: 'INTERNAL',
      message: error.message,
    };
  }

  return {
    code: 'INTERNAL',
    message: 'Unknown error',
  };
}
