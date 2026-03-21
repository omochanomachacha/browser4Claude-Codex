import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocket } from 'ws';
import { HBError } from '../shared/errors.ts';
import type { DaemonConfig } from '../shared/types.ts';

const SNAPSHOT_SCRIPT = `(input) => {
  const MAX_NODES = 300;
  const INTERACTIVE_ROLES = new Set([
    'button','link','textbox','checkbox','radio','combobox','listbox','menuitem','menuitemcheckbox',
    'menuitemradio','option','searchbox','slider','spinbutton','switch','tab','treeitem',
  ]);
  const CONTENT_ROLES = new Set([
    'heading','paragraph','listitem','article','main','navigation','region','cell','gridcell',
    'columnheader','rowheader','label',
  ]);
  const STRUCTURAL_ROLES = new Set([
    'generic','group','list','table','row','rowgroup','grid','menu','toolbar','tablist',
    'tree','document','application','presentation','none','form','banner','complementary','contentinfo',
  ]);
  const normalize = (value) => (value || '').replace(/\\s+/g, ' ').trim();
  const interactiveOnly = Boolean(input?.interactive);
  const includeCursor = Boolean(input?.cursor);
  const compact = Boolean(input?.compact);
  const rawDepth = Number(input?.depth);
  const maxDepth = Number.isInteger(rawDepth) && rawDepth >= 0 ? rawDepth : null;
  const selectorScope = typeof input?.selector === 'string' ? input.selector.trim() : '';
  const root = selectorScope ? document.querySelector(selectorScope) : document.body;
  if (!(root instanceof Element)) return [];
  const isVisible = (el) => {
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };
  const ownText = (el) => {
    const chunks = [];
    for (const node of el.childNodes) {
      if (node.nodeType !== Node.TEXT_NODE) continue;
      const value = normalize(node.textContent || '');
      if (value) chunks.push(value);
    }
    return normalize(chunks.join(' '));
  };
  const labelledByText = (el) => {
    const labelledBy = el.getAttribute('aria-labelledby');
    if (!labelledBy) return '';
    const ids = labelledBy.split(/\\s+/).map((id) => id.trim()).filter((id) => id.length > 0);
    const parts = [];
    for (const id of ids) {
      const node = document.getElementById(id);
      if (!node) continue;
      const value = normalize(node.textContent || '');
      if (value) parts.push(value);
    }
    return normalize(parts.join(' '));
  };
  const inputType = (el) => (el.getAttribute('type') || 'text').toLowerCase();
  const toRole = (el) => {
    const explicit = el.getAttribute('role');
    if (explicit) return explicit.toLowerCase();
    const tag = el.tagName.toLowerCase();
    if (tag === 'a' && el.getAttribute('href')) return 'link';
    if (tag === 'button') return 'button';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'select') return 'combobox';
    if (tag === 'summary') return 'button';
    if (tag === 'label') return 'label';
    if (tag === 'p') return 'paragraph';
    if (tag === 'li') return 'listitem';
    if (tag === 'main') return 'main';
    if (tag === 'nav') return 'navigation';
    if (tag === 'section') return 'region';
    if (tag === 'article') return 'article';
    if (tag === 'table') return 'table';
    if (tag === 'tr') return 'row';
    if (tag === 'th') return 'columnheader';
    if (tag === 'td') return 'cell';
    if (tag === 'ul' || tag === 'ol') return 'list';
    if (tag === 'form') return 'form';
    if (tag === 'header') return 'banner';
    if (tag === 'aside') return 'complementary';
    if (tag === 'footer') return 'contentinfo';
    if (/^h[1-6]$/.test(tag)) return 'heading';
    if (tag === 'input') {
      const type = inputType(el);
      if (type === 'button' || type === 'submit' || type === 'reset') return 'button';
      if (type === 'checkbox') return 'checkbox';
      if (type === 'radio') return 'radio';
      if (type === 'range') return 'slider';
      return 'textbox';
    }
    return 'generic';
  };
  const toName = (el, role) => {
    const aria = normalize(el.getAttribute('aria-label'));
    if (aria) return aria.slice(0, 120);
    const ariaLabelledBy = labelledByText(el);
    if (ariaLabelledBy) return ariaLabelledBy.slice(0, 120);
    if (el instanceof HTMLInputElement) {
      const type = inputType(el);
      if (type === 'password') return '';
      if ((type === 'button' || type === 'submit' || type === 'reset') && normalize(el.value)) {
        return normalize(el.value).slice(0, 120);
      }
      if (normalize(el.placeholder)) return normalize(el.placeholder).slice(0, 120);
      return '';
    }
    if (el instanceof HTMLTextAreaElement) {
      if (normalize(el.placeholder)) return normalize(el.placeholder).slice(0, 120);
      return '';
    }
    if (el instanceof HTMLSelectElement) {
      const selected = el.selectedOptions?.[0];
      const label = normalize(selected?.textContent || '');
      return label.slice(0, 120);
    }
    const own = ownText(el);
    if (own) return own.slice(0, 120);
    if (CONTENT_ROLES.has(role)) {
      const full = normalize(el.textContent || '');
      if (full) return full.slice(0, 120);
    }
    return '';
  };
  const isInteractive = (el, role) => {
    if (INTERACTIVE_ROLES.has(role)) return true;
    const tag = el.tagName.toLowerCase();
    if (tag === 'a' && el.getAttribute('href')) return true;
    if (tag === 'button' || tag === 'select' || tag === 'textarea') return true;
    if (tag === 'input') return true;
    if (el.getAttribute('contenteditable') === 'true') return true;
    const tabIndex = el.getAttribute('tabindex');
    return tabIndex !== null && tabIndex !== '-1';
  };
  const cursorHints = (el) => {
    if (!includeCursor) return [];
    const hints = [];
    const style = getComputedStyle(el);
    if (style.cursor === 'pointer') hints.push('cursor:pointer');
    if (el.hasAttribute('onclick') || el.onclick !== null) hints.push('onclick');
    const tabIndex = el.getAttribute('tabindex');
    if (tabIndex !== null && tabIndex !== '-1') hints.push('tabindex');
    return hints;
  };
  const cssPath = (el) => {
    if (el.id) return '#' + CSS.escape(el.id);
    const segments = [];
    let current = el;
    while (current && current.nodeType === Node.ELEMENT_NODE && current !== document.body) {
      const tag = current.tagName.toLowerCase();
      const parent = current.parentElement;
      if (!parent) break;
      const siblings = Array.from(parent.children).filter((entry) => entry.tagName === current.tagName);
      const index = siblings.indexOf(current) + 1;
      segments.unshift(tag + ':nth-of-type(' + index + ')');
      current = parent;
    }
    return 'body > ' + segments.join(' > ');
  };
  const shouldInclude = (role, name, interactive, hints) => {
    if (interactiveOnly) return interactive || hints.length > 0;
    if (interactive || hints.length > 0) return true;
    if (CONTENT_ROLES.has(role)) return name.length > 0;
    if (compact) return false;
    if (STRUCTURAL_ROLES.has(role)) return name.length > 0;
    return name.length > 0;
  };
  const seen = new Set();
  const nodes = [];
  const queue = [{ el: root, depth: 0 }];
  while (queue.length > 0 && nodes.length < MAX_NODES) {
    const current = queue.shift();
    if (!current) break;
    const { el, depth } = current;
    if (!(el instanceof Element)) continue;
    if (maxDepth !== null && depth > maxDepth) continue;
    if (!isVisible(el)) continue;
    const role = toRole(el);
    const name = toName(el, role);
    const hints = cursorHints(el);
    const interactive = isInteractive(el, role);
    if (shouldInclude(role, name, interactive, hints)) {
      const selector = cssPath(el);
      if (!seen.has(selector)) {
        seen.add(selector);
        nodes.push({ role, name, selector, suffix: hints.length > 0 ? '[' + hints.join(', ') + ']' : '' });
      }
    }
    if (maxDepth !== null && depth >= maxDepth) continue;
    for (const child of el.children) queue.push({ el: child, depth: depth + 1 });
  }
  if (!interactiveOnly && nodes.length < MAX_NODES) {
    const capturedNames = new Set(nodes.map((node) => normalize(node.name)).filter((value) => value.length > 0));
    const textKeys = new Set();
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    while (nodes.length < MAX_NODES) {
      const textNode = walker.nextNode();
      if (!textNode) break;
      const parent = textNode.parentElement;
      if (!(parent instanceof Element)) continue;
      if (!isVisible(parent)) continue;
      const tagName = parent.tagName.toLowerCase();
      if (tagName === 'script' || tagName === 'style' || tagName === 'noscript') continue;
      const text = normalize(textNode.textContent || '');
      if (text.length < 2 || capturedNames.has(text)) continue;
      const selector = cssPath(parent);
      const key = selector + '::' + text;
      if (textKeys.has(key)) continue;
      textKeys.add(key);
      nodes.push({ role: 'text', name: text.slice(0, 120), selector, suffix: '[text]' });
    }
  }
  return nodes;
}`;

