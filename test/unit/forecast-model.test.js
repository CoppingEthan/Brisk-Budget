import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { typicalValue, spreadOf, historyStart, typicalMonth, likelyRange } from '../../server/services/forecast-model.js';

describe('forecast model: a typical month', () => {
  it('evens out a single one-off instead of averaging it in', () => {
    const months = [-300, -320, -280, -310, -290, -20000];
    const plainAverage = months.reduce((a, b) => a + b) / months.length;
    const typical = typicalValue(months);
    assert.ok(plainAverage < -3500);
    assert.ok(typical < -280 && typical > -340, String(typical));
  });

  it('still counts income that comes in lumps, like loan instalments three times a year', () => {
    // Nine months of -£400, three months with a £3,200 instalment as well
    const months = [2800, -400, -400, -400, 2800, -400, -400, -400, 2800, -400, -400, -400];
    const typical = typicalValue(months);
    assert.ok(typical > 300 && typical < 500, `about £400 a month in on average, not -£400 (${typical})`);
  });

  it('is the plain average when nothing stands out, or with under three months', () => {
    assert.equal(typicalValue([-100, -110, -90, -105, -95]), -100);
    assert.equal(typicalValue([-100, -300]), -200);
    assert.equal(typicalValue([]), 0);
  });

  it('measures how much months differ', () => {
    assert.equal(spreadOf([5]), 0);
    assert.equal(spreadOf([10, 10, 10]), 0);
    assert.ok(Math.abs(spreadOf([2, 4, 4, 4, 5, 5, 7, 9]) - 2.138) < 0.001);
  });
});

describe('forecast model: history and months', () => {
  it('starts history after an opening balance back-dated years earlier', () => {
    assert.equal(historyStart([]), null);
    assert.equal(historyStart(['2025-11-10', '2000-01-01', '2025-11-03', '2026-01-04']), '2025-11-03');
    assert.equal(historyStart(['2025-01-01', '2025-09-01', '2026-03-01']), '2025-01-01', 'gaps under a year are still history');
  });

  it('adds up 30-day months back from today and finds the typical one', () => {
    const flows = [
      { date: '2026-10-10', pence: -30000 },
      { date: '2026-09-20', pence: -1000000 }, // a one-off in the latest month
      { date: '2026-09-01', pence: -32000 },
      { date: '2026-08-01', pence: -28000 },
      { date: '2026-07-01', pence: -31000 },
      { date: '2026-10-13', pence: -99999 } // after today: not history yet
    ];
    const { monthly, spread, months } = typicalMonth(flows, '2026-10-12', '2026-06-20');
    assert.equal(months, 3);
    assert.equal(monthly, -32000, 'with three months, the middle one');
    assert.ok(spread > 100000, 'the one-off still widens the likely range');
  });

  it('averages a short history over the days it covers', () => {
    const flows = [{ date: '2026-10-02', pence: -10000 }, { date: '2026-10-06', pence: -10000 }];
    const { monthly, months } = typicalMonth(flows, '2026-10-12', '2026-10-02');
    assert.ok(months > 0.3 && months < 0.4);
    assert.ok(Math.abs(monthly - (-20000 / 10) * 30.44) < 1);
    assert.deepEqual(typicalMonth([], '2026-10-12', null), { monthly: 0, spread: 0, months: 0 });
  });
});

describe('forecast model: the likely range', () => {
  it('starts at nothing, widens over time, and faster with less history', () => {
    const year = { spread: 10000, months: 12 };
    assert.equal(likelyRange(year, 0), 0);
    assert.equal(likelyRange({ spread: 0, months: 12 }, 300), 0);
    const oneMonth = likelyRange(year, 30.44);
    assert.ok(Math.abs(oneMonth - 1.28 * 10000 * Math.sqrt(1 + 1 / 12)) < 0.01);
    assert.ok(likelyRange(year, 365) > likelyRange(year, 182));
    assert.ok(likelyRange({ spread: 10000, months: 3 }, 365) > likelyRange(year, 365));
  });
});
