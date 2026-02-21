import test from 'node:test';
import assert from 'node:assert/strict';
import { toDaemonRequest } from '../../src/cli/human-browser.ts';
import { HBError } from '../../src/shared/errors.ts';

test('snapshot flags are translated into daemon args', () => {
  const request = toDaemonRequest('snapshot', [
    '--tab',
    'active',
    '--interactive',
    '--cursor',
    '--compact',
    '--depth',
    '2',
    '--selector',
    '#app',
  ]);

  assert.equal(request.command, 'snapshot');
  assert.deepEqual(request.args, {
    target: 'active',
    interactive: true,
    cursor: true,
    compact: true,
    depth: 2,
    selector: '#app',
  });
});

test('snapshot depth must be a non-negative integer', () => {
  assert.throws(
    () => {
      toDaemonRequest('snapshot', ['--depth', '-1']);
    },
    (error: unknown) => error instanceof HBError && error.structured.code === 'BAD_REQUEST',
  );
});