const CLICK_SCRIPT = `(input) => { const el = document.querySelector(input.selector); if (!el) return { ok:false, error:{ code:'NO_MATCH', message:'Element not found for selector', details:{ selector: input.selector } } }; el.scrollIntoView({ block:'center', inline:'center', behavior:'instant' }); if (typeof el.click === 'function') { el.click(); } else { el.dispatchEvent(new MouseEvent('click', { bubbles:true, cancelable:true })); } return { ok:true }; }`;
const FILL_SCRIPT = `(input) => { const el = document.querySelector(input.selector); if (!el) return { ok:false, error:{ code:'NO_MATCH', message:'Element not found for selector', details:{ selector: input.selector } } }; if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement)) return { ok:false, error:{ code:'NOT_FILLABLE', message:'Element is not fillable', details:{ selector: input.selector } } }; el.focus(); el.value = input.value; el.dispatchEvent(new Event('input', { bubbles:true })); el.dispatchEvent(new Event('change', { bubbles:true })); return { ok:true }; }`;
const KEYPRESS_SCRIPT = `(input) => { const target = document.activeElement || document.body; const key = input.key; target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles:true })); target.dispatchEvent(new KeyboardEvent('keyup', { key, bubbles:true })); return { ok:true, active_tag: target.tagName }; }`;
const SCROLL_SCRIPT = `(input) => { window.scrollBy({ left: input.x, top: input.y, behavior:'instant' }); return { ok:true, x: window.scrollX, y: window.scrollY }; }`;
const HOVER_POINT_SCRIPT = `(input) => { const el = document.querySelector(input.selector); if (!el) return { ok:false, error:{ code:'NO_MATCH', message:'Element not found for selector', details:{ selector: input.selector } } }; el.scrollIntoView({ block:'center', inline:'center', behavior:'instant' }); const rect = el.getBoundingClientRect(); if (rect.width === 0 || rect.height === 0) return { ok:false, error:{ code:'NOT_VISIBLE', message:'Element is not visible', details:{ selector: input.selector } } }; return { ok:true, x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }; }`;
const TEXT_SCRIPT = `(input) => { const el = document.querySelector(input.selector); if (!el) return { ok:false, error:{ code:'NO_MATCH', message:'Element not found for selector', details:{ selector: input.selector } } }; return { ok:true, text: (el.textContent || '').trim() }; }`;
const HTML_SCRIPT = `(input) => { if (!input.selector) return { ok:true, html: document.documentElement.outerHTML }; const el = document.querySelector(input.selector); if (!el) return { ok:false, error:{ code:'NO_MATCH', message:'Element not found for selector', details:{ selector: input.selector } } }; return { ok:true, html: el.innerHTML }; }`;
const WAIT_SCRIPT = `(input) => {
  const timeoutMs = Number.isFinite(input.timeout_ms) && input.timeout_ms > 0 ? input.timeout_ms : 10000;
  const started = Date.now();
  const selector = typeof input.selector === 'string' ? input.selector : null;
  const text = typeof input.text === 'string' ? input.text : null;
  const expression = typeof input.expression === 'string' ? input.expression : null;
  const loadState = typeof input.load_state === 'string' ? input.load_state : null;
  const sleepMs = Number.isFinite(input.sleep_ms) && input.sleep_ms > 0 ? input.sleep_ms : null;
  const urlPattern = typeof input.url_pattern === 'string' ? input.url_pattern : null;
  const isVisible = (el) => { if (!(el instanceof Element)) return false; const style = getComputedStyle(el); if (style.display === 'none' || style.visibility === 'hidden') return false; const rect = el.getBoundingClientRect(); return rect.width > 0 && rect.height > 0; };
  const escapeRegExp = (value) => value.replace(/[-/\\\\^$*+?.()|[\\]{}]/g, '\\\\$&');
  const globToRegExp = (pattern) => new RegExp('^' + pattern.split('*').map(escapeRegExp).join('.*') + '$');
  const matchesLoadState = () => { if (!loadState) return false; if (loadState === 'load') return document.readyState === 'complete'; if (loadState === 'domcontentloaded') return document.readyState !== 'loading'; if (loadState === 'networkidle') return document.readyState === 'complete'; return false; };
  const isConditionMet = () => {
    if (selector) return isVisible(document.querySelector(selector));
    if (text) return (document.body?.innerText || '').includes(text);
    if (urlPattern) return globToRegExp(urlPattern).test(window.location.href);
    if (expression) { try { return Boolean(eval(expression)); } catch { return false; } }
    if (loadState) return matchesLoadState();
    return false;
  };
  return new Promise((resolve) => {
    if (sleepMs !== null) { setTimeout(() => resolve({ ok:true, waited:true, sleep_ms:sleepMs }), sleepMs); return; }
    const tick = () => {
      if (isConditionMet()) { resolve({ ok:true, waited:true }); return; }
      if (Date.now() - started >= timeoutMs) {
        resolve({ ok:false, error:{ code:'WAIT_TIMEOUT', message:'Timed out while waiting for condition', details:{ timeout_ms: timeoutMs, selector, text, url_pattern: urlPattern, load_state: loadState } } });
        return;
      }
      setTimeout(tick, 100);
    };
    tick();
  });
}`;

