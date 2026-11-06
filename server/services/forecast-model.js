// The statistics behind the forecast's everyday money: how much usually comes in and goes out in a
// month without a schedule, and how much that varies. Plain functions on plain numbers, so they can
// be tested on their own.
//
// Chosen by testing on simulated households (monthly, weekly and four-weekly pay, freelancers,
// students living on loan instalments, retirees, savers, spending that changes) as well as real
// data: the methods were judged on how far off their 3 and 6 month forecasts were, and on whether
// the likely range really held about 80% of what happened, one-offs included.
// - A typical month is the average of up to the last 12, with only the single highest and lowest
//   month evened out (set to their neighbours). One car purchase can't dominate, yet income that
//   comes in lumps (student loan instalments, quarterly dividends, freelance invoices) still
//   counts, which a median or similar "ignore the unusual months" method gets badly wrong.
// - The likely range uses how much months really vary (big months included, since they happen),
//   and allows for the typical month itself being an estimate, so it widens faster the further
//   ahead it looks, and faster still with little history.
import { diffDays } from '../../public/js/shared/dates.js';

export const MONTH_DAYS = 30.44;
export const MAX_MONTHS = 12;
// A gap longer than this in an account's dates (an opening balance back-dated years before the real
// history, or an account left untouched for over a year) isn't history worth averaging
const MAX_GAP_DAYS = 366;
// 80% of outcomes for bell-shaped swings
const LIKELY = 1.28;

const mean = (values) => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0);

// The average with the single highest and lowest value evened out to their neighbours
export function typicalValue(values) {
  if (values.length < 3) return mean(values);
  const sorted = [...values].sort((a, b) => a - b);
  const low = sorted[1];
  const high = sorted[sorted.length - 2];
  return mean(values.map(v => Math.min(high, Math.max(low, v))));
}

// Sample standard deviation
export function spreadOf(values) {
  if (values.length < 2) return 0;
  const m = mean(values);
  return Math.sqrt(values.reduce((sum, v) => sum + (v - m) ** 2, 0) / (values.length - 1));
}

// The first day of steady history in a list of ISO dates: where the latest run without a gap of
// over a year begins. Null when there are no dates.
export function historyStart(dates) {
  if (!dates.length) return null;
  const sorted = [...new Set(dates)].sort();
  let start = sorted[sorted.length - 1];
  for (let i = sorted.length - 2; i >= 0; i--) {
    if (diffDays(sorted[i], start) > MAX_GAP_DAYS) break;
    start = sorted[i];
  }
  return start;
}

// A typical month of `flows` ([{ date, pence }], money in positive) up to `today`, from history that
// starts on `since`. Returns { monthly, spread, months }: the typical net amount a month and how
// much a month usually differs from it (both in pence), and how many months of history that's from.
// - With three months of history or more, the last (up to) twelve 30-day months are added up.
// - With less, it's the average so far, and the spread comes from comparing its three thirds.
export function typicalMonth(flows, today, since) {
  const days = since ? diffDays(since, today) : 0;
  const whole = Math.min(MAX_MONTHS, Math.floor(days / MONTH_DAYS));
  if (whole >= 3) {
    const totals = new Array(whole).fill(0);
    for (const flow of flows) {
      const age = diffDays(flow.date, today);
      if (age < 0) continue;
      const month = Math.floor(age / MONTH_DAYS);
      if (month < whole) totals[month] += flow.pence;
    }
    return { monthly: typicalValue(totals), spread: spreadOf(totals), months: whole };
  }
  if (days < 1) return { monthly: 0, spread: 0, months: 0 };
  const thirds = [0, 0, 0];
  let total = 0;
  for (const flow of flows) {
    if (flow.date < since || flow.date > today) continue;
    thirds[Math.min(2, Math.floor((diffDays(since, flow.date) / days) * 3))] += flow.pence;
    total += flow.pence;
  }
  const third = total / 3;
  // Swings grow with the square root of time, so scale each third to a month
  const variance = (thirds.reduce((sum, v) => sum + (v - third) ** 2, 0) / 3) * (MONTH_DAYS / (days / 3));
  return { monthly: (total / days) * MONTH_DAYS, spread: Math.sqrt(variance), months: days / MONTH_DAYS };
}

// How far either side of the forecast the likely range reaches `elapsed` days ahead, in pence.
// Month-to-month swings add up with the square root of time; the typical month being an estimate
// from `months` of history adds an error that grows in step with time.
export function likelyRange({ spread, months }, elapsed) {
  if (!(spread > 0) || elapsed <= 0) return 0;
  const t = elapsed / MONTH_DAYS;
  return LIKELY * spread * Math.sqrt(t + (t * t) / Math.max(1, months));
}
