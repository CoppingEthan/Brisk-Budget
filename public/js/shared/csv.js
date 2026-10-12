// CSV parsing and bank-export interpretation for the import wizard. Pure functions, so they
// run in the browser and are unit-tested on the server.
import { fromParts, isISODate } from './dates.js';
import { parseAmount, round2 } from './money.js';

// File bytes to text. UTF-8 when the bytes are valid UTF-8; otherwise Windows-1252, which is what
// Excel's "CSV (Comma delimited)" and some banks (Nationwide, for one) write, so "£" survives.
export function decodeText(bytes) {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (view[0] === 0xff && view[1] === 0xfe) return new TextDecoder('utf-16le').decode(view);
  if (view[0] === 0xfe && view[1] === 0xff) return new TextDecoder('utf-16be').decode(view);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(view);
  } catch {
    return new TextDecoder('windows-1252').decode(view);
  }
}

export function detectDelimiter(text) {
  const sample = text.split(/\r?\n/).slice(0, 10).join('\n');
  const counts = { ',': 0, ';': 0, '\t': 0 };
  let inQuotes = false;
  let atFieldStart = true;
  for (const ch of sample) {
    if (inQuotes) {
      if (ch === '"') inQuotes = false;
      continue;
    }
    if (ch === '"' && atFieldStart) { inQuotes = true; continue; }
    if (ch in counts) { counts[ch]++; atFieldStart = true; continue; }
    if (ch === '\n' || ch === '\r') { atFieldStart = true; continue; }
    if (ch !== ' ') atFieldStart = false;
  }
  const [best, count] = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  return count > 0 ? best : ',';
}

// RFC 4180 parser: quoted fields, doubled quotes, delimiters and newlines inside quotes, BOM.
// Blank rows are dropped; `lines[i]` is the line of the file that row i starts on (1-based),
// so problems can be reported against the file the person has open.
export function parseCSVLines(text, delimiter = detectDelimiter(text)) {
  const rows = [];
  const lines = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  let line = 1;
  let rowLine = 1;
  const input = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const endRow = () => {
    row.push(field.trim());
    if (row.some(cell => cell !== '')) {
      rows.push(row);
      lines.push(rowLine);
    }
    row = [];
    field = '';
  };

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (inQuotes) {
      if (ch === '"') {
        if (input[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else {
        field += ch;
        if (ch === '\n' || (ch === '\r' && input[i + 1] !== '\n')) line++;
      }
    } else if (ch === '"' && field.trim() === '') {
      // A quote only opens a quoted field at its start; elsewhere (12" PIZZA) it's just text
      inQuotes = true;
      field = '';
    } else if (ch === delimiter) {
      row.push(field.trim());
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && input[i + 1] === '\n') i++;
      endRow();
      line++;
      rowLine = line;
    } else {
      field += ch;
    }
  }
  if (field !== '' || row.length > 0) endRow();
  return { rows, lines };
}

export function parseCSV(text, delimiter) {
  return parseCSVLines(text, delimiter).rows;
}

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };

export const DATE_FORMATS = [
  { id: 'YYYY-MM-DD', label: 'YYYY-MM-DD (ISO)' },
  { id: 'DD/MM/YYYY', label: 'DD/MM/YYYY (UK)' },
  { id: 'MM/DD/YYYY', label: 'MM/DD/YYYY (US)' },
  { id: 'DD-MM-YYYY', label: 'DD-MM-YYYY' },
  { id: 'DD.MM.YYYY', label: 'DD.MM.YYYY' },
  { id: 'D MMM YYYY', label: 'DD Mon YYYY (e.g. 01 Oct 2026)' }
];

function fullYear(y) {
  const n = Number(y);
  if (y.length === 2) return n + 2000;
  return n;
}

