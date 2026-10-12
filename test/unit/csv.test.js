import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildTransactions, detectDateFormat, detectDelimiter, guessMapping, parseCSV, parseDate } from '../../public/js/shared/csv.js';

describe('csv: parseCSV (RFC 4180)', () => {
  it('parses quoted fields containing delimiters', () => {
    assert.deepEqual(parseCSV('a,b,c\n"1,000",x,"y, z"'), [['a', 'b', 'c'], ['1,000', 'x', 'y, z']]);
  });

  it('turns doubled quotes into one quote', () => {
    assert.deepEqual(parseCSV('name\n"The ""Best"" Cafe"'), [['name'], ['The "Best" Cafe']]);
  });

  it('keeps newlines inside quoted fields', () => {
    assert.deepEqual(parseCSV('a,b\n"line one\nline two",2\r\n"x\r\ny",3'), [['a', 'b'], ['line one\nline two', '2'], ['x\r\ny', '3']]);
  });

  it('strips a byte order mark', () => {
    const rows = parseCSV('﻿Date,Amount\n01/10/2026,-1.00');
    assert.equal(rows[0][0], 'Date');
  });

  it('handles CRLF, a missing final newline and blank lines', () => {
    assert.deepEqual(parseCSV('a,b\r\n1,2\r\n\r\n3,4'), [['a', 'b'], ['1', '2'], ['3', '4']]);
    assert.deepEqual(parseCSV('a,b\n1,2\n'), [['a', 'b'], ['1', '2']]);
  });

  it('a stray quote inside an unquoted field is kept as text and does not swallow later rows', () => {
    // Seen in real exports, e.g. a merchant called 12" PIZZA CO. Only a quote at the start of a
    // field opens a quoted field (as Excel and most CSV readers treat it).
    const rows = parseCSV('Date,Payee,Amount\n01/10/2026,12" PIZZA CO,-5.00\n02/10/2026,TESCO,-3.00');
    assert.equal(rows.length, 3, 'all three lines are rows');
    assert.deepEqual(rows[1], ['01/10/2026', '12" PIZZA CO', '-5.00']);
    assert.deepEqual(rows[2], ['02/10/2026', 'TESCO', '-3.00']);
  });

  it('keeps empty cells', () => {
    assert.deepEqual(parseCSV('a,b,c\n1,,3\n,,x'), [['a', 'b', 'c'], ['1', '', '3'], ['', '', 'x']]);
  });

  it('detects semicolon and tab delimiters', () => {
    const semi = 'Date;Amount;Payee\n01/10/2026;-12,50;"Tesco, Express"';
    assert.equal(detectDelimiter(semi), ';');
    assert.deepEqual(parseCSV(semi), [['Date', 'Amount', 'Payee'], ['01/10/2026', '-12,50', 'Tesco, Express']]);
    const tab = 'Date\tAmount\tPayee\n01/10/2026\t-12.50\tTesco';
    assert.equal(detectDelimiter(tab), '\t');
    assert.deepEqual(parseCSV(tab)[1], ['01/10/2026', '-12.50', 'Tesco']);
    assert.equal(detectDelimiter('just one column\nvalue'), ',');
    assert.equal(detectDelimiter('a,"b;c;d;e",f\n1,"2;3;4",5'), ',');
  });
});

