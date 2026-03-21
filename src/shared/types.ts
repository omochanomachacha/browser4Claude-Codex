export type QueueMode = 'hold' | 'fail';

export type ErrorCode =
  | 'DISCONNECTED'
  | 'TIMEOUT'
  | 'NO_SUCH_REF'
  | 'STALE_SNAPSHOT'
  | 'NO_ACTIVE_SNAPSHOT'
  | 'BAD_REQUEST'
  | 'EXTENSION_ERROR'
  | 'UNAUTHORIZED'
  | 'INTERNAL';

export interface RecoveryHints {
  reconnect_required?: boolean;
  reset_session_recommended?: boolean;
  next_command?: string;
}

export interface StructuredError {
  code: ErrorCode;
  message: string;
  details?: Record<string, unknown>;
  recovery?: RecoveryHints;
}

export interface DaemonResponse<T = unknown> {
  ok: true;
  data: T;
}

export interface DaemonErrorResponse {
  ok: false;
  error: StructuredError;
}

export type DaemonApiResponse<T = unknown> = DaemonResponse<T> | DaemonErrorResponse;

export interface SnapshotRef {
  selector: string;
  role: string;
  name?: string;
  nth?: number;
}

export interface SnapshotData {
  snapshot_id: string;
  tab_id: number;
  window_id?: number;
  tree: string;
  refs: Record<string, SnapshotRef>;
  created_at: string;
}

export interface SnapshotOptions {
  interactive?: boolean;
  cursor?: boolean;
  compact?: boolean;
  depth?: number;
  selector?: string;
}

export interface DaemonEvent {
  id: string;
  at: string;
  level: 'info' | 'warn' | 'error';
  kind: string;
  message: string;
  details?: Record<string, unknown>;
}

export interface DiagnosticsReport {
  now: string;
  extension: {
    connected: boolean;
    connected_at?: string;
    last_ping_at?: string;
    last_disconnect_reason?: string;
    backend?: 'extension' | 'cdp';
    backend_status?: Record<string, unknown>;
  };
  session: {
    selected_tab_id?: number;
    selected_window_id?: number;
    guarded_window_id?: number;
    latest_snapshot_id?: string;
  };
  events: DaemonEvent[];
  disconnect_history: Array<{ at: string; reason: string }>;
  reconnect_history: Array<{ at: string; reason: string }>;
}

export interface DaemonConfig {
  daemon: {
    host: string;
    port: number;
  };
  auth: {
    token: string;
  };
  diagnostics: {
    max_events: number;
  };
  backend?: {
    type: 'extension' | 'cdp';
  };
  cdp?: {
    browser_ws_url?: string;
    browser_http_url?: string;
    executable_path?: string;
    user_data_dir?: string;
    profile_directory?: string;
    remote_debugging_port?: number;
    launch_args?: string[];
  };
}

export interface SnapshotNode {
  role: string;
  name?: string;
  selector: string;
  suffix?: string;
}

export interface ExtensionCommandEnvelope {
  type: 'COMMAND';
  request_id: string;
  command: string;
  payload: Record<string, unknown>;
}

export interface ExtensionResultEnvelope {
  type: 'RESULT';
  request_id: string;
  ok: boolean;
  result?: Record<string, unknown>;
  error?: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
}

export interface ExtensionPingEnvelope {
  type: 'PING';
  ts: string;
}

export interface ExtensionPongEnvelope {
  type: 'PONG';
  ts: string;
}

export interface ExtensionKeepaliveEnvelope {
  type: 'KEEPALIVE';
  ts: string;
}

export interface ExtensionHelloEnvelope {
  type: 'HELLO';
  version: string;
  retry_count: number;
}

export interface ExtensionEventEnvelope {
  type: 'EVENT';
  name: string;
  payload?: Record<string, unknown>;
}

export type ExtensionToDaemonEnvelope =
  | ExtensionResultEnvelope
  | ExtensionPongEnvelope
  | ExtensionKeepaliveEnvelope
  | ExtensionHelloEnvelope
  | ExtensionEventEnvelope;

export type DaemonToExtensionEnvelope = ExtensionCommandEnvelope | ExtensionPingEnvelope;
