// Transactions and recurring payments used to store the category *name*, so renaming a
// category orphaned everything filed under it. From now on they store the category id.
// Names that no longer match any category are kept as subcategories of a new "Imported"
// category, so nothing that was visible before disappears.
import crypto from 'node:crypto';
import { CATEGORY_PALETTE, DEFAULT_COLOURS, IMPORTED_CATEGORY_ID, TRANSFER_CATEGORY_ID, UNCATEGORIZED_ID } from '../defaults.js';
import { isSafeId } from '../../lib/ids.js';

// The same name always gets the same id, so upgrading an old backup later (to recover a
// damaged file) gives ids that match the transactions already converted
export const importedId = (name) => `imp-${crypto.createHash('sha1').update(name.toLowerCase()).digest('hex').slice(0, 12)}`;

export default {
  version: 2,
  name: 'Store categories by id and give every category a colour',
  up(data, ctx) {
    const byExact = new Map();
    const byLower = new Map();
    const remember = (name, id) => {
      if (!byExact.has(name)) byExact.set(name, id);
      if (!byLower.has(name.toLowerCase())) byLower.set(name.toLowerCase(), id);
    };
    const ordered = [...data.categories].sort((a, b) => a.sortOrder - b.sortOrder);
    // Top-level names win over subcategory names when the same name appears twice
    for (const c of ordered) remember(c.name, c.id);
    for (const c of ordered) for (const s of c.subcategories) remember(s.name, s.id);

    const known = new Set(data.categories.flatMap(c => [c.id, ...c.subcategories.map(s => s.id)]));
    let imported = null;
    const importedSub = (clean) => {
      if (!imported) {
        imported = data.categories.find(c => c.id === IMPORTED_CATEGORY_ID);
        if (!imported) {
          imported = {
            id: IMPORTED_CATEGORY_ID,
            name: 'Imported',
            emoji: '📥',
            isDefault: false,
            sortOrder: Math.max(0, ...data.categories.filter(c => !c.isSystem).map(c => c.sortOrder)) + 1,
            subcategories: []
          };
          data.categories.push(imported);
        }
      }
      const existing = imported.subcategories.find(s => s.name.toLowerCase() === clean.toLowerCase());
      if (existing) return existing.id;
      let id = importedId(clean);
      while (known.has(id)) id = `${id}x`;
      const sub = { id, name: clean.slice(0, 100), sortOrder: imported.subcategories.length };
      imported.subcategories.push(sub);
      known.add(sub.id);
      ctx.note(`Kept "${clean}" under the Imported category`);
      return sub.id;
    };
    // Name -> id. Something filed as "Transfer" that isn't a linked transfer gets its own
    // Imported subcategory, so it can be found and linked up later.
    const resolve = (name, isTransfer) => {
      const clean = (name || '').trim();
      if (isTransfer) return TRANSFER_CATEGORY_ID;
      if (!clean || clean.toLowerCase() === 'uncategorized') return UNCATEGORIZED_ID;
      if (clean.toLowerCase() === 'transfer') return importedSub('Transfers (not linked)');
      if (byExact.has(clean)) return byExact.get(clean);
      if (byLower.has(clean.toLowerCase())) return byLower.get(clean.toLowerCase());
      return importedSub(clean);
    };
    // Already-converted records (re-running after a lost meta.json) keep their id, even one
    // that's no longer in the list: Settings › Data check points those out
    const pick = (record, isTransfer) => {
      if (isTransfer) return TRANSFER_CATEGORY_ID;
      if (typeof record.category === 'string' && record.category.trim()) return resolve(record.category, false);
      if (record.categoryId === TRANSFER_CATEGORY_ID) return importedSub('Transfers (not linked)');
      if (isSafeId(record.categoryId)) return record.categoryId;
      return UNCATEGORIZED_ID;
    };

    for (const list of Object.values(data.transactions)) {
      for (const tx of list) {
        tx.categoryId = pick(tx, !!tx.transferId);
        delete tx.category;
      }
    }
    for (const r of data.recurring) {
      r.categoryId = pick(r, r.type === 'transfer');
      delete r.category;
    }

    let paletteIndex = 0;
    for (const c of data.categories) {
      if (!c.color) c.color = DEFAULT_COLOURS[c.id] || CATEGORY_PALETTE[paletteIndex++ % CATEGORY_PALETTE.length];
    }
  }
};
