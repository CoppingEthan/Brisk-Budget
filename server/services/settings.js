import { has, requireObject, str, bool } from '../lib/validate.js';
import { badRequest } from '../lib/errors.js';

export function createSettings(app) {
  const { store } = app;

  function update(body) {
    requireObject(body);
    // Validate into a copy, so a rejected change leaves everything as it was
    const settings = { ...store.data.settings };
    if (has(body, 'currencySymbol')) {
      const symbol = str(body.currencySymbol, 'Currency symbol', { required: true, max: 4 });
      if (/[<>]/.test(symbol)) throw badRequest('Currency symbol contains characters that are not allowed');
      settings.currencySymbol = symbol;
    }
    if (has(body, 'name')) settings.name = str(body.name, 'Name', { max: 60 });
    if (has(body, 'groupChartToggles')) settings.groupChartToggles = bool(body.groupChartToggles, 'groupChartToggles');
    if (has(body, 'checkForUpdates')) settings.checkForUpdates = bool(body.checkForUpdates, 'checkForUpdates');
    store.data.settings = settings;
    store.save('settings');
    return settings;
  }

  return { update };
}

// One-off messages for the interface, e.g. "Brisk Budget was upgraded". Kept in meta.json.
export function createNotices(app) {
  const { store } = app;

  function add(message, kind = 'info') {
    store.data.meta.notices = [...(store.data.meta.notices || []), { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), message, kind }].slice(-10);
    store.save('meta');
  }

  function list() {
    return store.data.meta?.notices || [];
  }

  function dismiss(id) {
    store.data.meta.notices = list().filter(n => id !== undefined && n.id !== id);
    store.save('meta');
    return { success: true };
  }

  return { add, list, dismiss };
}
