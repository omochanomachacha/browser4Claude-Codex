import test from 'node:test';
import assert from 'node:assert/strict';
import { toDaemonRequest } from '../../src/cli/human-browser.ts';
import { HBError } from '../../src/shared/errors.ts';

test('open maps to daemon open command', () => {
  const request = toDaemonRequest('open', ['https://example.com']);
  assert.equal(request.command, 'open');
  assert.deepEqual(request.args, {
    url: 'https://example.com',
    tab_id: undefined,
  });
});

test('screenshot supports optional path and --full', () => {
  const request = toDaemonRequest('screenshot', ['output.png', '--full', '--tab', 'active']);
  assert.equal(request.command, 'screenshot');
  assert.deepEqual(request.args, {
    path: 'output.png',
    full_page: true,
    tab_id: 'active',
  });
});

test('state maps to interactive compact snapshot by default', () => {
  const request = toDaemonRequest('state', []);
  assert.equal(request.command, 'snapshot');
  assert.deepEqual(request.args, {
    target: undefined,
    interactive: true,
    cursor: true,
    compact: true,
  });
});

test('click supports numeric index via latest snapshot', () => {
  const request = toDaemonRequest('click', ['1']);
  assert.equal(request.command, 'click');
  assert.deepEqual(request.args, {
    index: 1,
    snapshot_id: undefined,
    tab_id: undefined,
  });
});

test('input alias maps to fill with numeric index', () => {
  const request = toDaemonRequest('input', ['2', 'hello@example.com']);
  assert.equal(request.command, 'fill');
  assert.deepEqual(request.args, {
    index: 2,
    value: 'hello@example.com',
    snapshot_id: undefined,
    tab_id: undefined,
  });
});

test('keys alias maps to keypress', () => {
  const request = toDaemonRequest('keys', ['Meta+L']);
  assert.equal(request.command, 'keypress');
  assert.deepEqual(request.args, {
    key: 'Meta+L',
    tab_id: undefined,
  });
});

test('scroll supports directional shorthand', () => {
  const request = toDaemonRequest('scroll', ['down', '250']);
  assert.equal(request.command, 'scroll');
  assert.deepEqual(request.args, {
    x: 0,
    y: 250,
    tab_id: undefined,
  });
});

test('get text with ref requires snapshot id', () => {
  assert.throws(
    () => {
      toDaemonRequest('get', ['text', '@e1']);
    },
    (error: unknown) => error instanceof HBError && error.structured.code === 'BAD_REQUEST',
  );
});

test('cookies set maps to cookies_set', () => {
  const request = toDaemonRequest('cookies', ['set', 'session', 'abc', '--url', 'https://example.com']);
  assert.equal(request.command, 'cookies_set');
  assert.deepEqual(request.args, {
    name: 'session',
    value: 'abc',
    url: 'https://example.com',
  });
});

test('network requests maps to network_dump', () => {
  const request = toDaemonRequest('network', ['requests', '--filter', 'api', '--clear']);
  assert.equal(request.command, 'network_dump');
  assert.deepEqual(request.args, {
    filter: 'api',
    clear: true,
    tab_id: undefined,
  });
});

test('console default maps to console_dump', () => {
  const request = toDaemonRequest('console', []);
  assert.equal(request.command, 'console_dump');
  assert.deepEqual(request.args, {
    clear: false,
    tab_id: undefined,
  });
});

test('wait-for alias maps to wait', () => {
  const request = toDaemonRequest('wait-for', ['#ready', '--timeout', '1500']);
  assert.equal(request.command, 'wait');
  assert.deepEqual(request.args, {
    selector: '#ready',
    timeout_ms: 1500,
  });
});

test('upload with selector maps files and optional tab', () => {
  const request = toDaemonRequest('upload', ['#file', './a.csv', './b.pdf', '--tab', 'active']);
  assert.equal(request.command, 'upload');
  assert.deepEqual(request.args, {
    selector: '#file',
    files: ['./a.csv', './b.pdf'],
    tab_id: 'active',
  });
});

test('upload with ref requires snapshot id', () => {
  assert.throws(
    () => {
      toDaemonRequest('upload', ['@e1', './a.csv']);
    },
    (error: unknown) => error instanceof HBError && error.structured.code === 'BAD_REQUEST',
  );
});

test('get text supports numeric index without explicit snapshot id', () => {
  const request = toDaemonRequest('get', ['text', '3']);
  assert.equal(request.command, 'text');
  assert.deepEqual(request.args, {
    index: 3,
    snapshot_id: undefined,
    tab_id: undefined,
  });
});