const MAX_MONITOR_EVENTS = 1000;

interface PageTarget {
  id: number;
  targetId: string;
  windowId: number;
  title: string;
  url: string;
  active: boolean;
}

interface CdpPending {
  resolve: (value: Record<string, unknown>) => void;
  reject: (reason: unknown) => void;
  timer: NodeJS.Timeout;
}

interface MonitorState {
  network: {
    enabled: boolean;
    sessionId?: string;
    events: Array<Record<string, unknown>>;
    byRequestId: Record<string, Record<string, unknown>>;
  };
  console: {
    enabled: boolean;
    sessionId?: string;
    events: Array<Record<string, unknown>>;
  };
}

export class ManagedChromeCdpBackend {
  private readonly config: NonNullable<DaemonConfig['cdp']>;
  private ws?: WebSocket;
  private browserWsUrl = '';
  private launchedProcess?: ChildProcess;
  private launched = false;
  private nextId = 0;
  private readonly pending = new Map<number, CdpPending>();
  private readonly sessions = new Map<string, string>();
  private readonly sessionToTargetId = new Map<string, string>();
  private readonly targetIdToTabId = new Map<string, number>();
  private readonly tabIdToTargetId = new Map<number, string>();
  private nextSyntheticTabId = 1;
  private selectedTargetId?: string;
  private readonly monitor: MonitorState = {
    network: {
      enabled: false,
      events: [],
      byRequestId: {},
    },
    console: {
      enabled: false,
      events: [],
    },
  };

  constructor(rawConfig?: DaemonConfig['cdp']) {
    this.config = {
      browser_ws_url: rawConfig?.browser_ws_url,
      browser_http_url: rawConfig?.browser_http_url,
      executable_path: rawConfig?.executable_path,
      user_data_dir: rawConfig?.user_data_dir,
      profile_directory: rawConfig?.profile_directory ?? 'Default',
      remote_debugging_port: rawConfig?.remote_debugging_port ?? 9222,
      launch_args: Array.isArray(rawConfig?.launch_args) ? rawConfig.launch_args : [],
    };
  }

  async start(): Promise<void> {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      return;
    }

    if (!this.config.browser_ws_url && !this.config.browser_http_url) {
      await this.launchChrome();
    }

