import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const execFileAsync = promisify(execFile);

test('cli init seeds an actual Chrome profile snapshot for cdp backend', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hb-seed-init-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const sourceUserDataDir = join(root, 'source-user-data');
  const sourceProfileDir = join(sourceUserDataDir, 'Profile 9');
  const targetUserDataDir = join(root, 'target-user-data');
  const configPath = join(root, 'config.json');

  await mkdir(sourceProfileDir, { recursive: true });
  await writeFile(join(sourceUserDataDir, 'Local State'), JSON.stringify({ profile: { last_used: 'Profile 9' } }), 'utf8');
  await writeFile(join(sourceProfileDir, 'Cookies'), 'cookie-db', 'utf8');

  await execFileAsync(process.execPath, [
    join(process.env.HOME ?? '', '.human-browser', 'src', 'cli', 'human-browser.ts'),
    '--config',
    configPath,
    'init',
    '--backend',
    'cdp',
    '--user-data-dir',
    targetUserDataDir,
    '--profile-directory',
    'Profile 9',
    '--seed-user-data-dir',
    sourceUserDataDir,
    '--seed-profile-directory',
    'Profile 9',
  ]);

  const copiedLocalState = await readFile(join(targetUserDataDir, 'Local State'), 'utf8');
  const copiedCookies = await readFile(join(targetUserDataDir, 'Profile 9', 'Cookies'), 'utf8');

  assert.match(copiedLocalState, /Profile 9/);
  assert.equal(copiedCookies, 'cookie-db');
});
