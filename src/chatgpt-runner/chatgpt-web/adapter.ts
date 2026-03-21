import { createHash } from 'node:crypto';
import { RunnerError } from '../shared/errors.ts';
import type {
  BrowserDriver,
  ChatGptJobRecord,
  JobMode,
  JobObservation,
  JobState,
  ModelPreset,
  ThinkingBudget,
} from '../shared/types.ts';

const CHATGPT_HOME_URL = 'https://chatgpt.com/';
const CHATGPT_DEEP_RESEARCH_URL = 'https://chatgpt.com/deep-research';
const FILE_INPUT_SELECTOR = 'input[type="file"]';
const SEND_BUTTON_SELECTOR = '[data-testid="send-button"]';
const MODEL_SWITCHER_SELECTOR = '[data-testid="model-switcher-dropdown-button"]';
const DEEP_RESEARCH_SIDEBAR_SELECTOR = '[data-testid="deep-research-sidebar-item"]';
const MODEL_TEST_IDS: Record<ModelPreset, string> = {
  auto: 'model-switcher-gpt-5-3',
  instant: 'model-switcher-gpt-5-3-instant',
  thinking: 'model-switcher-gpt-5-4-thinking',
  pro: 'model-switcher-gpt-5-4-pro',
};
const MODEL_LABELS: Record<ModelPreset, string> = {
  auto: '5.3',
  instant: '5.3 Instant',
  thinking: '5.4 Thinking',
  pro: '5.4 Pro',
};
const BUDGET_LABELS: Record<ThinkingBudget, string> = {
  light: 'Light',
  standard: 'Standard',
  extended: 'Extended',
  heavy: 'Heavy',
};
const OBSERVE_SCRIPT = `
(() => {
  const bodyText = document.body?.innerText || '';
  const assistantRoots = Array.from(document.querySelectorAll('[data-message-author-role="assistant"]'));
  const assistantTexts = assistantRoots
    .map((root) => {
      const markdown = root.querySelector('.markdown');
      return ((markdown?.textContent || root.textContent || '')).trim();
    })
    .filter(Boolean);
  const latestAssistantText = assistantTexts.length ? assistantTexts[assistantTexts.length - 1] : '';
  const hasThinkingBlock = !!document.querySelector('[data-message-author-role="assistant"] .result-thinking');
  const hasSendButton = !!document.querySelector('${SEND_BUTTON_SELECTOR}');
  const hasShareButton = !!document.querySelector('[data-testid="share-chat-button"]');
  const bodyLower = bodyText.toLowerCase();

  return JSON.stringify({
    url: location.href,
    title: document.title,
    latestAssistantText,
    assistantTurnCount: assistantTexts.length,
    generatingHint:
      bodyLower.includes('still generating a response') ||
      bodyLower.includes('is generating a response') ||
      bodyLower.includes('researching') ||
      hasThinkingBlock,
    shareButtonVisible: hasShareButton,
    sendButtonVisible: hasSendButton,
    loginRequired:
      bodyLower.includes('log in') ||
      bodyLower.includes('sign up') ||
      bodyLower.includes('continue with google'),
    captchaRequired:
      bodyLower.includes('verify you are human') ||
      bodyLower.includes('captcha') ||
      bodyLower.includes('challenge-platform'),
    errorHint:
      bodyLower.includes('something went wrong')
        ? 'something_went_wrong'
        : bodyLower.includes('conversation not found')
          ? 'conversation_not_found'
          : '',
  });
})();
`;

export class ChatGptWebAdapter {
  private readonly driver: BrowserDriver;

  constructor(driver: BrowserDriver) {
    this.driver = driver;
  }

  getTabId(): number | undefined {
    return this.driver.getTabId();
  }

  getWindowId(): number | undefined {
    return this.driver.getWindowId();
  }

  async submit(job: ChatGptJobRecord): Promise<{ conversationUrl?: string; tabId?: number; windowId?: number }> {
    if (!this.driver.getTabId()) {
      await this.driver.createTab('about:blank');
    }
    await this.driver.open(CHATGPT_HOME_URL);
    await this.waitForTextbox();
    await this.ensureMode(job.mode);
    await this.ensureModelPreset(job.modelPreset, job.mode);
    await this.ensureThinkingBudget(job.thinkingBudget, job.mode);
    if (job.attachmentPaths.length > 0) {
      await this.driver.upload(FILE_INPUT_SELECTOR, job.attachmentPaths);
    }
    await this.setPrompt(buildPrompt(job.runToken, job.promptText));
    await this.clickSend();
    const conversationUrl = await this.waitForConversationUrl();
    return { conversationUrl, tabId: this.driver.getTabId(), windowId: this.driver.getWindowId() };
  }

