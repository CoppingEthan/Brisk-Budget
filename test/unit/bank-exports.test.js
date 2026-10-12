// The import wizard's parsing steps, run on files shaped like real UK bank exports. Each
// `importFile` call does what the wizard does before anything is sent to the server.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildTransactions, cleanPayee, decodeText, detectDateFormat, findTable, guessColumns, guessMapping,
  guessMappingFromData, parseCSVLines, unguard
} from '../../public/js/shared/csv.js';
import { parseAmount } from '../../public/js/shared/money.js';

const bytes = (text) => new TextEncoder().encode(text);

// Windows-1252 bytes for text made only of ASCII and £ (0xA3), as Excel and Nationwide write it
const cp1252 = (text) => Uint8Array.from([...text].map(ch => (ch === '£' ? 0xa3 : ch.charCodeAt(0))));

function importFile(data, { flipSigns = false } = {}) {
  const { rows: all, lines: allLines } = parseCSVLines(decodeText(data));
  const { start, hasHeaders } = findTable(all);
  const rows = all.slice(start);
  const lines = allLines.slice(start);
  const body = hasHeaders ? rows.slice(1) : rows;
  const { mapping, amountMode } = guessColumns(hasHeaders ? rows[0] : null, body);
  const dateFormat = detectDateFormat(body.map(r => r[mapping.date]));
  const parsed = buildTransactions(body, { mapping, amountMode, flipSigns, dateFormat, lines: hasHeaders ? lines.slice(1) : lines });
  return { start, hasHeaders, mapping, amountMode, dateFormat, parsed, simple: parsed.map(r => [r.date, r.amount, r.payee]) };
}

describe('bank exports: reading the file', () => {
  it('decodes UTF-8, and falls back to Windows-1252 so £ survives', () => {
    assert.equal(decodeText(bytes('Amount\n£2,450.00')), 'Amount\n£2,450.00');
    assert.equal(decodeText(cp1252('Amount\n£2,450.00')), 'Amount\n£2,450.00');
    assert.equal(decodeText(bytes('﻿Date')).replace(/^﻿/, ''), 'Date');
  });

  it('decodes UTF-16 files that start with a byte order mark', () => {
    const text = 'Date,Amount\n01/09/2026,-1.00';
    const le = new Uint8Array(2 + text.length * 2);
    le.set([0xff, 0xfe]);
    for (let i = 0; i < text.length; i++) le[2 + i * 2] = text.charCodeAt(i);
    assert.equal(decodeText(le), text);
  });

  it('numbers each row by the line it starts on, counting blank lines and line breaks inside quotes', () => {
    const { rows, lines } = parseCSVLines('\nDate,Payee\n01/09/2026,"TESCO\nLONDON"\n\n02/09/2026,ALDI');
    assert.equal(rows.length, 3);
    assert.deepEqual(lines, [2, 3, 6]);
    assert.equal(rows[1][1], 'TESCO\nLONDON');
  });
});

describe('bank exports: finding the table', () => {
  it('skips the account details above a Nationwide header', () => {
    const rows = [['Account Name:', 'FlexAccount ****12345'], ['Account Balance:', '£3,650.00'], ['Available Balance:', '£3,650.00'],
      ['Date', 'Transaction type', 'Description', 'Paid out', 'Paid in', 'Balance'], ['01 Sep 2026', 'Bank credit', 'ACME', '', '£2,450.00', '£3,650.00']];
    assert.deepEqual(findTable(rows), { start: 3, hasHeaders: true });
  });

  it('a file with no column names starts at the first row', () => {
    assert.deepEqual(findTable([['01/09/2026', 'ACME LTD SALARY', '2,450.00'], ['02/09/2026', 'OCTOPUS ENERGY', '-87.50']]), { start: 0, hasHeaders: false });
  });

  it('a title line above a file with no column names is skipped', () => {
    const rows = [['Statement'], ['01/09/2026', 'TESCO', '-1.00'], ['02/09/2026', 'ALDI', '-2.00'], ['03/09/2026', 'LIDL', '-3.00']];
    assert.deepEqual(findTable(rows), { start: 1, hasHeaders: false });
  });

  it('column names in another language still count as a header row', () => {
    assert.deepEqual(findTable([['Datum', 'Omschrijving', 'Bedrag'], ['01-09-2026', 'Albert Heijn', '-12,50']]), { start: 0, hasHeaders: true });
  });
});

