// The update check reads the version on the main branch, so updates published without a GitHub
// release still show as available.
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createUpdates, compareVersions } from '../../server/services/updates.js';
import { APP_VERSION, GITHUB_REPO } from '../../server/config.js';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

function fakeApp({ updateCheck = true, setting } = {}) {
  return {
    store: { data: { settings: setting === undefined ? {} : { checkForUpdates: setting } } },
    config: { updateCheck },
    log: { warn() {} }
  };
}

function replyWith(body, status = 200) {
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    calls.push({ url: String(url), opts });
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
  };
  return calls;
}

describe('update check', () => {
  test('reads package.json on main, not the releases API', async () => {
    const calls = replyWith({ name: 'brisk-budget', version: '99.0.0' });
    const info = await createUpdates(fakeApp()).check();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, `https://raw.githubusercontent.com/${GITHUB_REPO}/main/package.json`);
    assert.equal(info.latest, '99.0.0');
    assert.equal(info.updateAvailable, true);
    assert.equal(info.releaseName, 'v99.0.0');
    assert.equal(info.releaseUrl, `https://github.com/${GITHUB_REPO}/commits/main`);
    assert.equal(info.checkError, null);
  });

  test('no update when main has the same version', async () => {
    replyWith({ version: APP_VERSION });
    const info = await createUpdates(fakeApp()).check();
    assert.equal(info.updateAvailable, false);
  });

  test('an unreadable version is an error, not an update', async () => {
    replyWith({ version: '<script>' });
    const info = await createUpdates(fakeApp()).check();
    assert.equal(info.latest, null);
    assert.equal(info.updateAvailable, false);
    assert.match(info.checkError, /could not be read/);
  });

  test('a failed request is reported', async () => {
    replyWith('nope', 503);
    const info = await createUpdates(fakeApp()).check();
    assert.equal(info.updateAvailable, false);
    assert.match(info.checkError, /503/);
  });

  test('nothing is fetched when checks are switched off', async () => {
    const calls = replyWith({ version: '99.0.0' });
    await createUpdates(fakeApp({ setting: false })).check();
    await createUpdates(fakeApp({ updateCheck: false })).check();
    assert.equal(calls.length, 0);
  });

  test('versions compare numerically', () => {
    assert.equal(compareVersions('0.4.10', '0.4.9'), 1);
    assert.equal(compareVersions('v0.5.0', '0.4.5'), 1);
    assert.equal(compareVersions('0.4.5', '0.4.5'), 0);
  });
});