  async observe(job: ChatGptJobRecord): Promise<JobObservation> {
    if (job.conversationUrl) {
      await this.driver.open(job.conversationUrl);
    } else {
      await this.driver.open(CHATGPT_HOME_URL);
    }
    await this.waitForConversationHydration(job);

    let raw = await this.driver.eval<Record<string, unknown>>(OBSERVE_SCRIPT);
    raw = await this.stabilizeObservation(raw);
    const latestAssistantText = asString(raw.latestAssistantText);
    return {
      observedAt: new Date().toISOString(),
      url: asString(raw.url) || job.conversationUrl || CHATGPT_HOME_URL,
      title: asString(raw.title),
      busy: Boolean(raw.generatingHint),
      shareButtonVisible: Boolean(raw.shareButtonVisible),
      latestAssistantText,
      latestAssistantHash: latestAssistantText ? createHash('sha256').update(latestAssistantText).digest('hex') : undefined,
      assistantTurnCount: asNumber(raw.assistantTurnCount),
      generatingHint: Boolean(raw.generatingHint),
      loginRequired: Boolean(raw.loginRequired),
      captchaRequired: Boolean(raw.captchaRequired),
      errorHint: asString(raw.errorHint) || undefined,
      rawSignals: raw,
    };
  }

  async exportPdf(conversationUrl: string, pdfPath: string): Promise<void> {
    await this.driver.open(conversationUrl);
    await this.waitForConversationHydration();
    await this.driver.pdf(pdfPath);
  }