describe('bank exports: matching columns', () => {
  it('Barclays "Subcategory" holds the payment type, so it is not taken as the category', () => {
    const { mapping } = guessMapping(['Number', 'Date', 'Account', 'Amount', 'Subcategory', 'Memo']);
    assert.equal(mapping.category, -1);
    assert.equal(mapping.payee, 5);
    assert.equal(guessMapping(['Date', 'Category', 'Subcategory', 'Amount']).mapping.category, 1);
  });

  it('guesses date, amount and payee from the cells of a file with no column names', () => {
    const rows = [['01/09/2026', 'ACME LTD SALARY', '2,450.00', '3,650.00'], ['02/09/2026', 'OCTOPUS ENERGY', '-87.50', '3,562.50']];
    assert.deepEqual(guessMappingFromData(rows).mapping, { date: 0, amount: 2, paidIn: -1, paidOut: -1, payee: 1, category: -1, description: -1, notes: -1 });
  });

  it('prefers a column with pence over a column of reference numbers', () => {
    const rows = [['2026-09-01', '1234567', 'TESCO', '-12.50'], ['2026-09-02', '1234568', 'ALDI', '-3.00']];
    assert.equal(guessMappingFromData(rows).mapping.amount, 3);
  });

  it('fills in what unfamiliar column names leave out', () => {
    const { mapping } = guessColumns(['Datum', 'Omschrijving', 'Bedrag'], [['01-09-2026', 'Albert Heijn', '-12,50'], ['02-09-2026', 'Salaris', '1.234,56']]);
    assert.deepEqual([mapping.date, mapping.payee, mapping.amount], [0, 1, 2]);
  });
});

describe('bank exports: cleaning cells', () => {
  it('drops the apostrophe Excel uses to keep text as text', () => {
    assert.equal(unguard("'OCTOPUS ENERGY"), 'OCTOPUS ENERGY');
    assert.equal(unguard("'AT262480023000010012345'"), 'AT262480023000010012345');
    assert.equal(unguard("O'Neill's"), "O'Neill's");
  });

  it('squashes spaces and drops the Barclays card-payment date from payees', () => {
    assert.equal(cleanPayee('TESCO STORES 2345       ON 02 SEP          BCC'), 'TESCO STORES 2345');
    assert.equal(cleanPayee('AMAZON.CO.UK ON 01 JAN BCC'), 'AMAZON.CO.UK');
    assert.equal(cleanPayee('OCTOPUS ENERGY          A-1234567'), 'OCTOPUS ENERGY A-1234567');
    assert.equal(cleanPayee('Dinner on 12 Sept'), 'Dinner on 12 Sept', 'only the bank\'s capitalised form is removed');
  });

  it('cuts long text to what the server accepts, so one long row cannot block an import', () => {
    const mapping = { date: 0, payee: 1, amount: 2, description: 3, notes: 4, category: 5 };
    const [row] = buildTransactions([['2026-09-01', 'P'.repeat(260), '-1.00', 'D'.repeat(600), 'N'.repeat(2100), 'C'.repeat(150)]], { mapping, dateFormat: 'YYYY-MM-DD' });
    assert.deepEqual([row.payee.length, row.description.length, row.notes.length, row.category.length], [200, 500, 2000, 100]);
    assert.equal(row.error, null);
  });

  it('a column that only marks credits with CR treats the unmarked amounts as spending', () => {
    const mapping = { date: 0, payee: 1, amount: 2 };
    const rows = [['01/09/2026', 'TESCO', '12.00'], ['02/09/2026', 'PAYMENT THANK YOU', '500.00 CR'], ['03/09/2026', 'REFUND', '-3.00']];
    const out = buildTransactions(rows, { mapping, dateFormat: 'DD/MM/YYYY' });
    assert.deepEqual(out.map(r => r.amount), [-12, 500, -3]);
    // With DR marks as well, each value says which way it goes
    const both = buildTransactions([['01/09/2026', 'A', '12.00 DR'], ['02/09/2026', 'B', '5.00 CR'], ['03/09/2026', 'C', '7.00']], { mapping, dateFormat: 'DD/MM/YYYY' });
    assert.deepEqual(both.map(r => r.amount), [-12, 5, 7]);
  });
});

describe('money: amounts as banks write them', () => {
  const cases = [
    ['1,234.56 GBP', 1234.56],
    ['-12.00 GBP', -12],
    ['12.00 eur', 12],
    ['−12.00', -12],
    ['−£12.00', -12],
    ['–5.00', -5],
    ['�2,450.00', 2450],
    ['£ 1,000', 1000],
    ["'12.00", 12],
    ["1'234.56", 1234.56],
    ['¥500', 500],
    ['12,-', 12]
  ];
  for (const [input, expected] of cases) {
    it(`parses ${JSON.stringify(input)} as ${expected}`, () => assert.equal(parseAmount(input), expected));
  }

  it('still rejects text that only looks a bit like money', () => {
    for (const input of ['GBP', '12 apples', 'ABC12.00', '12.00 XYZ', '−']) {
      assert.ok(Number.isNaN(parseAmount(input)), `expected NaN for ${input}`);
    }
  });
});

