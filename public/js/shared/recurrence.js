// Recurring-payment schedule maths, shared by the server (approving, auto-logging, forecasts)
// and the browser (upcoming lists, summaries) so both always agree.
import { addDays, addMonths, dayOfMonth, diffDays, isISODate } from './dates.js';

export const FREQUENCY_TYPES = ['days', 'weeks', 'months', 'years'];

export function normaliseFrequency(frequency) {
  const type = FREQUENCY_TYPES.includes(frequency?.type) ? frequency.type : 'months';
  const interval = Math.max(1, Math.floor(Number(frequency?.interval) || 1));
  return { type, interval };
}

// Day of the month a monthly/yearly schedule sticks to (so the 31st stays the 31st)
export function anchorDayFor(template) {
  if (template.anchorDay) return template.anchorDay;
  const base = isISODate(template.startDate) ? template.startDate : template.nextDueDate;
  return isISODate(base) ? dayOfMonth(base) : undefined;
}

export function stepDate(iso, frequency, anchorDay) {
  const { type, interval } = normaliseFrequency(frequency);
  switch (type) {
    case 'days': return addDays(iso, interval);
    case 'weeks': return addDays(iso, interval * 7);
    case 'years': return addMonths(iso, interval * 12, anchorDay);
    default: return addMonths(iso, interval, anchorDay);
  }
}

export function nextDate(template, fromIso) {
  return stepDate(fromIso, template.frequency, anchorDayFor(template));
}

// Is the occurrence on `dueDate` (the `offset`-th one after the next due) still within the
// schedule's end condition?
export function occurrenceAllowed(template, dueDate, offset = 0) {
  const end = template.endCondition;
  if (!end || end.type === 'never') return true;
  if (end.type === 'after_occurrences') {
    return (Number(template.occurrencesCompleted) || 0) + offset < (Number(end.value) || 0);
  }
  if (end.type === 'on_date') return !isISODate(end.value) || dueDate <= end.value;
  return true;
}

export function isEnded(template) {
  return !occurrenceAllowed(template, template.nextDueDate, 0);
}

export function statusOf(template) {
  if (isEnded(template)) return 'ended';
  if (template.paused) return 'paused';
  return 'active';
}

// Occurrences from the next due date up to and including `until`. With `countFrom`, overdue
// ones (dated before it) don't count towards `limit`, so a long-overdue payment can't cut a
// forecast short.
export function upcoming(template, until, { limit = 2000, countFrom } = {}) {
  const out = [];
  if (!isISODate(template.nextDueDate)) return out;
  let date = template.nextDueDate;
  let offset = 0;
  let counted = 0;
  while (date <= until && counted < limit && occurrenceAllowed(template, date, offset)) {
    out.push({ date, offset });
    if (!countFrom || date >= countFrom) counted++;
    date = nextDate(template, date);
    offset++;
  }
  return out;
}

// First date of the schedule (which starts on startDate) that falls on or after `target`
export function firstOnOrAfter(template, target) {
  const start = template.startDate;
  if (start >= target) return start;
  const { type, interval } = normaliseFrequency(template.frequency);
  if (type === 'days' || type === 'weeks') {
    const step = type === 'days' ? interval : interval * 7;
    const steps = Math.ceil(diffDays(start, target) / step);
    return addDays(start, steps * step);
  }
  const anchor = anchorDayFor(template);
  const monthsPerStep = type === 'years' ? interval * 12 : interval;
  let k = Math.max(0, Math.floor(diffDays(start, target) / (31 * monthsPerStep)));
  let date = addMonths(start, k * monthsPerStep, anchor);
  while (date < target) {
    k++;
    date = addMonths(start, k * monthsPerStep, anchor);
  }
  return date;
}

// Average monthly value of a recurring amount
export function monthlyEquivalent(amount, frequency) {
  const { type, interval } = normaliseFrequency(frequency);
  const value = Number(amount) || 0;
  switch (type) {
    case 'days': return (value * 365.25) / 12 / interval;
    case 'weeks': return (value * 52.1775) / 12 / interval;
    case 'years': return value / 12 / interval;
    default: return value / interval;
  }
}

export function frequencyLabel(frequency) {
  const { type, interval } = normaliseFrequency(frequency);
  if (interval === 1) return { days: 'Daily', weeks: 'Weekly', months: 'Monthly', years: 'Yearly' }[type];
  if (type === 'weeks' && interval === 2) return 'Fortnightly';
  if (type === 'weeks' && interval === 4) return 'Every 4 weeks';
  if (type === 'months' && interval === 3) return 'Quarterly';
  if (type === 'months' && interval === 6) return 'Every 6 months';
  return `Every ${interval} ${type}`;
}
