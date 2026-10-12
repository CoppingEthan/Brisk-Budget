// Calendar-date helpers shared by the server and the browser.
// Dates are plain 'YYYY-MM-DD' strings everywhere in Brisk Budget. All arithmetic is done on
// UTC day numbers, so time zones and clock changes can never move a date by a day.

const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 86400000;

const pad = (n) => String(n).padStart(2, '0');

export function daysInMonth(year, month) {
  // month is 1-12
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export function isISODate(value) {
  if (typeof value !== 'string') return false;
  const m = ISO_RE.exec(value);
  if (!m) return false;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  return year >= 1900 && year <= 9999 && month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth(year, month);
}

export function parts(iso) {
  return { year: Number(iso.slice(0, 4)), month: Number(iso.slice(5, 7)), day: Number(iso.slice(8, 10)) };
}

export function fromParts(year, month, day) {
  return `${String(year).padStart(4, '0')}-${pad(month)}-${pad(day)}`;
}

function toDayNumber(iso) {
  const { year, month, day } = parts(iso);
  return Date.UTC(year, month - 1, day) / DAY_MS;
}

function fromDayNumber(n) {
  return new Date(n * DAY_MS).toISOString().slice(0, 10);
}

export function addDays(iso, days) {
  return fromDayNumber(toDayNumber(iso) + days);
}

// Add calendar months, clamping to the end of shorter months. `anchorDay` keeps a schedule
// on its intended day (e.g. the 31st) instead of drifting after a short month.
export function addMonths(iso, months, anchorDay) {
  const { year, month, day } = parts(iso);
  const total = year * 12 + (month - 1) + months;
  const newYear = Math.floor(total / 12);
  const newMonth = (((total % 12) + 12) % 12) + 1;
  const wanted = anchorDay || day;
  return fromParts(newYear, newMonth, Math.min(wanted, daysInMonth(newYear, newMonth)));
}

export function addYears(iso, years, anchorDay) {
  return addMonths(iso, years * 12, anchorDay);
}

// Whole days from a to b (positive when b is later)
export function diffDays(a, b) {
  return toDayNumber(b) - toDayNumber(a);
}

export function dayOfMonth(iso) {
  return Number(iso.slice(8, 10));
}

export function minDate(a, b) {
  return a <= b ? a : b;
}

export function maxDate(a, b) {
  return a >= b ? a : b;
}

// Today's date in the local time zone of whoever is asking (server or browser)
export function today(now = new Date()) {
  return fromParts(now.getFullYear(), now.getMonth() + 1, now.getDate());
}

// Local-midnight Date object for display formatting
export function toLocalDate(iso) {
  const { year, month, day } = parts(iso);
  return new Date(year, month - 1, day);
}

export function startOfMonth(iso) {
  return iso.slice(0, 8) + '01';
}

export function endOfMonth(iso) {
  const { year, month } = parts(iso);
  return fromParts(year, month, daysInMonth(year, month));
}

// Inclusive list of dates from `from` to `to`, stepping `step` days, always ending exactly on `to`
export function dateSteps(from, to, step = 1) {
  const out = [];
  const total = diffDays(from, to);
  if (total < 0) return out;
  for (let i = 0; i < total; i += step) out.push(addDays(from, i));
  out.push(to);
  return out;
}