describe('bank exports: whole files', () => {
  it('Nationwide (Windows-1252 £, account details above the header, Paid out / Paid in)', () => {
    const file = cp1252([
      '"Account Name:","FlexAccount ****12345"',
      '"Account Balance:","£3,650.00"',
      '"Available Balance: ","£3,650.00"',
      '',
      '"Date","Transaction type","Description","Paid out","Paid in","Balance"',
      '"01 Sep 2026","Bank credit","ACME LTD SALARY","","£2,450.00","£3,650.00"',
      '"02 Sep 2026","Direct debit","OCTOPUS ENERGY","£87.50","","£3,562.50"'
    ].join('\r\n'));
    const result = importFile(file);
    assert.equal(result.start, 3);
    assert.equal(result.amountMode, 'split');
    assert.deepEqual(result.simple, [['2026-09-01', 2450, 'ACME LTD SALARY'], ['2026-09-02', -87.5, 'OCTOPUS ENERGY']]);
    assert.deepEqual(result.parsed.map(r => r.line), [6, 7]);
  });

  it('HSBC (no column names)', () => {
    const result = importFile(bytes('01/09/2026,ACME LTD SALARY,"2,450.00"\r\n02/09/2026,OCTOPUS ENERGY,-87.50\r\n'));
    assert.equal(result.hasHeaders, false);
    assert.deepEqual(result.simple, [['2026-09-01', 2450, 'ACME LTD SALARY'], ['2026-09-02', -87.5, 'OCTOPUS ENERGY']]);
    assert.deepEqual(result.parsed.map(r => r.line), [1, 2]);
  });

  it('HSBC with ISO dates picks the ISO format', () => {
    const result = importFile(bytes('2026-09-01,TESCO STORES,-12.00\n2026-09-02,ACME SALARY,1000.00\n'));
    assert.equal(result.dateFormat, 'YYYY-MM-DD');
    assert.deepEqual(result.simple, [['2026-09-01', -12, 'TESCO STORES'], ['2026-09-02', 1000, 'ACME SALARY']]);
  });

  it('NatWest (leading blank line, apostrophes, trailing comma)', () => {
    const result = importFile(bytes([
      '',
      'Date, Type, Description, Value, Balance, Account Name, Account Number',
      `01 Sep 2026,BAC,"'ACME LTD , SALARY , FP 01/09/26 1234 ",2450.00,3650.00,"'SMITH J","'600000-12345678",`,
      `02 Sep 2026,D/D,"'OCTOPUS ENERGY",-87.50,3562.50,"'SMITH J","'600000-12345678",`
    ].join('\n')));
    assert.deepEqual(result.simple, [['2026-09-01', 2450, 'ACME LTD , SALARY , FP 01/09/26 1234'], ['2026-09-02', -87.5, 'OCTOPUS ENERGY']]);
    assert.deepEqual(result.parsed.map(r => r.line), [3, 4]);
  });

  it('Barclays (Memo as payee, Subcategory ignored)', () => {
    const result = importFile(bytes([
      'Number,Date,Account,Amount,Subcategory,Memo',
      ',01/09/2026,20-00-00 12345678,2450.00,Directdep,ACME LTD SALARY',
      ',03/09/2026,20-00-00 12345678,-56.23,PAYMENT,TESCO STORES 2345       ON 02 SEP          BCC'
    ].join('\n')));
    assert.equal(result.mapping.category, -1);
    assert.deepEqual(result.simple, [['2026-09-01', 2450, 'ACME LTD SALARY'], ['2026-09-03', -56.23, 'TESCO STORES 2345']]);
  });

  it('Amex (quoted line breaks, spending shown as positive, so it is flipped)', () => {
    const file = bytes([
      'Date,Description,Amount,Extended Details,Appears On Your Statement As,Address,Town/City,Postcode,Country,Reference,Category',
      `05/09/2026,NETFLIX.COM,10.99,"NETFLIX.COM\nAMSTERDAM",NETFLIX.COM,"SINGEL 542",AMSTERDAM,1017 AZ,NETHERLANDS,'AT262480023000010012345',Entertainment-Other`,
      `04/09/2026,PAYMENT RECEIVED - THANK YOU,-500.00,,PAYMENT RECEIVED - THANK YOU,,,,,'AT262470023000010012347',`
    ].join('\n'));
    const result = importFile(file, { flipSigns: true });
    assert.deepEqual(result.simple, [['2026-09-05', -10.99, 'NETFLIX.COM'], ['2026-09-04', 500, 'PAYMENT RECEIVED - THANK YOU']]);
    assert.equal(result.parsed[0].category, 'Entertainment-Other');
    assert.deepEqual(result.parsed.map(r => r.line), [2, 4]);
  });

  it('Lloyds (Debit Amount / Credit Amount, apostrophe on the sort code)', () => {
    const result = importFile(bytes([
      'Transaction Date,Transaction Type,Sort Code,Account Number,Transaction Description,Debit Amount,Credit Amount,Balance',
      "05/09/2026,DEB,'30-00-00,12345678,NETFLIX.COM,10.99,,3495.28",
      "01/09/2026,FPI,'30-00-00,12345678,ACME LTD SALARY,,2450.00,3650.00"
    ].join('\n')));
    assert.equal(result.amountMode, 'split');
    assert.deepEqual(result.simple, [['2026-09-05', -10.99, 'NETFLIX.COM'], ['2026-09-01', 2450, 'ACME LTD SALARY']]);
  });
});
