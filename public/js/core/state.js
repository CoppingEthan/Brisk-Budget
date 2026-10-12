// App-wide data loaded from /api/bootstrap, plus quick lookups. After anything changes data,
// call changed(): it reloads once and tells the current view to refresh.
import { api } from './api.js';

export const state = {
  ready: false,
  version: '',
  settings: { currencySymbol: '£', name: '', groupChartToggles: true, checkForUpdates: true },
  accounts: [],
  groups: [],
  categories: [],
  payees: [],
  recurring: [],
  auth: { enabled: false, authenticated: true },
  update: null,
  notices: []
};

const listeners = new Set();
export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function emit(reason) {
  for (const fn of listeners) {
    try {
      fn(reason);
    } catch (err) {
      console.error(err);
    }
  }
}

let categoryIndex = new Map();
function buildIndex() {
  categoryIndex = new Map();
  for (const c of state.categories) {
    categoryIndex.set(c.id, { id: c.id, name: c.name, emoji: c.emoji, color: c.color, parentId: c.id, parentName: c.name, isSub: false, isSystem: !!c.isSystem });
    for (const s of c.subcategories || []) {
      categoryIndex.set(s.id, { id: s.id, name: s.name, emoji: c.emoji, color: c.color, parentId: c.id, parentName: c.name, isSub: true, isSystem: false });
    }
  }
}

export async function load() {
  const data = await api.bootstrap();
  Object.assign(state, data, { ready: true });
  buildIndex();
  return state;
}

// A load already in flight may have started before the caller's change, so a caller arriving
// mid-load gets one more load queued after it (shared by everyone who arrives meanwhile).
let inflight = null;
let queued = null;
export function reload() {
  if (queued) return queued;
  if (inflight) {
    queued = inflight.catch(() => {}).then(() => { queued = null; return reload(); });
    return queued;
  }
  inflight = load().finally(() => { inflight = null; });
  return inflight;
}

export async function changed() {
  await reload();
  emit('changed');
}

export const UNCATEGORIZED = 'cat-uncategorized';
export const TRANSFER = 'cat-transfer';
const FALLBACK_CATEGORY = { id: UNCATEGORIZED, name: 'Uncategorized', emoji: '❓', color: '#94a3b8', parentId: UNCATEGORIZED, parentName: 'Uncategorized', isSub: false };

export const category = (id) => categoryIndex.get(id) || categoryIndex.get(UNCATEGORIZED) || FALLBACK_CATEGORY;

const byOrder = (a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0);
export const account = (id) => state.accounts.find(a => a.id === id) || null;
export const archivedAccounts = () => state.accounts.filter(a => a.active === false);
export const groups = () => [...state.groups].sort(byOrder);

// The sidebar's top level, in order: [{ type: 'group', group, children } | { type: 'account', account }].
// Groups and ungrouped accounts share one sort order; accounts inside a group have their own.
export function sidebarLayout() {
  const active = state.accounts.filter(a => a.active !== false).sort(byOrder);
  const groupIds = new Set(state.groups.map(g => g.id));
  return [
    ...groups().map(g => ({ type: 'group', id: g.id, sortOrder: g.sortOrder, group: g, children: active.filter(a => a.groupId === g.id) })),
    ...active.filter(a => !a.groupId || !groupIds.has(a.groupId)).map(a => ({ type: 'account', id: a.id, sortOrder: a.sortOrder, account: a }))
  ].sort(byOrder);
}

// Active accounts in the order the sidebar shows them, so every account list reads the same way
export const activeAccounts = () => sidebarLayout().flatMap(item => (item.type === 'group' ? item.children : [item.account]));

export const LIABILITY_TYPES = ['credit', 'loan', 'mortgage'];
export const ASSET_VALUE_TYPES = ['loan', 'investment', 'asset', 'mortgage'];
export const isLiability = (a) => LIABILITY_TYPES.includes(a?.type);

export const ACCOUNT_TYPES = [
  { id: 'bank', label: 'Bank account' },
  { id: 'savings', label: 'Savings account' },
  { id: 'credit', label: 'Credit card' },
  { id: 'loan', label: 'Loan' },
  { id: 'mortgage', label: 'Mortgage' },
  { id: 'investment', label: 'Investment' },
  { id: 'asset', label: 'Asset' }
];
export const accountTypeLabel = (type) => ACCOUNT_TYPES.find(t => t.id === type)?.label || type;