describe('csv: dates', () => {
  it('parses each supported format', () => {
    assert.equal(parseDate('2026-10-01', 'YYYY-MM-DD'), '2026-10-01');
    assert.equal(parseDate('2026/10/1', 'YYYY-MM-DD'), '2026-10-01');
    assert.equal(parseDate('2026-10-01T09:30:00Z', 'YYYY-MM-DD'), '2026-10-01');
    assert.equal(parseDate('01/10/2026', 'DD/MM/YYYY'), '2026-10-01');
    assert.equal(parseDate('01/10/26', 'DD/MM/YYYY'), '2026-10-01');
    assert.equal(parseDate('01/10/2026 14:22', 'DD/MM/YYYY'), '2026-10-01');
    assert.equal(parseDate('10/01/2026', 'MM/DD/YYYY'), '2026-10-01');
    assert.equal(parseDate('01-10-2026', 'DD-MM-YYYY'), '2026-10-01');
    assert.equal(parseDate('01.10.2026', 'DD.MM.YYYY'), '2026-10-01');
    assert.equal(parseDate('01 Oct 2026', 'D MMM YYYY'), '2026-10-01');
    assert.equal(parseDate('1 October 2026', 'D MMM YYYY'), '2026-10-01');
    assert.equal(parseDate('07 Sept 2026', 'D MMM YYYY'), '2026-09-07');
    assert.equal(parseDate('01-Oct-26', 'D MMM YYYY'), '2026-10-01');
  });

  it('rejects impossible dates', () => {
    assert.equal(parseDate('31/02/2026', 'DD/MM/YYYY'), null);
    assert.equal(parseDate('13/13/2026', 'DD/MM/YYYY'), null);
    assert.equal(parseDate('01 Foo 2026', 'D MMM YYYY'), null);
    assert.equal(parseDate('', 'DD/MM/YYYY'), null);
    assert.equal(parseDate('yesterday', 'YYYY-MM-DD'), null);
  });

  it('detectDateFormat picks the format that fits every value, preferring UK day-first', () => {
    assert.equal(detectDateFormat(['01/10/2026', '13/10/2026']), 'DD/MM/YYYY');
    assert.equal(detectDateFormat(['10/13/2026', '10/01/2026']), 'MM/DD/YYYY');
    assert.equal(detectDateFormat(['01/02/2026', '03/04/2026']), 'DD/MM/YYYY');
    assert.equal(detectDateFormat(['2026-10-01', '2026-10-13']), 'YYYY-MM-DD');
    assert.equal(detectDateFormat(['01 Oct 2026', '13 Oct 2026']), 'D MMM YYYY');
    assert.equal(detectDateFormat(['01-10-2026', '31-10-2026']), 'DD-MM-YYYY');
    assert.equal(detectDateFormat(['01.10.2026']), 'DD.MM.YYYY');
    assert.equal(detectDateFormat([]), 'DD/MM/YYYY');
  });
});

describe('csv: guessMapping', () => {
  it('Monzo export (Amount plus Money Out / Money In columns)', () => {
    const headers = ['Transaction ID', 'Date', 'Time', 'Type', 'Name', 'Emoji', 'Category', 'Amount', 'Currency', 'Local amount',
      'Local currency', 'Notes and #tags', 'Address', 'Receipt', 'Description', 'Category split', 'Money Out', 'Money In'];
    const { mapping, amountMode } = guessMapping(headers);
    assert.equal(amountMode, 'single');
    assert.equal(mapping.date, 1);
    assert.equal(mapping.amount, 7);
    assert.equal(mapping.payee, 4);
    assert.equal(mapping.category, 6);
    assert.equal(mapping.description, 14);
    assert.equal(mapping.notes, 11);
  });

  it('Starling export', () => {
    const headers = ['Date', 'Counter Party', 'Reference', 'Type', 'Amount (GBP)', 'Balance (GBP)', 'Spending Category', 'Notes'];
    const { mapping, amountMode } = guessMapping(headers);
    assert.equal(amountMode, 'single');
    assert.equal(mapping.date, 0);
    assert.equal(mapping.payee, 1);
    assert.equal(mapping.amount, 4);
    assert.equal(mapping.category, 6);
    assert.equal(mapping.description, 2);
    assert.equal(mapping.notes, 7);
  });

  it('Nationwide export (Paid out / Paid in split columns)', () => {
    const headers = ['Date', 'Transaction type', 'Description', 'Paid out', 'Paid in', 'Balance'];
    const { mapping, amountMode } = guessMapping(headers);
    assert.equal(amountMode, 'split');
    assert.equal(mapping.date, 0);
    assert.equal(mapping.paidOut, 3);
    assert.equal(mapping.paidIn, 4);
    assert.equal(mapping.amount, -1);
    assert.equal(mapping.payee, 2);
  });

  it('simple "Money in" / "Money out" columns', () => {
    const { mapping, amountMode } = guessMapping(['Date', 'Description', 'Money In', 'Money Out', 'Balance']);
    assert.equal(amountMode, 'split');
    assert.equal(mapping.paidIn, 2);
    assert.equal(mapping.paidOut, 3);
  });

  it('Lloyds / Halifax export (Debit Amount / Credit Amount split columns)', () => {
    // Real header row from Lloyds, Halifax and Bank of Scotland CSV downloads
    const headers = ['Transaction Date', 'Transaction Type', 'Sort Code', 'Account Number', 'Transaction Description', 'Debit Amount', 'Credit Amount', 'Balance'];
    const { mapping, amountMode } = guessMapping(headers);
    assert.equal(mapping.date, 0);
    assert.equal(mapping.payee, 4);
    assert.equal(amountMode, 'split', 'both a debit and a credit column exist, so money in would otherwise be lost');
    assert.equal(mapping.paidOut, 5);
    assert.equal(mapping.paidIn, 6);
  });

  it('a single "Amount" column with nothing else', () => {
    const { mapping, amountMode } = guessMapping(['Date', 'Description', 'Amount']);
    assert.equal(amountMode, 'single');
    assert.deepEqual([mapping.date, mapping.payee, mapping.amount], [0, 1, 2]);
  });

  it('short words like "in" only match whole headers', () => {
    const { mapping } = guessMapping(['Date', 'Payee', 'Invoice number', 'Amount']);
    assert.equal(mapping.paidIn, -1);
    assert.equal(mapping.amount, 3);
  });
});

