// Money helpers shared by the server and the browser. Amounts are stored as numbers with two
// decimal places; anything that adds amounts up works in whole pence so floating point never
// leaves totals like 0.30000000000000004.

// Round half away from zero, after trimming floating point noise (so 1.005 -> 1.01, -12.345 -> -12.35)
export const toPence = (value) => {
  const n = Number(value) || 0;
  const scaled = Number((Math.abs(n) * 100).toPrecision(15));
  return (n < 0 ? -1 : 1) * Math.round(scaled) || 0;
};

export const fromPence = (pence) => pence / 100;

export const round2 = (value) => fromPence(toPence(value));

export function sum(values) {
  let pence = 0;
  for (const v of values) pence += toPence(v);
  return fromPence(pence);
}

export function sumBy(items, pick) {
  let pence = 0;
  for (const item of items) pence += toPence(pick(item));
  return fromPence(pence);
}

const CURRENCY_CODES = 'GBP|USD|EUR|CHF|AUD|CAD|NZD|JPY|SEK|NOK|DKK|PLN';
const CURRENCY_CODE = new RegExp(`^(${CURRENCY_CODES})|(${CURRENCY_CODES})$`, 'gi');

// Parse an amount typed by a person or found in a bank export.
// Handles currency symbols and codes (before or after the number), thousands separators
// (including spaces and apostrophes), European decimal commas, accounting brackets, a real
// minus sign or dash, trailing minus signs and CR/DR suffixes. Returns NaN when it can't tell.
export function parseAmount(input) {
  if (typeof input === 'number') return Number.isFinite(input) ? round2(input) : NaN;
  if (input === null || input === undefined) return NaN;
  let text = String(input).trim().replace(/[−‒–—﹣－]/g, '-');
  if (!text) return NaN;

  let negative = false;
  if (/^\(.*\)$/.test(text)) { negative = true; text = text.slice(1, -1); }
  const suffix = /\s*(CR|DR|cr|dr)\.?$/.exec(text);
  if (suffix) {
    if (suffix[1].toUpperCase() === 'DR') negative = !negative;
    text = text.slice(0, suffix.index);
  }
  // Any currency symbol, plus U+FFFD, which is what a £ turns into when a Windows-encoded file
  // is read as UTF-8
  text = text.replace(/[\p{Sc}�\s'’]/gu, '').replace(CURRENCY_CODE, '');
  // "10,-" / "10.-" is European for 10 with no pence, not minus ten
  if (/[,.]-$/.test(text)) text = text.slice(0, -2);
  else if (text.endsWith('-')) { negative = !negative; text = text.slice(0, -1); }
  if (text.startsWith('+')) text = text.slice(1);
  if (text.startsWith('-')) { negative = !negative; text = text.slice(1); }

  const hasComma = text.includes(',');
  const hasDot = text.includes('.');
  if (hasComma && hasDot) {
    // Whichever separator comes last is the decimal point
    if (text.lastIndexOf(',') > text.lastIndexOf('.')) text = text.replace(/\./g, '').replace(',', '.');
    else text = text.replace(/,/g, '');
  } else if (hasComma) {
    text = /,\d{1,2}$/.test(text) ? text.replace(/\./g, '').replace(',', '.') : text.replace(/,/g, '');
  }

  if (!/^\d*\.?\d+$/.test(text) && !/^\d+\.$/.test(text)) return NaN;
  const value = parseFloat(text);
  if (!Number.isFinite(value)) return NaN;
  return round2(negative ? -value : value);
}