export function parseDate(value, format) {
  if (!value) return null;
  const text = String(value).trim().split(/[ T]\d{1,2}:\d{2}/)[0].trim();
  let year, month, day;
  if (format === 'YYYY-MM-DD') {
    const m = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/.exec(text);
    if (!m) return null;
    [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  } else if (format === 'D MMM YYYY') {
    const m = /^(\d{1,2})[\s-]+([A-Za-z]{3,9})[\s-]+(\d{2,4})$/.exec(text);
    if (!m) return null;
    const monthNum = MONTHS[m[2].toLowerCase().slice(0, m[2].toLowerCase().startsWith('sept') ? 4 : 3)];
    if (!monthNum) return null;
    [year, month, day] = [fullYear(m[3]), monthNum, Number(m[1])];
  } else {
    const sep = format === 'DD-MM-YYYY' ? '-' : format === 'DD.MM.YYYY' ? '.' : '/';
    const bits = text.split(sep);
    if (bits.length !== 3 || !bits.every(b => /^\d+$/.test(b))) return null;
    if (format === 'MM/DD/YYYY') [month, day, year] = [Number(bits[0]), Number(bits[1]), fullYear(bits[2])];
    else [day, month, year] = [Number(bits[0]), Number(bits[1]), fullYear(bits[2])];
  }
  const iso = fromParts(year, month, day);
  return isISODate(iso) ? iso : null;
}

// Pick the most likely date format from a sample of values
export function detectDateFormat(values) {
  const sample = values.filter(Boolean).slice(0, 50);
  if (sample.length === 0) return 'DD/MM/YYYY';
  const scores = DATE_FORMATS.map(f => ({ id: f.id, ok: sample.filter(v => parseDate(v, f.id)).length }));
  const best = Math.max(...scores.map(s => s.ok));
  const winners = scores.filter(s => s.ok === best).map(s => s.id);
  // Prefer UK day-first when both day-first and month-first fit every value
  for (const pref of ['YYYY-MM-DD', 'DD/MM/YYYY', 'D MMM YYYY', 'DD-MM-YYYY', 'DD.MM.YYYY', 'MM/DD/YYYY']) {
    if (winners.includes(pref)) return pref;
  }
  return winners[0];
}

const HEADER_HINTS = {
  date: ['transaction date', 'date', 'posted', 'posting date', 'value date', 'completed date'],
  payee: ['payee', 'merchant', 'name', 'counter party', 'counterparty', 'recipient', 'description', 'details', 'transaction description', 'narrative', 'memo', 'reference'],
  amount: ['amount', 'value', 'transaction amount', 'net amount', 'sum'],
  paidIn: ['paid in', 'money in', 'credit', 'credits', 'deposits', 'deposit', 'in', 'receipts', 'credit amount'],
  paidOut: ['paid out', 'money out', 'debit', 'debits', 'withdrawals', 'withdrawal', 'out', 'payments', 'debit amount'],
  category: ['category', 'spending category'],
  description: ['description', 'details', 'reference', 'narrative', 'memo'],
  notes: ['notes', 'note', 'comment', 'comments']
};

// Headers that contain a hint but mean something else. Barclays' "Subcategory" holds the
// payment type (Direct Debit, PAYMENT), not a spending category.
const NOT_HINTS = {
  category: ['subcategory', 'sub-category', 'sub category']
};

// Column names seen in bank exports, used to spot the header row under any account details
const KNOWN_HEADERS = new Set([...Object.values(HEADER_HINTS).flat(), 'balance', 'type', 'transaction type']);
const headerKey = (cell) => String(cell || '').toLowerCase().trim().replace(/\s*\(.*\)$/, '');

function findHeader(headers, key, taken) {
  const hints = HEADER_HINTS[key];
  const not = NOT_HINTS[key] || [];
  const lower = headers.map(h => String(h || '').toLowerCase().trim());
  const usable = (h, idx) => !taken.has(idx) && !not.some(n => h.includes(n));
  for (const hint of hints) {
    const i = lower.findIndex((h, idx) => usable(h, idx) && h === hint);
    if (i >= 0) return i;
  }
  for (const hint of hints) {
    if (hint.length <= 3) continue; // short words like "in" only count as exact matches
    const i = lower.findIndex((h, idx) => usable(h, idx) && h.includes(hint));
    if (i >= 0) return i;
  }
  return -1;
}

// Guess which column holds what. Returns column indexes (-1 = not mapped) and the amount mode.
export function guessMapping(headers) {
  const taken = new Set();
  const take = (key) => {
    const i = findHeader(headers, key, taken);
    if (i >= 0) taken.add(i);
    return i;
  };
  const mapping = { date: take('date'), amount: -1, paidIn: -1, paidOut: -1, payee: -1, category: -1, description: -1, notes: -1 };
  const amount = findHeader(headers, 'amount', taken);
  const paidIn = findHeader(headers, 'paidIn', taken);
  const paidOut = findHeader(headers, 'paidOut', taken);
  let amountMode = 'single';
  // "Debit Amount" / "Credit Amount" also contain the word amount, so that doesn't rule out split columns
  if (paidIn >= 0 && paidOut >= 0 && paidIn !== paidOut && (amount < 0 || amount === paidIn || amount === paidOut)) {
    amountMode = 'split';
    mapping.paidIn = paidIn;
    mapping.paidOut = paidOut;
    taken.add(paidIn).add(paidOut);
  } else if (amount >= 0) {
    mapping.amount = amount;
    taken.add(amount);
  } else if (paidOut >= 0 || paidIn >= 0) {
    mapping.amount = paidOut >= 0 ? paidOut : paidIn;
    taken.add(mapping.amount);
  }
  mapping.payee = take('payee');
  mapping.category = take('category');
  mapping.description = take('description');
  mapping.notes = take('notes');
  return { mapping, amountMode };
}

// Excel and some banks put an apostrophe in front of text to keep it as text (NatWest, Lloyds),
// and Amex wraps references in a pair of them
export const unguard = (text) => String(text ?? '').trim().replace(/^'(.*)'$/s, '$1').replace(/^'/, '');

const DATE_LIKE = /\d{1,4}[/.-]\d{1,2}[/.-]\d{1,4}/;
const AMOUNT_LIKE = /^[-+(£$€]?\s?\d[\d,]*\.?\d*\)?$/;

// A row is probably a header if nothing in it looks like a date or an amount
export function looksLikeHeader(row) {
  return !!row && row.every(cell => !DATE_LIKE.test(cell) && !AMOUNT_LIKE.test(String(cell).trim()));
}

// Some exports start with a few lines about the account before the table (Nationwide:
// "Account Name:", "Account Balance:", a blank line, then the column names). Returns the row
// the table starts on and whether that row holds column names.
export function findTable(rows) {
  if (!rows.length) return { start: 0, hasHeaders: false };
  const scan = rows.slice(0, 15);
  // Two or more familiar column names (Date, Amount, Paid in…) mark the header row
  const named = scan.findIndex(r => r.filter(cell => KNOWN_HEADERS.has(headerKey(cell))).length >= 2 && looksLikeHeader(r));
  if (named >= 0) return { start: named, hasHeaders: true };
  // Otherwise skip leading lines that are much narrower than most rows
  const widths = new Map();
  for (const r of rows.slice(0, 200)) widths.set(r.length, (widths.get(r.length) || 0) + 1);
  const common = [...widths.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0][0];
  const start = Math.max(0, scan.findIndex(r => r.length * 2 > common));
  return { start, hasHeaders: looksLikeHeader(rows[start]) };
}

// For files without column names, guess from what the cells look like: the first column of
// dates, the first column of amounts after it, and the column with the most text as the payee.
export function guessMappingFromData(rows) {
  const sample = rows.slice(0, 50);
  const width = Math.max(0, ...sample.map(r => r.length));
  const mapping = { date: -1, amount: -1, paidIn: -1, paidOut: -1, payee: -1, category: -1, description: -1, notes: -1 };
  const values = (i) => sample.map(r => unguard(r[i])).filter(Boolean);
  const share = (vals, test) => (vals.length ? vals.filter(test).length / vals.length : 0);
  const isDate = (v) => DATE_FORMATS.some(f => parseDate(v, f.id));
  const isAmount = (v) => Number.isFinite(parseAmount(v));
  for (let i = 0; i < width && mapping.date < 0; i++) if (share(values(i), isDate) >= 0.8) mapping.date = i;
  // Prefer a column with pence in it, so a reference number isn't taken for the amount
  const numeric = [];
  for (let i = 0; i < width; i++) if (i !== mapping.date && share(values(i), isAmount) >= 0.8) numeric.push(i);
  mapping.amount = numeric.find(i => values(i).some(v => /[.,]\d{2}\b/.test(v))) ?? numeric[0] ?? -1;
  let longest = 0;
  for (let i = 0; i < width; i++) {
    if (i === mapping.date || numeric.includes(i)) continue;
    const vals = values(i);
    const average = vals.reduce((sum, v) => sum + v.length, 0) / (sample.length || 1);
    if (share(vals, v => /[a-z]/i.test(v)) >= 0.5 && average > longest) { longest = average; mapping.payee = i; }
  }
  return { mapping, amountMode: 'single' };
}

// Column names first (`headers` is null for a file without them); whatever they don't settle,
// such as names in another language, is guessed from the cells
export function guessColumns(headers, rows) {
  const guess = headers ? guessMapping(headers) : guessMappingFromData(rows);
  if (!headers) return guess;
  const fromData = guessMappingFromData(rows).mapping;
  const used = new Set(Object.values(guess.mapping).filter(i => i >= 0));
  const fill = (key) => {
    if (guess.mapping[key] >= 0 || fromData[key] < 0 || used.has(fromData[key])) return;
    guess.mapping[key] = fromData[key];
    used.add(fromData[key]);
  };
  fill('date');
  if (guess.amountMode === 'single') fill('amount');
  fill('payee');
  return guess;
}

// Tidy a payee from a bank file: squash runs of spaces, and drop the date Barclays adds to card
// payments ("TESCO STORES 2345 ON 02 SEP BCC"), so each shop stays one payee all month.
export function cleanPayee(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim()
    .replace(/ ON \d{1,2} (JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)[A-Z]*( [A-Z]{2,4})?$/, '');
}

// The longest text the server accepts for each field of an imported row
const LIMITS = { payee: 200, category: 100, description: 500, notes: 2000 };

// Turn parsed CSV rows into transactions. `options`: { mapping, amountMode ('single' | 'split'),
// flipSigns, dateFormat, lines }. `lines` (from parseCSVLines) gives each row's line in the
// file. Each result has the parsed fields plus `error` when unusable.
export function buildTransactions(rows, options) {
  const { mapping, amountMode = 'single', flipSigns = false, dateFormat, lines } = options;
  const cell = (row, key) => (mapping[key] >= 0 ? unguard(row[mapping[key]]) : '');
  const clip = (text, key) => (text.length > LIMITS[key] ? text.slice(0, LIMITS[key]).trim() : text);
  // Card statements that only mark credits ("500.00 CR") leave purchases unmarked: those are spending
  const amounts = amountMode === 'single' ? rows.map(r => cell(r, 'amount')) : [];
  const creditsMarked = amounts.some(v => /\d\s*CR\.?$/i.test(v)) && !amounts.some(v => /\d\s*DR\.?$/i.test(v));
  return rows.map((row, index) => {
    const date = parseDate(cell(row, 'date'), dateFormat);
    let amount;
    if (amountMode === 'split') {
      const inValue = cell(row, 'paidIn') ? parseAmount(cell(row, 'paidIn')) : 0;
      const outValue = cell(row, 'paidOut') ? parseAmount(cell(row, 'paidOut')) : 0;
      amount = Number.isNaN(inValue) || Number.isNaN(outValue)
        ? NaN
        : round2(Math.abs(inValue) - Math.abs(outValue));
    } else {
      const text = cell(row, 'amount');
      amount = parseAmount(text);
      if (creditsMarked && Number.isFinite(amount) && !/CR\.?$/i.test(text)) amount = round2(-Math.abs(amount));
    }
    if (flipSigns && Number.isFinite(amount)) amount = round2(-amount);
    const payee = cleanPayee(cell(row, 'payee'));
    const description = mapping.description !== mapping.payee ? cell(row, 'description').replace(/\s+/g, ' ') : '';
    let error = null;
    if (!date) error = 'Date not recognised';
    else if (!Number.isFinite(amount)) error = 'Amount not recognised';
    else if (amount === 0) error = 'Zero amount';
    return {
      row: index,
      line: lines?.[index],
      date,
      amount,
      payee: clip(payee || cleanPayee(description) || 'Unknown', 'payee'),
      category: clip(cell(row, 'category'), 'category'),
      description: clip(description, 'description'),
      notes: clip(cell(row, 'notes'), 'notes'),
      error
    };
  });
}