describe('csv: buildTransactions', () => {
  it('single amount column', () => {
    const rows = [['01/10/2026', 'Tesco', '-12.50'], ['02/10/2026', 'Salary', '2,000.00']];
    const out = buildTransactions(rows, { mapping: { date: 0, payee: 1, amount: 2, description: -1, category: -1, notes: -1 }, dateFormat: 'DD/MM/YYYY' });
    assert.deepEqual(out.map(r => [r.date, r.amount, r.payee, r.error]), [
      ['2026-10-01', -12.5, 'Tesco', null],
      ['2026-10-02', 2000, 'Salary', null]
    ]);
  });

  it('split mode subtracts money out from money in', () => {
    const mapping = { date: 0, payee: 1, paidOut: 2, paidIn: 3, amount: -1, description: -1, category: -1, notes: -1 };
    const rows = [
      ['01 Oct 2026', 'Tesco', '£12.50', ''],
      ['02 Oct 2026', 'Employer', '', '£2,000.00'],
      ['03 Oct 2026', 'Nothing', '', ''],
      ['04 Oct 2026', 'Broken', 'abc', '']
    ];
    const out = buildTransactions(rows, { mapping, amountMode: 'split', dateFormat: 'D MMM YYYY' });
    assert.equal(out[0].amount, -12.5);
    assert.equal(out[1].amount, 2000);
    assert.equal(out[2].error, 'Zero amount');
    assert.equal(out[3].error, 'Amount not recognised');
  });

  it('flipSigns turns credit-card style positives into spending', () => {
    const out = buildTransactions([['2026-10-01', 'Shop', '25.00']], {
      mapping: { date: 0, payee: 1, amount: 2, description: -1, category: -1, notes: -1 }, dateFormat: 'YYYY-MM-DD', flipSigns: true
    });
    assert.equal(out[0].amount, -25);
  });

  it('reports unusable rows and falls back to the description for the payee', () => {
    const mapping = { date: 0, payee: -1, amount: 1, description: 2, category: 3, notes: 4 };
    const out = buildTransactions([
      ['bad date', '1.00', 'x', '', ''],
      ['2026-10-01', '', 'y', '', ''],
      ['2026-10-01', '0.00', 'z', '', ''],
      ['2026-10-01', '-3.00', 'CARD PAYMENT TO TESCO', 'Groceries', 'note']
    ], { mapping, dateFormat: 'YYYY-MM-DD' });
    assert.equal(out[0].error, 'Date not recognised');
    assert.equal(out[1].error, 'Amount not recognised');
    assert.equal(out[2].error, 'Zero amount');
    assert.equal(out[3].error, null);
    assert.equal(out[3].payee, 'CARD PAYMENT TO TESCO');
    assert.equal(out[3].description, 'CARD PAYMENT TO TESCO');
    assert.equal(out[3].category, 'Groceries');
    assert.equal(out[3].notes, 'note');
    assert.equal(out[3].row, 3);
  });

  it('missing cells in short rows count as blank', () => {
    const out = buildTransactions([['2026-10-01']], { mapping: { date: 0, payee: 1, amount: 2, description: -1, category: -1, notes: -1 }, dateFormat: 'YYYY-MM-DD' });
    assert.equal(out[0].payee, 'Unknown');
    assert.equal(out[0].error, 'Amount not recognised');
  });
});