    const browserWsUrl = await this.resolveBrowserWsUrl();
    await this.connect(browserWsUrl);
  }

  async reconnect(): Promise<void> {
    await this.disconnect();
    await this.start();
  }

  async dispose(): Promise<void> {
    await this.disconnect();
    if (this.launchedProcess && !this.launchedProcess.killed) {
      this.launchedProcess.kill('SIGTERM');
    }
  }

  getStatus(): Record<string, unknown> {
    return {
      connected: Boolean(this.ws && this.ws.readyState === WebSocket.OPEN),
      launched: this.launched,
      browser_ws_url: this.browserWsUrl || this.config.browser_ws_url,
      browser_http_url: this.config.browser_http_url ?? (this.config.remote_debugging_port ? `http://127.0.0.1:${this.config.remote_debugging_port}` : undefined),
      executable_path: this.config.executable_path,
      user_data_dir: this.config.user_data_dir,
      profile_directory: this.config.profile_directory,
      selected_target_id: this.selectedTargetId,
      network_enabled: this.monitor.network.enabled,
      console_enabled: this.monitor.console.enabled,
    };
  }

  async execute(command: string, payload: Record<string, unknown>, timeoutMs: number): Promise<Record<string, unknown>> {
    await this.start();
    switch (command) {
      case 'list_tabs':
        return { tabs: await this.listTabs() };
      case 'list_windows':
        return { windows: await this.listWindows() };
      case 'select_tab':
        return this.selectTab(payload.target);
      case 'select_window':
        return this.selectWindow(payload.target);
      case 'guard_window':
        return this.selectWindow(payload.target, true);
      case 'clear_guarded_window':
        return { guarded_window_id: null };
      case 'snapshot':
        return this.snapshot(payload, timeoutMs);
      case 'click':
        return this.runDomScript(payload, CLICK_SCRIPT, timeoutMs);
      case 'fill':
        return this.runDomScript(payload, FILL_SCRIPT, timeoutMs);
      case 'upload':
        return this.upload(payload, timeoutMs);
      case 'keypress':
        return this.runDomScript(payload, KEYPRESS_SCRIPT, timeoutMs);
      case 'scroll':
        return this.runDomScript(payload, SCROLL_SCRIPT, timeoutMs);
      case 'navigate':
      case 'open':
        return this.navigate(payload);
      case 'create_tab':
        return this.createTab(payload);
      case 'close':
        return this.closeTab(payload);
      case 'hover':
        return this.hover(payload, timeoutMs);
      case 'eval':
        return this.evalScript(payload, timeoutMs);
      case 'text':
        return this.runDomScript(payload, TEXT_SCRIPT, timeoutMs);
      case 'html':
        return this.runDomScript(payload, HTML_SCRIPT, timeoutMs);
      case 'wait':
        return this.runDomScript(payload, WAIT_SCRIPT, timeoutMs, true);
      case 'screenshot':
        return this.screenshot(payload);
      case 'pdf':
        return this.pdf(payload);
      case 'cookies_get':
        return this.getCookies(payload);
      case 'cookies_set':
        return this.setCookies(payload);
      case 'cookies_delete':
        return this.deleteCookie(payload);
      case 'cookies_clear':
        return this.clearCookies(payload);
      case 'reconnect':
        await this.reconnect();
        return { ok: true };
      case 'reset':
        this.sessions.clear();
        this.sessionToTargetId.clear();
        this.selectedTargetId = undefined;
        this.monitor.network.enabled = false;
        this.monitor.network.events = [];
        this.monitor.network.byRequestId = {};
        this.monitor.network.sessionId = undefined;
        this.monitor.console.enabled = false;
        this.monitor.console.events = [];
        this.monitor.console.sessionId = undefined;
        return { ok: true };
      case 'network_start':
        return this.networkStart(payload);
      case 'network_stop':
        return this.networkStop(payload);
      case 'network_dump':
        return this.networkDump(payload);
      case 'console_start':
        return this.consoleStart(payload);
      case 'console_stop':
        return this.consoleStop(payload);
      case 'console_dump':
        return this.consoleDump(payload);
      default:
        throw new HBError('BAD_REQUEST', `Unknown CDP backend command: ${command}`);
    }
  }

  private async launchChrome(): Promise<void> {
    const executable = this.findChromeExecutable();
    const port = this.config.remote_debugging_port ?? 9222;
    const userDataDir = resolve(this.config.user_data_dir ?? join(homedir(), '.human-browser', 'managed-chrome'));
    await mkdir(userDataDir, { recursive: true });

    const args = [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${userDataDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-networking',
      '--disable-component-update',
      '--disable-sync',
      '--new-window',
      ...(this.config.profile_directory ? [`--profile-directory=${this.config.profile_directory}`] : []),
      ...(this.config.launch_args ?? []),
      'about:blank',
    ];

    this.launchedProcess = spawn(executable, args, {
      detached: false,
      stdio: 'ignore',
    });
    this.launched = true;
    this.config.executable_path = executable;
    this.config.user_data_dir = userDataDir;
    this.config.browser_http_url = `http://127.0.0.1:${port}`;
    this.launchedProcess.unref();
    await this.waitForEndpoint(this.config.browser_http_url);
  }

  private async waitForEndpoint(baseUrl?: string): Promise<void> {
    const url = `${baseUrl ?? `http://127.0.0.1:${this.config.remote_debugging_port ?? 9222}`}/json/version`;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        const response = await fetch(url);
        if (response.ok) {
          return;
        }
      } catch {
        // retry
      }
      await delay(100);
    }
    throw new HBError('TIMEOUT', `Timed out while waiting for Chrome CDP endpoint: ${url}`);
  }

  private async resolveBrowserWsUrl(): Promise<string> {
    if (this.config.browser_ws_url) {
      this.browserWsUrl = this.config.browser_ws_url;
      return this.browserWsUrl;
    }

    const baseUrl = this.config.browser_http_url ?? `http://127.0.0.1:${this.config.remote_debugging_port ?? 9222}`;
    const response = await fetch(`${baseUrl}/json/version`);
    if (!response.ok) {
      throw new HBError('DISCONNECTED', `CDP endpoint is not reachable: ${baseUrl}`);
    }
    const payload = await response.json() as { webSocketDebuggerUrl?: string };
    if (!payload.webSocketDebuggerUrl) {
      throw new HBError('DISCONNECTED', `CDP endpoint did not return webSocketDebuggerUrl: ${baseUrl}`);
    }
    this.browserWsUrl = payload.webSocketDebuggerUrl;
    return this.browserWsUrl;
  }

  private async connect(browserWsUrl: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(browserWsUrl);
      this.ws = ws;
      ws.once('open', () => {
        void this.send('Target.setDiscoverTargets', { discover: true }).catch(() => {});
        ws.on('message', (raw) => {
          this.handleMessage(String(raw));
        });
        ws.on('close', () => {
          this.ws = undefined;
        });
        resolve();
      });
      ws.once('error', (error) => {
        reject(new HBError('DISCONNECTED', `Failed to connect to Chrome CDP websocket: ${error.message}`));
      });
    });
  }

  private async disconnect(): Promise<void> {
    const ws = this.ws;
    this.ws = undefined;
    if (!ws) {
      return;
    }
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new HBError('DISCONNECTED', 'CDP connection closed'));
    }
    this.pending.clear();
    this.sessionToTargetId.clear();
    await new Promise<void>((resolve) => {
      ws.once('close', () => resolve());
      try {
        ws.close();
      } catch {
        resolve();
      }
    });
  }

  private handleMessage(raw: string): void {
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return;
    }

    const id = payload.id;
    if (typeof id === 'number') {
      const pending = this.pending.get(id);
      if (!pending) {
        return;
      }
      clearTimeout(pending.timer);
      this.pending.delete(id);
      if (payload.error) {
        pending.reject(new HBError('INTERNAL', `CDP error`, payload.error as Record<string, unknown>));
        return;
      }
      pending.resolve((payload.result as Record<string, unknown> | undefined) ?? {});
      return;
    }

    if (payload.method === 'Target.detachedFromTarget' && payload.params && typeof payload.params === 'object') {
      const sessionId = (payload.params as Record<string, unknown>).sessionId;
      if (typeof sessionId === 'string') {
        this.sessionToTargetId.delete(sessionId);
        for (const [targetId, value] of this.sessions.entries()) {
          if (value === sessionId) {
            this.sessions.delete(targetId);
          }
        }
      }
      return;
    }

    if (payload.method === 'Target.targetDestroyed' && payload.params && typeof payload.params === 'object') {
      const targetId = (payload.params as Record<string, unknown>).targetId;
      if (typeof targetId === 'string') {
        const tabId = this.targetIdToTabId.get(targetId);
        if (typeof tabId === 'number') {
          this.tabIdToTargetId.delete(tabId);
        }
        this.targetIdToTabId.delete(targetId);
        const sessionId = this.sessions.get(targetId);
        if (sessionId) {
          this.sessionToTargetId.delete(sessionId);
        }
        this.sessions.delete(targetId);
      }
      return;
    }

    this.handleMonitorEvent(payload);
  }

  private handleMonitorEvent(payload: Record<string, unknown>): void {
    const method = typeof payload.method === 'string' ? payload.method : '';
    const sessionId = typeof payload.sessionId === 'string' ? payload.sessionId : undefined;

    if (this.monitor.network.enabled && sessionId && sessionId === this.monitor.network.sessionId) {
      const params = payload.params && typeof payload.params === 'object' ? payload.params as Record<string, unknown> : {};
      if (method === 'Network.requestWillBeSent') {
        const requestId = String(params.requestId ?? '');
        if (!requestId) {
          return;
        }
        this.monitor.network.byRequestId[requestId] = {
          request_id: requestId,
          url: String((params.request as Record<string, unknown> | undefined)?.url ?? ''),
          method: String((params.request as Record<string, unknown> | undefined)?.method ?? ''),
          resource_type: String(params.type ?? ''),
          started_at: Date.now(),
        };
        return;
      }

      if (method === 'Network.responseReceived') {
        const requestId = String(params.requestId ?? '');
        if (!requestId) {
          return;
        }
        const entry = this.monitor.network.byRequestId[requestId] ?? {};
        const response = params.response as Record<string, unknown> | undefined;
        pushMonitorEvent(this.monitor.network.events, {
          request_id: requestId,
          url: String(response?.url ?? entry.url ?? ''),
          method: String(entry.method ?? ''),
          resource_type: String(params.type ?? entry.resource_type ?? ''),
          status: Number(response?.status ?? 0),
          status_text: String(response?.statusText ?? ''),
          mime_type: String(response?.mimeType ?? ''),
          timestamp: Date.now(),
        });
        delete this.monitor.network.byRequestId[requestId];
        return;
      }
    }

    if (this.monitor.console.enabled && sessionId && sessionId === this.monitor.console.sessionId) {
      const params = payload.params && typeof payload.params === 'object' ? payload.params as Record<string, unknown> : {};
      if (method === 'Runtime.consoleAPICalled') {
        const args = Array.isArray(params.args) ? params.args : [];
        const text = args.map((entry) => stringifyRemoteValue(entry)).join(' ');
        pushMonitorEvent(this.monitor.console.events, {
          type: String(params.type ?? 'log'),
          text,
          timestamp: Date.now(),
        });
        return;
      }

      if (method === 'Runtime.exceptionThrown') {
        const details = params.exceptionDetails as Record<string, unknown> | undefined;
        const exception = details?.exception as Record<string, unknown> | undefined;
        pushMonitorEvent(this.monitor.console.events, {
          type: 'error',
          text: String(details?.text ?? exception?.description ?? 'Uncaught exception'),
          timestamp: Date.now(),
        });
      }
    }
  }

  private async send(method: string, params: Record<string, unknown> = {}, sessionId?: string, timeoutMs = 10000): Promise<Record<string, unknown>> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new HBError('DISCONNECTED', 'CDP websocket is not connected');
    }

    this.nextId += 1;
    const id = this.nextId;

    return await new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new HBError('TIMEOUT', `Timed out waiting for CDP response: ${method}`));
      }, timeoutMs);

      this.pending.set(id, {
        resolve,
        reject,
        timer,
      });

      this.ws?.send(JSON.stringify({ id, method, params, sessionId }), (error) => {
        if (error) {
          clearTimeout(timer);
          this.pending.delete(id);
          reject(new HBError('DISCONNECTED', `Failed to send CDP command: ${error.message}`));
        }
      });
    });
  }

  private async listTabs(): Promise<Record<string, unknown>[]> {
    const tabs = await this.listPageTargets();
    return tabs.map((tab) => ({
      id: tab.id,
      window_id: tab.windowId,
      active: tab.active,
      title: tab.title,
      url: tab.url,
    }));
  }

  private async listWindows(): Promise<Record<string, unknown>[]> {
    const tabs = await this.listPageTargets();
    const grouped = new Map<number, PageTarget[]>();
    for (const tab of tabs) {
      const bucket = grouped.get(tab.windowId) ?? [];
      bucket.push(tab);
      grouped.set(tab.windowId, bucket);
    }
    return [...grouped.entries()].map(([windowId, entries]) => ({
      id: windowId,
      focused: entries.some((entry) => entry.active),
      tabs: entries.map((entry) => ({
        id: entry.id,
        active: entry.active,
        title: entry.title,
        url: entry.url,
      })),
    }));
  }

  private async selectTab(target: unknown): Promise<Record<string, unknown>> {
    const resolved = await this.resolvePageTarget(target);
    this.selectedTargetId = resolved.targetId;
    return {
      tab_id: resolved.id,
      window_id: resolved.windowId,
    };
  }

  private async selectWindow(target: unknown, guarded = false): Promise<Record<string, unknown>> {
    const tabs = await this.listPageTargets();
    let windowId: number;
    if (target === 'current' || target === undefined) {
      const current = tabs.find((tab) => tab.targetId === this.selectedTargetId) ?? tabs[0];
      if (!current) {
        throw new HBError('BAD_REQUEST', 'No page targets available');
      }
      windowId = current.windowId;
    } else {
      const numeric = Number(target);
      if (!Number.isFinite(numeric)) {
        throw new HBError('BAD_REQUEST', 'window target must be current or numeric');
      }
      windowId = numeric;
    }

    const first = tabs.find((tab) => tab.windowId === windowId);
    if (!first) {
      throw new HBError('BAD_REQUEST', `Window not found: ${windowId}`);
    }
    this.selectedTargetId = first.targetId;
    return guarded ? { guarded_window_id: windowId } : { window_id: windowId };
  }

  private async snapshot(payload: Record<string, unknown>, timeoutMs: number): Promise<Record<string, unknown>> {
    const page = await this.resolvePageTarget(payload.target);
    const result = await this.callFunction(page.targetId, SNAPSHOT_SCRIPT, payload, timeoutMs);
    const nodes = Array.isArray(result) ? result : [];
    return {
      tab_id: page.id,
      window_id: page.windowId,
      nodes,
    };
  }

  private async runDomScript(
    payload: Record<string, unknown>,
    script: string,
    timeoutMs: number,
    allowPromise = false,
  ): Promise<Record<string, unknown>> {
    const page = await this.resolvePageTarget(payload.tab_id);
    const result = await this.callFunction(page.targetId, script, payload, timeoutMs, allowPromise);
    if (result && typeof result === 'object' && 'ok' in result && result.ok === false) {
      const error = (result as Record<string, unknown>).error;
      if (error && typeof error === 'object') {
        throw new HBError(
          ((error as Record<string, unknown>).code as string | undefined) === 'NO_MATCH' ? 'BAD_REQUEST' : 'INTERNAL',
          String((error as Record<string, unknown>).message ?? 'CDP DOM command failed'),
          error as Record<string, unknown>,
        );
      }
    }
    return result as Record<string, unknown>;
  }

  private async navigate(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    const url = String(payload.url ?? '').trim();
    if (!url) {
      throw new HBError('BAD_REQUEST', 'navigate/open requires url');
    }
    const page = await this.resolvePageTarget(payload.tab_id);
    const sessionId = await this.getSession(page.targetId);
    await this.send('Page.enable', {}, sessionId);
    await this.send('Page.navigate', { url }, sessionId);
    this.selectedTargetId = page.targetId;
    return {
      tab_id: page.id,
      url,
      result: { ok: true },
    };
  }

  private async createTab(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    const url = String(payload.url ?? '').trim();
    if (!url) {
      throw new HBError('BAD_REQUEST', 'create_tab requires url');
    }
    const result = await this.send('Target.createTarget', { url });
    const targetId = String(result.targetId ?? '');
    if (!targetId) {
      throw new HBError('INTERNAL', 'Target.createTarget did not return targetId');
    }
    await delay(200);
    const page = await this.findPageTargetByTargetId(targetId);
    if (payload.active !== false) {
      this.selectedTargetId = targetId;
    }
    return {
      tab_id: page.id,
      window_id: page.windowId,
      url,
      active: payload.active !== false,
    };
  }

  private async closeTab(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    const page = await this.resolvePageTarget(payload.tab_id);
    await this.send('Target.closeTarget', { targetId: page.targetId });
    if (this.selectedTargetId === page.targetId) {
      this.selectedTargetId = undefined;
    }
    return { ok: true };
  }

  private async hover(payload: Record<string, unknown>, timeoutMs: number): Promise<Record<string, unknown>> {
    const page = await this.resolvePageTarget(payload.tab_id);
    const point = await this.callFunction(page.targetId, HOVER_POINT_SCRIPT, payload, timeoutMs);
    if (!point || typeof point !== 'object' || point.ok === false) {
      const error = (point as Record<string, unknown>)?.error;
      throw new HBError('BAD_REQUEST', String((error as Record<string, unknown>)?.message ?? 'hover failed'));
    }
    const sessionId = await this.getSession(page.targetId);
    await this.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: Number((point as Record<string, unknown>).x ?? 0),
      y: Number((point as Record<string, unknown>).y ?? 0),
      buttons: 0,
    }, sessionId);
    return point as Record<string, unknown>;
  }

  private async evalScript(payload: Record<string, unknown>, timeoutMs: number): Promise<Record<string, unknown>> {
    const script = String(payload.script ?? '');
    if (!script) {
      throw new HBError('BAD_REQUEST', 'eval requires script');
    }
    const page = await this.resolvePageTarget(payload.tab_id);
    const sessionId = await this.getSession(page.targetId);
    const response = await this.send('Runtime.evaluate', {
      expression: script,
      returnByValue: true,
      awaitPromise: true,
    }, sessionId, timeoutMs);
    return {
      result: (response.result as Record<string, unknown> | undefined)?.value,
    };
  }

  private async screenshot(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    const page = await this.resolvePageTarget(payload.tab_id);
    const sessionId = await this.getSession(page.targetId);
    await this.send('Page.enable', {}, sessionId);
    if (payload.full_page) {
      const metrics = await this.send('Page.getLayoutMetrics', {}, sessionId);
      const contentSize = metrics.contentSize as Record<string, unknown> | undefined;
      const width = Number(contentSize?.width ?? 0);
      const height = Number(contentSize?.height ?? 0);
      const capture = await this.send('Page.captureScreenshot', {
        format: 'png',
        captureBeyondViewport: true,
        clip: {
          x: 0,
          y: 0,
          width,
          height,
          scale: 1,
        },
      }, sessionId, 20000);
      return { data_base64: capture.data, format: 'png' };
    }

    const capture = await this.send('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: false,
    }, sessionId, 20000);
    return { data_base64: capture.data, format: 'png' };
  }

  private async pdf(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    const page = await this.resolvePageTarget(payload.tab_id);
    const sessionId = await this.getSession(page.targetId);
    await this.send('Page.enable', {}, sessionId);
    const printed = await this.send('Page.printToPDF', {
      printBackground: true,
      preferCSSPageSize: true,
    }, sessionId, 30000);
    return { data_base64: printed.data };
  }

  private async getCookies(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    const page = await this.resolvePageTarget(payload.tab_id);
    const sessionId = await this.getSession(page.targetId);
    await this.send('Network.enable', {}, sessionId);
    const currentUrl = typeof payload.url === 'string' ? payload.url : await this.getPageUrl(page.targetId);
    const result = await this.send('Network.getCookies', { urls: [currentUrl] }, sessionId);
    return result;
  }

  private async setCookies(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    const page = await this.resolvePageTarget(payload.tab_id);
    const sessionId = await this.getSession(page.targetId);
    await this.send('Network.enable', {}, sessionId);
    const currentUrl = typeof payload.url === 'string' ? payload.url : await this.getPageUrl(page.targetId);
    await this.send('Network.setCookies', {
      cookies: [{
        name: String(payload.name ?? ''),
        value: String(payload.value ?? ''),
        url: currentUrl,
      }],
    }, sessionId);
    return { ok: true };
  }

  private async deleteCookie(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    const page = await this.resolvePageTarget(payload.tab_id);
    const sessionId = await this.getSession(page.targetId);
    await this.send('Network.enable', {}, sessionId);
    const currentUrl = typeof payload.url === 'string' ? payload.url : await this.getPageUrl(page.targetId);
    await this.send('Network.deleteCookies', {
      name: String(payload.name ?? ''),
      url: currentUrl,
    }, sessionId);
    return { ok: true };
  }

  private async clearCookies(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    const page = await this.resolvePageTarget(payload.tab_id);
    const sessionId = await this.getSession(page.targetId);
    await this.send('Network.enable', {}, sessionId);
    await this.send('Network.clearBrowserCookies', {}, sessionId);
    return { ok: true };
  }

  private async upload(payload: Record<string, unknown>, timeoutMs: number): Promise<Record<string, unknown>> {
    const selector = String(payload.selector ?? '');
    const files = Array.isArray(payload.files) ? payload.files.map((entry) => String(entry)) : [];
    if (!selector) {
      throw new HBError('BAD_REQUEST', 'upload requires selector');
    }
    if (files.length === 0) {
      throw new HBError('BAD_REQUEST', 'upload requires files');
    }
    const page = await this.resolvePageTarget(payload.tab_id);
    const sessionId = await this.getSession(page.targetId);
    await this.send('DOM.enable', {}, sessionId);
    const documentRoot = await this.send('DOM.getDocument', { depth: -1, pierce: true }, sessionId, timeoutMs);
    const rootNodeId = Number((documentRoot.root as Record<string, unknown> | undefined)?.nodeId ?? 0);
    const query = await this.send('DOM.querySelector', {
      nodeId: rootNodeId,
      selector,
    }, sessionId, timeoutMs);
    const nodeId = Number(query.nodeId ?? 0);
    if (!Number.isFinite(nodeId) || nodeId <= 0) {
      throw new HBError('BAD_REQUEST', `upload selector not found: ${selector}`);
    }
    await this.send('DOM.setFileInputFiles', {
      nodeId,
      files,
    }, sessionId, timeoutMs);
    return { ok: true, files_count: files.length };
  }

  private async getPageUrl(targetId: string): Promise<string> {
    const tabs = await this.listPageTargets();
    const tab = tabs.find((entry) => entry.targetId === targetId);
    return tab?.url ?? 'about:blank';
  }

  private async callFunction(
    targetId: string,
    script: string,
    input: Record<string, unknown>,
    timeoutMs: number,
    awaitPromise = true,
  ): Promise<unknown> {
    const sessionId = await this.getSession(targetId);
    await this.send('Runtime.enable', {}, sessionId);
    const expression = `(() => { const __hbFn = ${script}; return __hbFn(${JSON.stringify(input)}); })()`;
    const response = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise,
    }, sessionId, timeoutMs);
    return (response.result as Record<string, unknown> | undefined)?.value;
  }

  private async getSession(targetId: string): Promise<string> {
    const existing = this.sessions.get(targetId);
    if (existing) {
      return existing;
    }
    const result = await this.send('Target.attachToTarget', {
      targetId,
      flatten: true,
    });
    const sessionId = String(result.sessionId ?? '');
    if (!sessionId) {
      throw new HBError('INTERNAL', `Failed to attach CDP session for target: ${targetId}`);
    }
    this.sessions.set(targetId, sessionId);
    this.sessionToTargetId.set(sessionId, targetId);
    return sessionId;
  }

  private async networkStart(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    const page = await this.resolvePageTarget(payload.tab_id);
    const sessionId = await this.getSession(page.targetId);
    await this.send('Network.enable', {}, sessionId);
    this.monitor.network.enabled = true;
    this.monitor.network.sessionId = sessionId;
    return { ok: true };
  }

  private async networkStop(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    const page = await this.resolvePageTarget(payload.tab_id);
    const sessionId = await this.getSession(page.targetId);
    await this.send('Network.disable', {}, sessionId);
    this.monitor.network.enabled = false;
    this.monitor.network.sessionId = undefined;
    this.monitor.network.byRequestId = {};
    return { ok: true };
  }

  private async networkDump(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    const page = await this.resolvePageTarget(payload.tab_id);
    const sessionId = await this.getSession(page.targetId);
    await this.send('Network.enable', {}, sessionId);
    this.monitor.network.enabled = true;
    this.monitor.network.sessionId = sessionId;
    const filter = typeof payload.filter === 'string' ? payload.filter.toLowerCase() : '';
    const requests = filter
      ? this.monitor.network.events.filter((entry) => String(entry.url ?? '').toLowerCase().includes(filter))
      : this.monitor.network.events;
    const clear = payload.clear === true;
    const result = {
      requests,
      count: requests.length,
    };
    if (clear) {
      this.monitor.network.events = [];
      this.monitor.network.byRequestId = {};
    }
    return result;
  }

  private async consoleStart(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    const page = await this.resolvePageTarget(payload.tab_id);
    const sessionId = await this.getSession(page.targetId);
    await this.send('Runtime.enable', {}, sessionId);
    this.monitor.console.enabled = true;
    this.monitor.console.sessionId = sessionId;
    return { ok: true };
  }

  private async consoleStop(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    const page = await this.resolvePageTarget(payload.tab_id);
    const sessionId = await this.getSession(page.targetId);
    await this.send('Runtime.disable', {}, sessionId);
    this.monitor.console.enabled = false;
    this.monitor.console.sessionId = undefined;
    return { ok: true };
  }

  private async consoleDump(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    const page = await this.resolvePageTarget(payload.tab_id);
    const sessionId = await this.getSession(page.targetId);
    await this.send('Runtime.enable', {}, sessionId);
    this.monitor.console.enabled = true;
    this.monitor.console.sessionId = sessionId;
    const messages = this.monitor.console.events;
    const clear = payload.clear === true;
    const result = {
      messages,
      count: messages.length,
    };
    if (clear) {
      this.monitor.console.events = [];
    }
    return result;
  }

  private async resolvePageTarget(target: unknown): Promise<PageTarget> {
    const tabs = await this.listPageTargets();
    if (tabs.length === 0) {
      throw new HBError('BAD_REQUEST', 'No page targets available');
    }

    if (typeof target === 'number' && Number.isFinite(target)) {
      const page = tabs.find((entry) => entry.id === target);
      if (!page) {
        throw new HBError('BAD_REQUEST', `Unknown tab id: ${target}`);
      }
      return page;
    }

    if (typeof target === 'string' && target !== 'active') {
      const numeric = Number(target);
      if (Number.isFinite(numeric)) {
        const page = tabs.find((entry) => entry.id === numeric);
        if (!page) {
          throw new HBError('BAD_REQUEST', `Unknown tab id: ${target}`);
        }
        return page;
      }
    }

    if (this.selectedTargetId) {
      const selected = tabs.find((entry) => entry.targetId === this.selectedTargetId);
      if (selected) {
        return selected;
      }
    }

    const first = tabs[0];
    this.selectedTargetId = first.targetId;
    return first;
  }

  private async findPageTargetByTargetId(targetId: string): Promise<PageTarget> {
    const tabs = await this.listPageTargets();
    const page = tabs.find((entry) => entry.targetId === targetId);
    if (!page) {
      throw new HBError('BAD_REQUEST', `Target not found: ${targetId}`);
    }
    return page;
  }

  private async listPageTargets(): Promise<PageTarget[]> {
    const result = await this.send('Target.getTargets');
    const targetInfos = Array.isArray(result.targetInfos) ? result.targetInfos : [];
    const pages: PageTarget[] = [];

    for (const entry of targetInfos) {
      if (!entry || typeof entry !== 'object') {
        continue;
      }
      const info = entry as Record<string, unknown>;
      if (info.type !== 'page') {
        continue;
      }
      const targetId = String(info.targetId ?? '');
      if (!targetId) {
        continue;
      }
      const title = String(info.title ?? '');
      const url = String(info.url ?? '');
      if (url.startsWith('devtools://')) {
        continue;
      }
      let windowId = 0;
      try {
        const windowResult = await this.send('Browser.getWindowForTarget', { targetId });
        windowId = Number(windowResult.windowId ?? 0);
      } catch {
        windowId = 0;
      }
      let syntheticId = this.targetIdToTabId.get(targetId);
      if (!syntheticId) {
        syntheticId = this.nextSyntheticTabId;
        this.nextSyntheticTabId += 1;
        this.targetIdToTabId.set(targetId, syntheticId);
        this.tabIdToTargetId.set(syntheticId, targetId);
      }
      pages.push({
        id: syntheticId,
        targetId,
        windowId,
        title,
        url,
        active: this.selectedTargetId === targetId,
      });
    }

    return pages;
  }

  private findChromeExecutable(): string {
    const candidates = [
      this.config.executable_path,
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
    ].filter((value): value is string => typeof value === 'string' && value.length > 0);

    for (const candidate of candidates) {
      return candidate;
    }

    throw new HBError('BAD_REQUEST', 'No Chrome executable configured for CDP backend');
  }
}

function stringifyRemoteValue(input: unknown): string {
  if (!input || typeof input !== 'object') {
    return String(input ?? '');
  }

  const record = input as Record<string, unknown>;
  if (typeof record.value === 'string' || typeof record.value === 'number' || typeof record.value === 'boolean') {
    return String(record.value);
  }

  if (record.value === null) {
    return 'null';
  }

  if (typeof record.description === 'string' && record.description.length > 0) {
    return record.description;
  }

  return String(record.type ?? 'unknown');
}

function pushMonitorEvent(bucket: Array<Record<string, unknown>>, item: Record<string, unknown>): void {
  bucket.push(item);
  if (bucket.length > MAX_MONITOR_EVENTS) {
    bucket.splice(0, bucket.length - MAX_MONITOR_EVENTS);
  }
}
