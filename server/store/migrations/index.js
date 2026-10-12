// Data upgrades. Each step takes the in-memory dataset from one schema version to the next.
// They run automatically on start-up (after a safety backup) and when an older backup is
// restored, so every past version of Brisk Budget upgrades without manual steps.
import normalise from './001-normalise.js';
import categoryIds from './002-category-ids.js';
import iconFiles from './003-icon-files.js';
import recurringSchedules from './004-recurring-schedules.js';
import mortgageDay from './005-mortgage-interest-day.js';

export const MIGRATIONS = [normalise, categoryIds, iconFiles, recurringSchedules, mortgageDay];
export const SCHEMA_VERSION = MIGRATIONS.length;

export class NewerDataError extends Error {}

// Signs of files written by v0.1.x: category names instead of ids, icons stored inline. Old
// files copied over a newer install (moving to a new server, say) still need upgrading,
// whatever meta.json says.
export function looksOldFormat(data) {
  const lists = Object.values(data?.transactions || {}).filter(Array.isArray);
  if (lists.some(list => list.some(tx => tx && typeof tx.category === 'string' && tx.categoryId === undefined))) return true;
  return Array.isArray(data?.accounts) && data.accounts.some(a => typeof a?.icon === 'string' && a.icon.startsWith('data:'));
}

export function schemaVersionOf(data) {
  const v = data?.meta?.schemaVersion;
  if (!Number.isInteger(v) || v < 0) return 0;
  return v === SCHEMA_VERSION && looksOldFormat(data) ? 0 : v;
}

// Upgrade `data` in place. Returns the list of steps applied and notes worth showing.
export function migrate(data, { appVersion, today, nowIso, newId }) {
  const from = schemaVersionOf(data);
  if (from > SCHEMA_VERSION) {
    throw new NewerDataError(`This data was saved by a newer version of Brisk Budget (data format ${from}). Update Brisk Budget to use it.`);
  }
  data.transactions ??= {};
  data.icons ??= {};
  const notes = [];
  const ctx = { today, nowIso, newId, note: (message) => notes.push(message) };
  const applied = [];
  for (const migration of MIGRATIONS) {
    if (migration.version <= from) continue;
    migration.up(data, ctx);
    applied.push(migration.name);
  }
  const history = Array.isArray(data.meta?.history) ? data.meta.history : [];
  if (applied.length) history.push({ from, to: SCHEMA_VERSION, appVersion, at: nowIso });
  data.meta = {
    ...(data.meta && typeof data.meta === 'object' ? data.meta : {}),
    schemaVersion: SCHEMA_VERSION,
    appVersion,
    history: history.slice(-20)
  };
  return { from, applied, notes };
}