  private async stabilizeObservation(raw: Record<string, unknown>): Promise<Record<string, unknown>> {
    let current = raw;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const hasAssistantText = Boolean(asString(current.latestAssistantText));
      const assistantTurnCount = asNumber(current.assistantTurnCount);
      if (hasAssistantText || assistantTurnCount > 0) {
        return current;
      }
      await sleep(750);
      current = await this.driver.eval<Record<string, unknown>>(OBSERVE_SCRIPT);
    }
    return current;
  }

  private async waitForTextbox(): Promise<void> {
    await waitFor(15_000, async () =>
      maybeBoolean(
        this.driver.eval<boolean | string>("Boolean(document.querySelector('#prompt-textarea'))"),
        (value) => value === true || value === 'true',
      ),
    );
  }

  private async waitForConversationHydration(job?: ChatGptJobRecord): Promise<void> {
    await waitFor(10_000, async () => {
      const hasStructure = await maybeBoolean(
        this.driver.eval<boolean | string>(`
          Boolean(
            document.querySelector('#prompt-textarea') ||
            document.querySelector('[data-message-author-role="assistant"]') ||
            document.querySelector('article')
          )
        `),
        (value) => value === true || value === 'true',
      );

      if (!hasStructure) {
        return false;
      }

      if (!job?.runToken) {
        return true;
      }

      return maybeBoolean(
        this.driver.eval<boolean | string>(`(document.body?.innerText || '').includes(${JSON.stringify(job.runToken)})`),
        (value) => value === true || value === 'true',
      );
    });
  }

  private async ensureMode(mode: JobMode): Promise<void> {
    if (mode === 'chat' || mode === 'gpt_pro') {
      return;
    }
    await this.activateDeepResearch();
  }

  private async setPrompt(promptText: string): Promise<void> {
    const result = await this.driver.eval<unknown>(`
      (() => {
        const box = document.querySelector('#prompt-textarea');
        if (!box) {
          return 'NO_BOX';
        }
        const text = ${JSON.stringify(promptText)};
        box.focus();
        const selection = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(box);
        selection.removeAllRanges();
        selection.addRange(range);
        const ok = document.execCommand('insertText', false, text);
        return JSON.stringify({
          ok,
          textContent: box.textContent || '',
          html: box.innerHTML || ''
        });
      })();
    `);
    const payload =
      result && typeof result === 'object'
        ? (result as Record<string, unknown>)
        : typeof result === 'string'
          ? safeParseObject(result)
          : undefined;
    const textContent =
      typeof payload?.textContent === 'string' ? payload.textContent : typeof result === 'string' ? result : '';

    if (!textContent || !textContent.includes(promptText.slice(0, Math.min(promptText.length, 12)))) {
      throw new RunnerError('SUBMIT_FAILED', 'Failed to inject prompt into ChatGPT composer', {
        result,
      });
    }
  }

  private async clickSend(): Promise<void> {
    await this.driver.click(SEND_BUTTON_SELECTOR);
  }

  private async waitForConversationUrl(): Promise<string | undefined> {
    let latestUrl = '';
    await waitFor(20_000, async () => {
      latestUrl = await this.driver.eval<string>('location.href');
      return latestUrl.includes('/c/');
    });
    return latestUrl || undefined;
  }

  private async ensureModelPreset(modelPreset: ModelPreset | undefined, mode: JobMode): Promise<void> {
    if (!modelPreset || mode === 'deep_research') {
      return;
    }

    const current = await this.readCurrentModelLabel();
    if (current.includes(MODEL_LABELS[modelPreset])) {
      return;
    }

    await this.pointerClick(MODEL_SWITCHER_SELECTOR);
    await waitFor(10_000, async () =>
      maybeBoolean(
        this.driver.eval<boolean | string>(`Boolean(document.querySelector('[data-testid="${MODEL_TEST_IDS[modelPreset]}"]'))`),
        (value) => value === true || value === 'true',
      ),
    );
    await this.pointerClick(`[data-testid="${MODEL_TEST_IDS[modelPreset]}"]`);
    await waitFor(10_000, async () => {
      const label = await this.readCurrentModelLabel();
      return label.includes(MODEL_LABELS[modelPreset]);
    });
  }

  private async ensureThinkingBudget(thinkingBudget: ThinkingBudget | undefined, mode: JobMode): Promise<void> {
    if (!thinkingBudget || mode === 'deep_research') {
      return;
    }

    const budgetButtonSelector = await this.resolveThinkingBudgetButtonSelector();
    if (!budgetButtonSelector) {
      throw new RunnerError(
        'MODE_NOT_SUPPORTED',
        'Thinking budget selector is not available for the current model',
        { thinking_budget: thinkingBudget },
      );
    }

    const current = await this.readThinkingBudgetLabel();
    if (current?.toLowerCase().startsWith(BUDGET_LABELS[thinkingBudget].toLowerCase())) {
      return;
    }

    await this.pointerClick(budgetButtonSelector);
    await waitFor(10_000, async () =>
      maybeBoolean(
        this.driver.eval<boolean | string>(`
          Boolean(Array.from(document.querySelectorAll('[role="menuitem"], [role="menuitemradio"], [role="option"]'))
            .find((el) => (el.textContent || '').trim() === ${JSON.stringify(BUDGET_LABELS[thinkingBudget])}))
        `),
        (value) => value === true || value === 'true',
      ),
    );

    const clicked = await this.driver.eval<string>(`
      (() => {
        const target = Array.from(document.querySelectorAll('[role="menuitem"], [role="menuitemradio"], [role="option"]'))
          .find((el) => (el.textContent || '').trim() === ${JSON.stringify(BUDGET_LABELS[thinkingBudget])});
        if (!target) {
          return 'NO_BUDGET_ITEM';
        }
        const rect = target.getBoundingClientRect();
        const common = {bubbles:true,cancelable:true,clientX:rect.left + rect.width / 2,clientY:rect.top + rect.height / 2,button:0,buttons:1,pointerType:'mouse',isPrimary:true};
        target.dispatchEvent(new PointerEvent('pointerdown', common));
        target.dispatchEvent(new MouseEvent('mousedown', common));
        target.dispatchEvent(new PointerEvent('pointerup', {...common, buttons:0}));
        target.dispatchEvent(new MouseEvent('mouseup', {...common, buttons:0}));
        target.dispatchEvent(new MouseEvent('click', {...common, buttons:0}));
        return 'OK';
      })();
    `);

    if (clicked !== 'OK') {
      throw new RunnerError('MODE_NOT_SUPPORTED', 'Failed to select thinking budget', {
        thinking_budget: thinkingBudget,
        result: clicked,
      });
    }

    await waitFor(10_000, async () => {
      const label = await this.readThinkingBudgetLabel();
      return label?.toLowerCase().startsWith(BUDGET_LABELS[thinkingBudget].toLowerCase()) ?? false;
    });
  }

  private async activateDeepResearch(): Promise<void> {
    const clicked = await this.driver.eval<string>(`
      (() => {
        const target = document.querySelector('${DEEP_RESEARCH_SIDEBAR_SELECTOR}');
        if (!target) {
          return 'NO_DEEP_RESEARCH_LINK';
        }
        const rect = target.getBoundingClientRect();
        const common = {bubbles:true,cancelable:true,clientX:rect.left + rect.width / 2,clientY:rect.top + rect.height / 2,button:0,buttons:1,pointerType:'mouse',isPrimary:true};
        target.dispatchEvent(new PointerEvent('pointerdown', common));
        target.dispatchEvent(new MouseEvent('mousedown', common));
        target.dispatchEvent(new PointerEvent('pointerup', {...common, buttons:0}));
        target.dispatchEvent(new MouseEvent('mouseup', {...common, buttons:0}));
        target.dispatchEvent(new MouseEvent('click', {...common, buttons:0}));
        return location.href;
      })();
    `);

    if (clicked === 'NO_DEEP_RESEARCH_LINK') {
      await this.driver.open(CHATGPT_DEEP_RESEARCH_URL);
    }

    await waitFor(15_000, async () =>
      maybeBoolean(
        this.driver.eval<boolean | string>(`
          location.href.includes('/deep-research') ||
          ((document.querySelector('[data-testid="composer-footer-actions"]')?.textContent || '').includes('Deep research'))
        `),
        (value) => value === true || value === 'true',
      ),
    );
  }

  private async pointerClick(selector: string): Promise<void> {
    const result = await this.driver.eval<string>(`
      (() => {
        const target = document.querySelector(${JSON.stringify(selector)});
        if (!target) {
          return 'NO_TARGET';
        }
        const rect = target.getBoundingClientRect();
        const common = {bubbles:true,cancelable:true,clientX:rect.left + rect.width / 2,clientY:rect.top + rect.height / 2,button:0,buttons:1,pointerType:'mouse',isPrimary:true};
        target.dispatchEvent(new PointerEvent('pointerdown', common));
        target.dispatchEvent(new MouseEvent('mousedown', common));
        target.dispatchEvent(new PointerEvent('pointerup', {...common, buttons:0}));
        target.dispatchEvent(new MouseEvent('mouseup', {...common, buttons:0}));
        target.dispatchEvent(new MouseEvent('click', {...common, buttons:0}));
        return 'OK';
      })();
    `);

    if (result !== 'OK') {
      throw new RunnerError('MODE_NOT_SUPPORTED', `Could not click selector: ${selector}`, {
        selector,
        result,
      });
    }
  }

  private async readCurrentModelLabel(): Promise<string> {
    return this.driver.eval<string>(`
      (() => {
        const button = document.querySelector('${MODEL_SWITCHER_SELECTOR}');
        return button ? ((button.textContent || '').trim() + ' ' + (button.getAttribute('aria-label') || '')).trim() : '';
      })();
    `);
  }

  private async resolveThinkingBudgetButtonSelector(): Promise<string | undefined> {
    const selector = await this.driver.eval<string>(`
      (() => {
        const buttons = Array.from(document.querySelectorAll('[data-testid="composer-footer-actions"] button'));
        const target = buttons.find((button) => {
          const text = (button.textContent || '').trim().toLowerCase();
          const aria = (button.getAttribute('aria-label') || '').toLowerCase();
          return text.includes('thinking') && !aria.includes('click to remove');
        });
        if (!target) {
          return '';
        }
        if (!target.id) {
          target.id = 'cgpt-runner-thinking-budget-pill';
        }
        return '#' + target.id;
      })();
    `);
    return selector || undefined;
  }

  private async readThinkingBudgetLabel(): Promise<string | undefined> {
    const label = await this.driver.eval<string>(`
      (() => {
        const buttons = Array.from(document.querySelectorAll('[data-testid="composer-footer-actions"] button'));
        const target = buttons.find((button) => {
          const text = (button.textContent || '').trim().toLowerCase();
          const aria = (button.getAttribute('aria-label') || '').toLowerCase();
          return text.includes('thinking') && !aria.includes('click to remove');
        });
        return target ? (target.textContent || '').trim() : '';
      })();
    `);
    return label || undefined;
  }
}

export function classifyObservation(observation: JobObservation): JobState {
  if (observation.loginRequired || observation.captchaRequired) {
    return 'manual_action_required';
  }

  if (observation.errorHint) {
    return 'failed';
  }

  if (!observation.busy && observation.latestAssistantText) {
    return 'completed';
  }

  return 'running';
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function buildPrompt(runToken: string, promptText: string): string {
  return `RUN_TOKEN: ${runToken}\n\n${promptText}`;
}

async function waitFor(ms: number, predicate: () => Promise<boolean>): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < ms) {
    if (await predicate()) {
      return;
    }
    await sleep(500);
  }
  throw new RunnerError('SUBMIT_FAILED', 'Timed out waiting for ChatGPT page state');
}

async function maybeBoolean<T>(promise: Promise<T>, mapper: (value: T) => boolean): Promise<boolean> {
  try {
    const value = await promise;
    return mapper(value);
  } catch {
    return false;
  }
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function asNumber(value: unknown): number {
  return typeof value === 'number' ? value : 0;
}

function safeParseObject(value: string): Record<string, unknown> | undefined {
  try {
    return JSON.parse(value) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}
