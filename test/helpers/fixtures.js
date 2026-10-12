// Data folders shaped exactly like Brisk Budget v0.1.0, v0.1.2 and v0.1.4 wrote them (see
// `git show cb6befc:server/routes/*.js` and `git show 4c3c7f4:server/...`):
//  - no meta.json (older versions never wrote one)
//  - transactions/recurring store the category NAME in `category`
//  - icons are base64 data URLs inside accounts.json / account-groups.json
//  - transfers are two rows linked by transferId/transferAccountId, category 'Transfer',
//    payee 'Transfer to X' / 'Transfer from Y'
//  - v0.1.0: no account-groups.json, no dismissed.json, no groupId, no paused, no mortgage
//  - v0.1.2: account-groups.json, groupId, but no dismissed.json / paused / mortgage
//  - v0.1.4: dismissed.json, paused, mortgage accounts (interestRate, lastInterestAccrual),
//    autoInterest transactions
import fs from 'node:fs';
import path from 'node:path';
import { defaultCategories } from '../../server/store/defaults.js';

// 1x1 PNG and a few JPEG-looking bytes (the migration only needs valid base64 + mime type)
export const PNG_BYTES = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082',
  'hex'
);
export const JPEG_BYTES = Buffer.from('ffd8ffe000104a46494600010100000100010000ffdb004300080606070605080707070909080a0c140d0c0b0b0c1912130f141d1a1f1e1d1a1c1c20242e2720222c231c1c2837292c30313434341f27393d38323c2e333432ffd9', 'hex');
export const pngDataUrl = (bytes = PNG_BYTES) => `data:image/png;base64,${bytes.toString('base64')}`;
export const jpegDataUrl = (bytes = JPEG_BYTES) => `data:image/jpeg;base64,${bytes.toString('base64')}`;

// v0.1.x default categories had no colours
export function oldDefaultCategories() {
  return defaultCategories().map(({ color, ...rest }) => rest);
}

const created = '2026-01-02T10:00:00.000Z';

function tx(id, date, amount, payee, category, extra = {}) {
  return {
    id, payee, amount, date, category,
    description: extra.description ?? '',
    notes: extra.notes ?? '',
    createdAt: extra.createdAt ?? `${typeof date === 'string' && date.length === 10 ? date : '2024-01-05'}T09:00:00.000Z`,
    transferId: extra.transferId ?? null,
    transferAccountId: extra.transferAccountId ?? null,
    ...(extra.autoInterest ? { autoInterest: true } : {})
  };
}

