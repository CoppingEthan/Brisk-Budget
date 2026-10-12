import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseAmount, round2, sum, sumBy, toPence, fromPence } from '../../public/js/shared/money.js';

describe('money: parseAmount', () => {
  const cases = [
    ['£1,234.56', 1234.56],
    ['1,234.56', 1234.56],
    ['1234.56', 1234.56],
    ['-45.20', -45.2],
    ['+5', 5],
    ['(12.00)', -12],
    ['(£1,234.56)', -1234.56],
    ['12.50-', -12.5],
    ['1.234,56', 1234.56],
    ['€1.234.567,89', 1234567.89],
    ['12,5', 12.5],
    ['1,234', 1234],
    ['1 234,56', 1234.56],
    ['50.00 DR', -50],
    ['50.00DR', -50],
    ['50.00 dr', -50],
    ['50.00 CR', 50],
    ['50.00 CR.', 50],
    ['-£12.34', -12.34],
    ['£-12.34', -12.34],
    ['GBP 12.00', 12],
    ['$ 3.10', 3.1],
    ['.5', 0.5],
    ['12.', 12],
    ['0.00', 0],
    ['  7.25  ', 7.25]
  ];
  for (const [input, expected] of cases) {
    it(`parses ${JSON.stringify(input)} as ${expected}`, () => {
      assert.equal(parseAmount(input), expected);
    });
  }

  it('rounds numbers to pence', () => {
    assert.equal(parseAmount(12.3456), 12.35);
    assert.equal(parseAmount(-0.1 - 0.2), -0.3);
  });

  it('returns NaN for blanks and garbage', () => {
    for (const input of ['', '   ', 'CR', 'DR', 'abc', '£', '1.2.3', '12abc', '1e5', 'Infinity', 'NaN', '--', '()', null, undefined, Infinity, NaN]) {
      assert.ok(Number.isNaN(parseAmount(input)), `expected NaN for ${String(input)}`);
    }
  });
});

describe('money: pence arithmetic', () => {
  it('sum avoids floating point error', () => {
    assert.equal(sum([0.1, 0.2]), 0.3);
    assert.equal(sum(new Array(10).fill(0.1)), 1);
    assert.equal(sum([1.15, 2.3, -3.45]), 0);
    assert.equal(sum([]), 0);
    assert.equal(sum(['1.10', '2.20']), 3.3);
  });

  it('sumBy picks a field', () => {
    assert.equal(sumBy([{ a: 0.7 }, { a: 0.1 }, { a: 0.2 }], x => x.a), 1);
  });

  it('round2 / toPence / fromPence', () => {
    assert.equal(round2(1.15), 1.15);
    assert.equal(round2(2.5551), 2.56);
    assert.equal(round2(-2.5551), -2.56);
    assert.equal(toPence('12.34'), 1234);
    assert.equal(toPence(undefined), 0);
    assert.equal(toPence('junk'), 0);
    assert.equal(fromPence(1234), 12.34);
  });
});
