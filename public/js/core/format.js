import { state, isLiability } from './state.js';
import { diffDays, today, toLocalDate } from '../shared/dates.js';

const number = new Intl.NumberFormat('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const symbol = () => state.settings?.currencySymbol ?? '£';

// £1,234.56 / −£12.00 (a true minus sign) / +£5.00 with { signed: true }
export function money(amount, { signed = false, absolute = false } = {}) {
  const value = Number(amount) || 0;
  const body = `${symbol()}${number.format(Math.abs(value))}`;
  if (absolute || Math.abs(value) < 0.005) return body;
  if (value < 0) return `−${body}`;
  return signed ? `+${body}` : body;
}

export function compactMoney(amount) {
  const value = Number(amount) || 0;
  const abs = Math.abs(value);
  const sign = value < 0 ? '−' : '';
  if (abs >= 1e6) return `${sign}${symbol()}${(abs / 1e6).toFixed(abs >= 1e7 ? 0 : 1)}M`;
  if (abs >= 1e3) return `${sign}${symbol()}${(abs / 1e3).toFixed(abs >= 1e4 ? 0 : 1)}K`;
  return `${sign}${symbol()}${abs.toFixed(0)}`;
}

export const tone = (value) => (value > 0.004 ? 'positive' : value < -0.004 ? 'negative' : '');

// Balance as people think about it: money owed on a card/loan/mortgage shows as a positive
// amount owed (in red); in-credit shows green.
export function accountBalanceView(account, balance = account.balance) {
  if (isLiability(account)) {
    const owed = -balance;
    return { amount: Math.abs(owed), text: money(Math.abs(owed)), tone: owed > 0.004 ? 'negative' : owed < -0.004 ? 'positive' : '', label: owed < -0.004 ? 'In credit' : 'Owed' };
  }
  return { amount: balance, text: money(balance), tone: tone(balance), label: 'Balance' };
}

const formats = {
  long: { day: 'numeric', month: 'long', year: 'numeric' },
  medium: { day: 'numeric', month: 'short', year: 'numeric' },
  short: { day: 'numeric', month: 'short' },
  weekday: { weekday: 'short', day: 'numeric', month: 'short' },
  month: { month: 'short', year: '2-digit' },
  monthLong: { month: 'long', year: 'numeric' }
};

// Styles without a year ('short', 'weekday') add one when the date isn't in the current year,
// so last year's overdue items and next year's yearly payments aren't ambiguous
export function date(iso, style = 'medium') {
  if (!iso) return '';
  let options = formats[style] || formats.medium;
  if (!options.year && String(iso).slice(0, 4) !== today().slice(0, 4)) options = { ...options, year: 'numeric' };
  return toLocalDate(iso).toLocaleDateString('en-GB', options);
}

export function dayHeading(iso) {
  const days = diffDays(today(), iso);
  if (days === 0) return `Today · ${date(iso, 'short')}`;
  if (days === -1) return `Yesterday · ${date(iso, 'short')}`;
  const sameYear = iso.slice(0, 4) === today().slice(0, 4);
  return toLocalDate(iso).toLocaleDateString('en-GB', sameYear ? { weekday: 'long', day: 'numeric', month: 'long' } : formats.long);
}

export function relativeDay(iso) {
  const days = diffDays(today(), iso);
  if (days === 0) return 'today';
  if (days === 1) return 'tomorrow';
  if (days === -1) return 'yesterday';
  if (days > 1 && days < 7) return `in ${days} days`;
  if (days < -1 && days > -30) return `${-days} days ago`;
  return date(iso, 'short');
}

export function bytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export const plural = (n, one, many = `${one}s`) => `${n.toLocaleString('en-GB')} ${n === 1 ? one : many}`;

export function dateTime(isoString) {
  const d = new Date(isoString);
  return d.toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

// First character for an avatar; a whole emoji or accented letter, never half of one
const graphemes = typeof Intl.Segmenter === 'function' ? new Intl.Segmenter('en-GB', { granularity: 'grapheme' }) : null;
export function initial(text) {
  const value = String(text || '').trim();
  if (!value) return '?';
  const first = graphemes ? graphemes.segment(value)[Symbol.iterator]().next().value.segment : [...value][0];
  return first.toUpperCase();
}
