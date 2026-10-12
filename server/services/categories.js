import { badRequest, conflict, notFound } from '../lib/errors.js';
import { has, requireObject, str, id as idField, idList } from '../lib/validate.js';
import { newId } from '../lib/ids.js';
import { CATEGORY_PALETTE, defaultCategories, TRANSFER_CATEGORY_ID, UNCATEGORIZED_ID } from '../store/defaults.js';

const COLOUR_RE = /^#[0-9a-fA-F]{6}$/;

export function createCategories(app) {
  const { store } = app;
  let cache = { revision: -1, index: null };

  const categories = () => store.data.categories;
  const sorted = (list) => [...list].sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));

  // id -> { id, name, emoji, color, parentId, parentName, isSub }
  function index() {
    if (cache.revision === store.revision && cache.index) return cache.index;
    const map = new Map();
    for (const c of categories()) {
      map.set(c.id, { id: c.id, name: c.name, emoji: c.emoji, color: c.color, parentId: c.id, parentName: c.name, isSub: false, isSystem: !!c.isSystem });
      for (const s of c.subcategories || []) {
        map.set(s.id, { id: s.id, name: s.name, emoji: c.emoji, color: c.color, parentId: c.id, parentName: c.name, isSub: true, isSystem: false });
      }
    }
    cache = { revision: store.revision, index: map };
    return map;
  }

  const info = (id) => index().get(id) || index().get(UNCATEGORIZED_ID) || { id: UNCATEGORIZED_ID, name: 'Uncategorized', emoji: '❓', color: '#94a3b8', parentId: UNCATEGORIZED_ID, parentName: 'Uncategorized' };
  const exists = (id) => index().has(id);

  function resolveName(name) {
    const clean = (name || '').trim();
    if (!clean) return null;
    const lower = clean.toLowerCase();
    let fallback = null;
    for (const c of sorted(categories())) {
      if (c.name === clean) return c.id;
      if (!fallback && c.name.toLowerCase() === lower) fallback = c.id;
    }
    for (const c of sorted(categories())) {
      for (const s of c.subcategories || []) {
        if (s.name === clean) return s.id;
        if (!fallback && s.name.toLowerCase() === lower) fallback = s.id;
      }
    }
    return fallback;
  }

  // Validate a categoryId from a request, falling back to a category name for convenience
  function pick(body, { allowTransfer = false } = {}) {
    let id = null;
    if (has(body, 'categoryId') && body.categoryId) {
      id = idField(body.categoryId, 'categoryId');
      if (!exists(id)) throw badRequest('That category no longer exists');
    } else if (has(body, 'category') && body.category) {
      id = resolveName(String(body.category)) || UNCATEGORIZED_ID;
    }
    if (id === TRANSFER_CATEGORY_ID && !allowTransfer) throw badRequest('Use "Add Transfer" to move money between accounts');
    return id;
  }

  function usage() {
    const counts = new Map();
    const bump = (key) => counts.set(key, (counts.get(key) || 0) + 1);
    for (const list of Object.values(store.data.transactions)) for (const tx of list) bump(tx.categoryId);
    for (const r of store.data.recurring) if (r.active !== false) bump(r.categoryId);
    return counts;
  }

  function list() {
    const counts = usage();
    return sorted(categories()).map(c => ({
      ...c,
      usage: counts.get(c.id) || 0,
      subcategories: sorted(c.subcategories || []).map(s => ({ ...s, usage: counts.get(s.id) || 0 }))
    }));
  }

  function find(id) {
    const category = categories().find(c => c.id === id);
    if (!category) throw notFound('Category not found');
    return category;
  }

  function cleanName(body, siblings, ignoreId) {
    const name = str(body.name, 'Name', { required: true, max: 60 });
    // Keeping a name it already has is always fine, even if old data has two with that name
    const current = siblings.find(s => s.id === ignoreId);
    if (current && current.name === name) return name;
    if (siblings.some(s => s.id !== ignoreId && s.name.toLowerCase() === name.toLowerCase())) {
      throw conflict(`There's already a category called "${name}"`);
    }
    return name;
  }

  function cleanColour(value) {
    if (!COLOUR_RE.test(value || '')) throw badRequest('Colour must look like #22c55e');
    return value.toLowerCase();
  }

  function create(body) {
    requireObject(body);
    const name = cleanName(body, categories());
    const custom = categories().filter(c => !c.isSystem);
    const category = {
      id: newId(),
      name,
      emoji: str(body.emoji, 'Emoji', { max: 16 }) || '📁',
      color: body.color ? cleanColour(body.color) : CATEGORY_PALETTE[custom.length % CATEGORY_PALETTE.length],
      isDefault: false,
      sortOrder: Math.max(-1, ...custom.map(c => c.sortOrder ?? 0)) + 1,
      subcategories: []
    };
    categories().push(category);
    store.save('categories');
    return category;
  }

  function update(id, body) {
    requireObject(body);
    const category = find(id);
    if (category.isSystem && has(body, 'name')) throw badRequest("System categories can't be renamed");
    const changes = {};
    if (has(body, 'name')) changes.name = cleanName(body, categories(), id);
    if (has(body, 'emoji')) changes.emoji = str(body.emoji, 'Emoji', { max: 16 }) || '📁';
    if (has(body, 'color')) changes.color = cleanColour(body.color);
    Object.assign(category, changes);
    store.save('categories');
    return category;
  }

  // Move everything filed under `fromIds` to `toId` (transactions and recurring payments)
  function reassign(fromIds, toId) {
    const from = new Set(fromIds);
    const touched = [];
    for (const [accountId, txs] of Object.entries(store.data.transactions)) {
      let changed = false;
      for (const tx of txs) {
        if (from.has(tx.categoryId)) { tx.categoryId = toId; changed = true; }
      }
      if (changed) touched.push(accountId);
    }
    let recurringChanged = false;
    for (const r of store.data.recurring) {
      if (from.has(r.categoryId)) { r.categoryId = toId; recurringChanged = true; }
    }
    if (touched.length) store.saveTransactions(...touched);
    if (recurringChanged) store.save('recurring');
  }

  function needsReplacement(ids, replacementId) {
    const counts = usage();
    const used = ids.reduce((sum, id) => sum + (counts.get(id) || 0), 0);
    if (used === 0) return null;
    if (!replacementId) throw conflict(`This category is used by ${used} item${used === 1 ? '' : 's'}. Choose where to move them.`, { usage: used });
    if (!exists(replacementId)) throw badRequest('The replacement category no longer exists');
    if (ids.includes(replacementId)) throw badRequest("Pick a different category to move things into");
    if (replacementId === TRANSFER_CATEGORY_ID) throw badRequest("Things can't be moved into Transfer");
    return replacementId;
  }

  function remove(id, body = {}) {
    const category = find(id);
    if (category.isSystem) throw badRequest("System categories can't be deleted");
    const ids = [category.id, ...(category.subcategories || []).map(s => s.id)];
    const replacement = needsReplacement(ids, idField(body.replacementId, 'replacementId'));
    if (replacement) reassign(ids, replacement);
    store.data.categories = categories().filter(c => c.id !== id);
    store.save('categories');
    return { success: true };
  }

  function addSubcategory(id, body) {
    requireObject(body);
    const category = find(id);
    if (category.isSystem) throw badRequest("System categories can't have subcategories");
    category.subcategories ||= [];
    const name = cleanName(body, category.subcategories);
    const sub = { id: newId(), name, sortOrder: Math.max(-1, ...category.subcategories.map(s => s.sortOrder ?? 0)) + 1 };
    category.subcategories.push(sub);
    store.save('categories');
    return sub;
  }

  function findSub(id, subId) {
    const category = find(id);
    const sub = (category.subcategories || []).find(s => s.id === subId);
    if (!sub) throw notFound('Subcategory not found');
    return { category, sub };
  }

  function updateSubcategory(id, subId, body) {
    requireObject(body);
    const { category, sub } = findSub(id, subId);
    if (has(body, 'name')) sub.name = cleanName(body, category.subcategories, subId);
    store.save('categories');
    return sub;
  }

  function removeSubcategory(id, subId, body = {}) {
    const { category } = findSub(id, subId);
    const replacement = needsReplacement([subId], idField(body.replacementId, 'replacementId') || category.id);
    if (replacement) reassign([subId], replacement);
    category.subcategories = category.subcategories.filter(s => s.id !== subId);
    store.save('categories');
    return { success: true };
  }

  function reorder(body) {
    const ids = idList(requireObject(body).ids ?? body.categoryIds, 'ids');
    ids.forEach((cid, i) => {
      const c = categories().find(x => x.id === cid);
      if (c && !c.isSystem) c.sortOrder = i;
    });
    store.save('categories');
    return { success: true };
  }

  function reorderSubcategories(id, body) {
    const category = find(id);
    const ids = idList(requireObject(body).ids ?? body.subcategoryIds, 'ids');
    ids.forEach((sid, i) => {
      const s = (category.subcategories || []).find(x => x.id === sid);
      if (s) s.sortOrder = i;
    });
    store.save('categories');
    return { success: true };
  }

  // Back to the default list. Anything filed under a category that no longer exists becomes
  // Uncategorized, exactly as the confirmation message says.
  function reset() {
    store.data.categories = defaultCategories();
    cache = { revision: -1, index: null };
    store.touch();
    const valid = new Set(index().keys());
    const touched = [];
    for (const [accountId, txs] of Object.entries(store.data.transactions)) {
      let changed = false;
      for (const tx of txs) {
        if (!valid.has(tx.categoryId)) { tx.categoryId = tx.transferId ? TRANSFER_CATEGORY_ID : UNCATEGORIZED_ID; changed = true; }
      }
      if (changed) touched.push(accountId);
    }
    let recurringChanged = false;
    for (const r of store.data.recurring) {
      if (!valid.has(r.categoryId)) { r.categoryId = r.type === 'transfer' ? TRANSFER_CATEGORY_ID : UNCATEGORIZED_ID; recurringChanged = true; }
    }
    store.save('categories');
    if (touched.length) store.saveTransactions(...touched);
    if (recurringChanged) store.save('recurring');
    return { success: true, categories: list() };
  }

  return { index, info, exists, resolveName, pick, usage, list, create, update, remove, addSubcategory, updateSubcategory, removeSubcategory, reorder, reorderSubcategories, reset };
}
