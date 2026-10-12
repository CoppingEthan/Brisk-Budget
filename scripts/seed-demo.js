// Fill a data folder with a realistic demo household, for screenshots, browser tests and
// trying Brisk Budget out. Never point this at real data.
//
//   node scripts/seed-demo.js <data-folder> [months-of-history]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../server/app.js';
import { addDays, addMonths, today, daysInMonth, parts } from '../public/js/shared/dates.js';

export function seedDemo(dataDir, months = 6, { backupsDir = path.join(dataDir, '..', 'backups-demo') } = {}) {

// Small deterministic random generator so every seed looks the same
let seed = 42;
const rand = () => {
  seed = (seed * 1664525 + 1013904223) % 4294967296;
  return seed / 4294967296;
};
const between = (min, max) => Math.round((min + rand() * (max - min)) * 100) / 100;
const pick = (list) => list[Math.floor(rand() * list.length)];

const app = createApp({ dataDir, backupsDir, autoBackup: false, updateCheck: false, quiet: true });
const s = app.services;
const now = today();
const start = addMonths(now, -months);

s.accounts.createGroup({ name: 'Everyday' });
const groups = s.accounts.listGroups();
const everyday = groups[0].id;
const savingsGroup = s.accounts.createGroup({ name: 'Savings' }).id;
const borrowing = s.accounts.createGroup({ name: 'Borrowing' }).id;

const current = s.accounts.create({ name: 'Current Account', type: 'bank', startingBalance: 1850, groupId: everyday });
const joint = s.accounts.create({ name: 'Joint Account', type: 'bank', startingBalance: 920, groupId: everyday });
const card = s.accounts.create({ name: 'Credit Card', type: 'credit', startingBalance: -340, groupId: everyday });
const easy = s.accounts.create({ name: 'Easy Access Saver', type: 'savings', startingBalance: 6200, groupId: savingsGroup });
const isa = s.accounts.create({ name: 'Stocks & Shares ISA', type: 'investment', startingBalance: 14250, assetValue: 17550, groupId: savingsGroup });
const car = s.accounts.create({ name: 'Car Finance', type: 'loan', startingBalance: -8400, assetValue: 11500, groupId: borrowing });
const mortgage = s.accounts.create({ name: 'Mortgage', type: 'mortgage', startingBalance: -186500, assetValue: 265000, interestRate: 4.29, groupId: borrowing });

// Backdate the accounts so history and mortgage interest line up with the demo period
for (const a of app.store.data.accounts) {
  a.createdAt = `${start}T09:00:00.000Z`;
  if (a.type === 'mortgage') a.lastInterestAccrual = start;
}
app.store.save('accounts');

const tx = (accountId, date, amount, payee, categoryId, description = '') => {
  if (date > now) return;
  const list = s.transactions.listFor(accountId);
  list.push(s.transactions.newTransaction({ date, amount, payee, categoryId, description }));
  s.payees.ensure(payee, { save: false });
};
const transfer = (from, to, date, amount, description = '') => {
  if (date > now) return;
  s.transactions.createTransfer({ fromAccountId: from, toAccountId: to, amount, date, description });
};

let monthStart = start.slice(0, 8) + '01';
while (monthStart <= now) {
  const { year, month } = parts(monthStart);
  const day = (d) => `${monthStart.slice(0, 8)}${String(Math.min(d, daysInMonth(year, month))).padStart(2, '0')}`;
  tx(current.id, day(25), 3125.4, 'Acme Ltd', 'sub-salary', 'Monthly salary');
  tx(joint.id, day(28), 1740.2, 'NHS Trust', 'sub-salary', 'Monthly salary');
  transfer(current.id, joint.id, day(26), 1100, 'Household pot');
  transfer(joint.id, mortgage.id, day(1), 1185, 'Mortgage payment');
  transfer(current.id, easy.id, day(27), 300, 'Monthly saving');
  transfer(current.id, isa.id, day(27), 250, 'ISA contribution');
  transfer(current.id, car.id, day(15), 289.5, 'Car finance');
  tx(joint.id, day(1), -168.0, 'South Kesteven DC', 'sub-council-tax');
  tx(joint.id, day(3), -94.0, 'Octopus Energy', 'sub-gas-electric');
  tx(joint.id, day(8), -38.6, 'Anglian Water', 'sub-water');
  tx(joint.id, day(12), -32.0, 'BT Broadband', 'sub-internet');
  tx(joint.id, day(20), -14.3, 'TV Licensing', 'sub-tv-licence');
  tx(current.id, day(5), -12.0, 'EE', 'sub-mobile');
  tx(current.id, day(9), -10.99, 'Netflix', 'sub-streaming');
  tx(current.id, day(14), -11.99, 'Spotify', 'sub-streaming');
  tx(current.id, day(2), -36.0, 'PureGym', 'sub-gym');
  tx(joint.id, day(18), -52.4, 'Admiral', 'sub-car-insurance');
  // Groceries and everyday spending
  for (let w = 0; w < 4; w++) {
    tx(joint.id, day(2 + w * 7), -between(62, 118), pick(['Tesco', 'Sainsbury\'s', 'Aldi', 'Asda']), 'sub-groceries');
    tx(card.id, day(4 + w * 7), -between(4, 9), pick(['Costa Coffee', 'Pret A Manger', 'Greggs']), 'sub-coffee');
    if (rand() > 0.35) tx(card.id, day(6 + w * 7), -between(18, 64), pick(['Deliveroo', 'Pizza Express', 'The Red Lion', 'Nando\'s']), pick(['sub-takeaway', 'sub-dining']));
    tx(current.id, day(3 + w * 7), -between(38, 62), pick(['Shell', 'BP', 'Esso']), 'sub-fuel');
  }
  tx(card.id, day(11), -between(20, 140), pick(['Amazon', 'Argos', 'John Lewis', 'IKEA']), pick(['sub-online-shopping', 'sub-household-items', 'sub-furnishings']));
  tx(card.id, day(16), -between(25, 90), pick(['Next', 'M&S', 'Uniqlo']), 'sub-clothing');
  if (rand() > 0.5) tx(card.id, day(21), -between(15, 45), pick(['Odeon', 'Vue Cinemas', 'Steam']), pick(['sub-cinema', 'sub-games']));
  if (rand() > 0.6) tx(card.id, day(19), between(8, 30), 'Amazon', 'sub-online-shopping', 'Refund');
  transfer(current.id, card.id, day(28), between(300, 520), 'Card payment');
  tx(easy.id, day(28), between(14, 19), 'Interest', 'sub-interest-income');
  monthStart = addMonths(monthStart, 1);
}
app.store.saveTransactions(...app.store.data.accounts.map(a => a.id));
app.store.save('payees');
s.mortgage.accrueAll();

// Recurring payments (the next ones are still to come)
const nextOf = (dayNum) => {
  const { year, month } = parts(now);
  const candidate = `${now.slice(0, 8)}${String(Math.min(dayNum, daysInMonth(year, month))).padStart(2, '0')}`;
  return candidate > now ? candidate : addMonths(candidate, 1, dayNum);
};
const recurring = (body) => {
  const created = s.recurring.create(body);
  const t = app.store.data.recurring.find(r => r.id === created.id);
  t.startDate = start;
  t.nextDueDate = body.next;
  app.store.save('recurring');
};
recurring({ type: 'transaction', accountId: current.id, payee: 'Acme Ltd', amount: 3125.4, categoryId: 'sub-salary', frequency: { type: 'months', interval: 1 }, startDate: start, next: nextOf(25) });
recurring({ type: 'transaction', accountId: joint.id, payee: 'NHS Trust', amount: 1740.2, categoryId: 'sub-salary', frequency: { type: 'months', interval: 1 }, startDate: start, next: nextOf(28) });
recurring({ type: 'transaction', accountId: joint.id, payee: 'South Kesteven DC', amount: -168, categoryId: 'sub-council-tax', frequency: { type: 'months', interval: 1 }, startDate: start, next: nextOf(1) });
recurring({ type: 'transaction', accountId: joint.id, payee: 'Octopus Energy', amount: -94, categoryId: 'sub-gas-electric', frequency: { type: 'months', interval: 1 }, startDate: start, next: nextOf(3) });
recurring({ type: 'transaction', accountId: current.id, payee: 'Netflix', amount: -10.99, categoryId: 'sub-streaming', frequency: { type: 'months', interval: 1 }, startDate: start, next: nextOf(9) });
recurring({ type: 'transaction', accountId: current.id, payee: 'PureGym', amount: -36, categoryId: 'sub-gym', frequency: { type: 'months', interval: 1 }, startDate: start, next: nextOf(2) });
recurring({ type: 'transfer', fromAccountId: joint.id, toAccountId: mortgage.id, amount: 1185, frequency: { type: 'months', interval: 1 }, startDate: start, next: nextOf(1) });
recurring({ type: 'transfer', fromAccountId: current.id, toAccountId: easy.id, amount: 300, frequency: { type: 'months', interval: 1 }, startDate: start, next: nextOf(27) });
recurring({ type: 'transfer', fromAccountId: current.id, toAccountId: car.id, amount: 289.5, frequency: { type: 'months', interval: 1 }, startDate: start, next: nextOf(15), endCondition: { type: 'after_occurrences', value: 36 } });
recurring({ type: 'transaction', accountId: joint.id, payee: 'Home Insurance Co', amount: -312, categoryId: 'sub-home-insurance', frequency: { type: 'years', interval: 1 }, startDate: start, next: addDays(now, 2) });

app.store.data.settings.name = 'Demo Household';
app.store.save('settings');
const total = Object.values(app.store.data.transactions).reduce((n, l) => n + l.length, 0);
return { accounts: app.store.data.accounts.length, transactions: total };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const target = process.argv[2];
  if (!target) {
    console.error('Usage: node scripts/seed-demo.js <data-folder> [months]');
    process.exit(1);
  }
  const dataDir = path.resolve(target);
  if (fs.existsSync(path.join(dataDir, 'accounts.json'))) {
    console.error(`${dataDir} already has data in it. Pick an empty folder.`);
    process.exit(1);
  }
  const result = seedDemo(dataDir, Number(process.argv[3]) || 6);
  console.log(`Seeded ${result.accounts} accounts and ${result.transactions} transactions into ${dataDir}`);
}
