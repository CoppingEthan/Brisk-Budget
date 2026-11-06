// Checks GitHub for a newer version so Settings can say "update available". It reads the
// version in package.json on the main branch, because smaller updates are published there without
// a GitHub release (which the releases API would miss). Only that one public file is fetched, at
// most twice a day, and the check can be switched off in Settings.
import fs from 'node:fs';
import { APP_VERSION, GITHUB_REPO } from '../config.js';

const CHECK_EVERY_MS = 12 * 60 * 60 * 1000;
const VERSION_URL = `https://raw.githubusercontent.com/${GITHUB_REPO}/main/package.json`;
const CHANGES_URL = `https://github.com/${GITHUB_REPO}/commits/main`;
const VERSION_RE = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
const TIMER_FILE = '/etc/systemd/system/brisk-budget-update.timer';

// Automatic updates only exist for installs made by deploy.sh (Linux with systemd); anywhere
// else there's no way to tell
function autoUpdateState() {
  try {
    if (process.platform !== 'linux' || !fs.existsSync('/run/systemd/system')) return null;
    return fs.existsSync(TIMER_FILE);
  } catch {
    return null;
  }
}

export function compareVersions(a, b) {
  const pa = String(a).replace(/^v/, '').split(/[.-]/).map(n => parseInt(n, 10) || 0);
  const pb = String(b).replace(/^v/, '').split(/[.-]/).map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0) ? 1 : -1;
  }
  return 0;
}

export function createUpdates(app) {
  const { store, config, log } = app;
  const state = { latest: null, releaseUrl: null, releaseName: null, checkedAt: null, error: null };
  let timers = [];

  const allowed = () => config.updateCheck && store.data.settings.checkForUpdates !== false;
  const disabledReason = () => (!config.updateCheck ? 'env' : store.data.settings.checkForUpdates === false ? 'setting' : null);

  async function check() {
    if (!allowed()) return info();
    try {
      const res = await fetch(VERSION_URL, {
        headers: { 'User-Agent': `brisk-budget/${APP_VERSION}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(8000)
      });
      if (!res.ok) throw new Error(`GitHub replied ${res.status}`);
      const pkg = await res.json();
      const version = typeof pkg?.version === 'string' ? pkg.version.trim() : '';
      if (!VERSION_RE.test(version)) throw new Error('GitHub sent a version that could not be read');
      state.latest = version;
      state.releaseUrl = CHANGES_URL;
      state.releaseName = `v${version}`;
      state.error = null;
    } catch (err) {
      state.error = err.message;
    }
    state.checkedAt = new Date().toISOString();
    return info();
  }

  function info() {
    return {
      current: APP_VERSION,
      latest: state.latest,
      updateAvailable: !!state.latest && compareVersions(state.latest, APP_VERSION) > 0,
      releaseUrl: state.releaseUrl,
      releaseName: state.releaseName,
      checkedAt: state.checkedAt,
      checkEnabled: allowed(),
      checkDisabledReason: disabledReason(),
      checkError: state.error,
      autoUpdate: autoUpdateState()
    };
  }

  function start() {
    if (!config.updateCheck) return;
    const run = () => check().catch(err => log.warn('Update check failed:', err.message));
    timers.push(setTimeout(run, 30 * 1000));
    timers.push(setInterval(run, CHECK_EVERY_MS));
    for (const t of timers) t.unref?.();
  }

  function stop() {
    for (const t of timers) { clearTimeout(t); clearInterval(t); }
    timers = [];
  }

  return { check, info, start, stop };
}
