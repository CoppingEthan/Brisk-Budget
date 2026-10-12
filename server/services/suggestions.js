// Spot payments that look regular in the transaction history and offer to track them.
import { requireObject, str } from '../lib/validate.js';
import { daysInMonth, diffDays, parts } from '../../public/js/shared/dates.js';
import { stepDate } from '../../public/js/shared/recurrence.js';
import { round2 } from '../../public/js/shared/money.js';
import { TRANSFER_CATEGORY_ID } from '../store/defaults.js';

const normalisePayee = (name) => (name || '').toLowerCase().trim().replace(/\s+/g, ' ');

const median = (numbers) => {
  if (numbers.length === 0) return 0;
  const sorted = [...numbers].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

const mostCommon = (values) => {
  const counts = new Map();
  let best = values[0];
  let bestCount = 0;
  for (const v of values) {
    const c = (counts.get(v) || 0) + 1;
    counts.set(v, c);
    if (c > bestCount) { bestCount = c; best = v; }
  }
  return best;
};

// Known cadences with day-gap tolerance windows (kept non-overlapping)
const CADENCES = [
  { frequency: { type: 'weeks', interval: 1 }, min: 5, max: 10 },
  { frequency: { type: 'weeks', interval: 2 }, min: 11, max: 18 },
  { frequency: { type: 'weeks', interval: 4 }, min: 26, max: 29, exact: 28 },
  { frequency: { type: 'months', interval: 1 }, min: 25, max: 38 },
  { frequency: { type: 'months', interval: 3 }, min: 80, max: 104 },
  { frequency: { type: 'months', interval: 6 }, min: 165, max: 200 },
  { frequency: { type: 'years', interval: 1 }, min: 330, max: 400 }
];

const MIN_AMOUNT = 1; // ignore pennies of savings interest

// A 4-weekly payment that missed a cycle has a gap of 56 days: still on its rhythm
const onRhythm = (gap, days) => {
  const k = Math.round(gap / days);
  return k >= 1 && k <= 3 && Math.abs(gap - k * days) <= 1;
};

// Day of the month, with the last day of any month counted as the 31st
const monthDay = (iso) => {
  const { year, month, day } = parts(iso);
  return day === daysInMonth(year, month) ? 31 : day;
};

// Monthly-or-longer payments land on about the same day each time, or are for about the same
// amount. Random shopping trips that happen to be a month apart on average are neither.
function looksScheduled(group, days) {
  const share = (n) => n / group.length >= 0.6;
  const usual = mostCommon(days);
  const nearDay = days.filter(d => Math.min(Math.abs(d - usual), 31 - Math.abs(d - usual)) <= 3).length;
  const typical = Math.abs(median(group.map(t => t.amount)));
  const nearAmount = group.filter(t => Math.abs(Math.abs(t.amount) - typical) <= typical * 0.05).length;
  return share(nearDay) || share(nearAmount);
}

export function createSuggestions(app) {
  const { store, clock } = app;
  const svc = () => app.services;

  function list() {
    const templated = new Set();
    for (const t of store.data.recurring) {
      if (t.active !== false && t.type === 'transaction' && t.accountId && t.payee) templated.add(`${t.accountId}|${normalisePayee(t.payee)}`);
    }
    const dismissed = new Set(store.data.dismissed);
    const today = clock.today();
    const suggestions = [];

    for (const account of store.data.accounts) {
      if (account.active === false) continue;
      const groups = new Map();
      for (const tx of store.data.transactions[account.id] || []) {
        if (tx.transferId || tx.autoInterest || tx.recurringId || tx.categoryId === TRANSFER_CATEGORY_ID) continue;
        const key = normalisePayee(tx.payee);
        if (!key) continue;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(tx);
      }

      for (const [payeeKey, group] of groups) {
        if (group.length < 3) continue;
        const signature = `${account.id}|${payeeKey}`;
        if (templated.has(signature) || dismissed.has(signature)) continue;
        // Payees mixing money in and out are usually refunds, not schedules
        if (group.some(t => t.amount > 0) && group.some(t => t.amount < 0)) continue;

        const sorted = [...group].sort((a, b) => a.date.localeCompare(b.date));
        const gaps = [];
        for (let i = 1; i < sorted.length; i++) {
          const gap = diffDays(sorted[i - 1].date, sorted[i].date);
          if (gap > 0) gaps.push(gap);
        }
        if (gaps.length < 2) continue;

        const medGap = median(gaps);
        // 4-weekly needs gaps that keep to a 28-day rhythm, otherwise it's really monthly
        const cadence = CADENCES.find(c => medGap >= c.min && medGap <= c.max && (!c.exact || gaps.every(g => onRhythm(g, c.exact))))
          || CADENCES.find(c => !c.exact && medGap >= c.min && medGap <= c.max);
        if (!cadence) continue;
        const fitting = gaps.filter(g => (cadence.exact ? onRhythm(g, cadence.exact) : g >= cadence.min && g <= cadence.max)).length;
        if (fitting / gaps.length < 0.6) continue;
        const monthly = cadence.frequency.type === 'months' || cadence.frequency.type === 'years';
        const days = sorted.map(t => monthDay(t.date));
        if (monthly && !looksScheduled(sorted, days)) continue;
        // Keep the day it's usually paid, so "the 31st" or "the last day" doesn't slip to the 30th
        const anchorDay = monthly ? mostCommon(days) : null;

        const amount = round2(median(group.map(t => t.amount)));
        if (Math.abs(amount) < MIN_AMOUNT) continue;

        // The last payment shouldn't be long overdue, or the schedule has probably stopped
        const last = sorted[sorted.length - 1].date;
        let nextDue = stepDate(last, cadence.frequency, anchorDay ?? undefined);
        if (diffDays(nextDue, today) > Math.max(45, cadence.max * 1.5)) continue;
        let guard = 0;
        while (nextDue < today && guard++ < 200) nextDue = stepDate(nextDue, cadence.frequency, anchorDay ?? undefined);

        const categoryId = mostCommon(group.map(t => t.categoryId));
        suggestions.push({
          signature,
          accountId: account.id,
          accountName: account.name,
          payee: mostCommon(group.map(t => t.payee)),
          amount,
          categoryId,
          category: svc().categories.info(categoryId).name,
          frequency: cadence.frequency,
          anchorDay,
          nextDueDate: nextDue,
          lastDate: last,
          occurrences: group.length
        });
      }
    }
    return suggestions.sort((a, b) => b.occurrences - a.occurrences);
  }

  function dismiss(body) {
    const signature = str(requireObject(body).signature, 'signature', { required: true, max: 300 });
    if (!store.data.dismissed.includes(signature)) {
      store.data.dismissed.push(signature);
      store.save('dismissed');
    }
    return { success: true };
  }

  function resetDismissed() {
    store.data.dismissed = [];
    store.save('dismissed');
    return { success: true };
  }

  return { list, dismiss, resetDismissed };
}
