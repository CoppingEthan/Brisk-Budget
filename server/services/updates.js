// Checks GitHub for a newer release so Settings can say "update available". Only the public
// releases API is contacted, at most twice a day, and it can be switched off in Settings.
import fs from 'node:fs';
import { APP_VERSION, GITHUB_REPO } from '../config.js';

const CHECK_EVERY_MS = 12 * 60 * 60 * 1000;
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
      const res = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/releases/latest`, {
        headers: { 'User-Agent': `brisk-budget/${APP_VERSION}`, Accept: 'application/vnd.github+json' },
        signal: AbortSignal.timeout(8000)
      });
      if (!res.ok) throw new Error(`GitHub replied ${res.status}`);
      const release = await res.json();
      state.latest = String(release.tag_name || '').replace(/^v/, '') || null;
      state.releaseUrl = release.html_url || null;
      state.releaseName = release.name || null;
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