// Build the files for one old version. Returns { files: { relPath: value }, info } where
// `info` describes what the tests should expect after the upgrade.
export function oldData(version) {
  const v014 = version === '0.1.4';
  const hasGroups = version !== '0.1.0';

  const categories = oldDefaultCategories();
  // A custom top-level category whose name clashes with the default "Shopping > Gifts"
  categories.push({
    id: 'lx1custgifts', name: 'Gifts', emoji: '🎁', isDefault: false, sortOrder: 17,
    subcategories: [{ id: 'lx1subbday', name: 'Birthdays', sortOrder: 1 }]
  });

  const accounts = [
    {
      id: 'acc0current', name: 'Current Account', type: 'bank', startingBalance: 1500, assetValue: null,
      icon: jpegDataUrl(), active: true, sortOrder: 1, createdAt: created,
      ...(hasGroups ? { groupId: 'grp0everyday' } : {}),
      ...(v014 ? { interestRate: null, lastInterestAccrual: null } : {})
    },
    {
      // Saved by the old "merge the body" update, so the balance is a string
      id: 'acc0savings', name: 'Savings', type: 'savings', startingBalance: '250.50', assetValue: null,
      icon: null, active: true, sortOrder: 2, createdAt: created,
      ...(hasGroups ? { groupId: 'grp0deleted' } : {})
    },
    { id: 'acc0credit', name: 'Credit Card', type: 'credit', startingBalance: -120, assetValue: null, icon: null, active: true, sortOrder: 3, createdAt: created },
    { id: 'acc0archived', name: 'Old Bank', type: 'bank', startingBalance: 10, assetValue: null, icon: null, active: false, sortOrder: 5, createdAt: created }
  ];
  if (v014) {
    accounts.push({
      id: 'acc0mortgage', name: 'Mortgage', type: 'mortgage', startingBalance: -200000, assetValue: 300000,
      interestRate: 4.8, lastInterestAccrual: '2026-09-20', icon: null, active: true, sortOrder: 4, createdAt: created
    });
  }

  const current = [
    tx('t01', '2026-09-01', -45.2, 'Tesco', 'Groceries'),
    tx('t02', '2026-09-25', 2000, 'Employer Ltd', 'Salary'),
    tx('t03', '2026-09-26', -200, 'Transfer to Savings', 'Transfer', { transferId: 't11', transferAccountId: 'acc0savings' }),
    tx('t04', '2026-09-10', -300, 'Thomas Cook', 'Holiday Fund'),
    tx('t05', '2026-09-11', -25, 'Card Shop', 'Gifts'),
    tx('t06', '2026-09-12', -10, 'Aldi', 'groceries'),
    tx('t07', '2026-09-13', '-12.50', 'Costa', 'Coffee & Snacks'),
    tx('t08', '2024-1-5', -5, 'Old import', ''),
    tx('t09', '2026-09-14', -1, 'Mystery', 'Uncategorized'),
    tx('t12', '2026-09-16', -7, 'Card Shop', 'Birthdays'),
    tx('t13', '2026-09-17', -40, 'Hotel', 'holiday fund'),
    tx('t14', '2026-09-18', -30, 'Gym', 'Gym & Fitness')
  ];
  const savings = [
    tx('t11', '2026-09-26', 200, 'Transfer from Current Account', 'Transfer', { transferId: 't03', transferAccountId: 'acc0current' })
  ];
  const credit = [
    tx('t21', '2026-09-20', -60, 'Pizza Express', 'Dining Out'),
    tx('t22', '2026-09-21', 15, 'Next', 'Clothing')
  ];
  const archived = [tx('t41', '2025-03-01', -3, 'Old', 'Shopping')];
  const transactions = { acc0current: current, acc0savings: savings, acc0credit: credit, acc0archived: archived };
  if (v014) {
    current.push(tx('t10', '2026-09-15', -1000, 'Transfer to Mortgage', 'Transfer', { transferId: 't31', transferAccountId: 'acc0mortgage' }));
    transactions.acc0mortgage = [
      tx('t31', '2026-09-15', 1000, 'Transfer from Current Account', 'Transfer', { transferId: 't10', transferAccountId: 'acc0current' }),
      tx('t32', '2026-08-20', -800, 'Interest', 'Mortgage', { description: 'Interest @ 4.8% p.a.', autoInterest: true })
    ];
  }

  const template = (id, fields) => ({
    id, type: 'transaction', accountId: 'acc0current', fromAccountId: null, toAccountId: null,
    payee: '', amount: 0, category: 'Uncategorized', description: '', notes: '',
    frequency: { type: 'months', interval: 1 }, endCondition: { type: 'never', value: null },
    occurrencesCompleted: 0, active: true, createdAt: created,
    ...(v014 ? { paused: false } : {}),
    ...fields
  });
  const recurring = [
    // Old local-time stepping slipped a 31st payment onto the 3rd
    template('rec0rent', { payee: 'Landlord', amount: -950, category: 'Rent', startDate: '2026-01-31', nextDueDate: '2026-11-03', occurrencesCompleted: 9 }),
    // UK clock change knocked this one back a day
    template('rec0council', { payee: 'Council', amount: -150, category: 'Council Tax', startDate: '2025-12-16', nextDueDate: '2026-05-15', occurrencesCompleted: 5 }),
    // Exactly on schedule: must not be touched
    template('rec0gym', { payee: 'Gym', amount: -30, category: 'Gym & Fitness', startDate: '2026-01-10', nextDueDate: '2026-11-10', occurrencesCompleted: 10 }),
    template('rec0save', {
      type: 'transfer', accountId: null, fromAccountId: 'acc0current', toAccountId: 'acc0savings',
      amount: 100, category: 'Transfer', startDate: '2026-01-28', nextDueDate: '2026-10-28', occurrencesCompleted: 9
    }),
    template('rec0deleted', { payee: 'Netflix', amount: -10.99, category: 'Streaming Services', startDate: '2026-01-05', nextDueDate: '2026-06-05', active: false })
  ];
  if (v014) {
    recurring.push(template('rec0paused', { payee: 'Spotify', amount: -11.99, category: 'Music & Concerts', startDate: '2026-02-01', nextDueDate: '2026-11-01', paused: true }));
  }

  const files = {
    'accounts.json': accounts,
    'categories.json': categories,
    'payees.json': [
      { id: 'pay1', name: 'Tesco' },
      { id: 'pay2', name: 'tesco' },
      { id: 'pay3', name: '   ' },
      { id: 'pay4', name: 'Costa' }
    ],
    'recurring.json': recurring,
    'settings.json': v014 ? { currencySymbol: '£', groupChartToggles: false } : { currencySymbol: '£' }
  };
  if (hasGroups) {
    files['account-groups.json'] = [
      { id: 'grp0everyday', name: 'Everyday', icon: pngDataUrl(), sortOrder: 0, collapsed: false, createdAt: created }
    ];
  }
  if (v014) files['dismissed.json'] = ['acc0current|tesco'];
  for (const [id, list] of Object.entries(transactions)) files[`transactions/${id}.json`] = list;

  // What the upgrade should produce for each transaction's category
  const expectedCategory = {
    t01: 'sub-groceries',
    t02: 'sub-salary',
    t03: 'cat-transfer',
    t04: 'IMPORTED:Holiday Fund',
    t05: 'lx1custgifts', // the top-level "Gifts" wins over "Shopping > Gifts"
    t06: 'sub-groceries',
    t07: 'sub-coffee',
    t08: 'cat-uncategorized',
    t09: 'cat-uncategorized',
    t10: 'cat-transfer',
    t11: 'cat-transfer',
    t12: 'lx1subbday',
    t13: 'IMPORTED:Holiday Fund', // same unknown name, different case: same subcategory
    t14: 'sub-gym',
    t21: 'sub-dining',
    t22: 'sub-clothing',
    t31: 'cat-transfer',
    t32: 'sub-mortgage',
    t41: 'cat-shopping'
  };

  return { files, version, expectedCategory, transactions, accounts, recurring };
}

export function writeDataFolder(dataDir, files) {
  for (const [rel, value] of Object.entries(files)) {
    const full = path.join(dataDir, ...rel.split('/'));
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, Buffer.isBuffer(value) ? value : JSON.stringify(value, null, 2));
  }
}

// Balance the old app would have shown, computed the careful way (pence, numbers parsed)
export function expectedBalancesPence(fixture) {
  const out = {};
  for (const account of fixture.accounts) {
    let pence = Math.round(parseFloat(account.startingBalance) * 100);
    for (const t of fixture.transactions[account.id] || []) pence += Math.round(parseFloat(t.amount) * 100);
    out[account.id] = pence;
  }
  return out;
}
