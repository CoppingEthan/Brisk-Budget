import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  addDays, addMonths, addYears, dateSteps, daysInMonth, diffDays, endOfMonth, fromParts, isISODate,
  maxDate, minDate, startOfMonth, today, dayOfMonth
} from '../../public/js/shared/dates.js';

describe('dates: isISODate', () => {
  it('accepts real calendar dates', () => {
    for (const d of ['2026-01-01', '2026-12-31', '2024-02-29', '2000-02-29', '1900-01-01', '9999-12-31']) {
      assert.equal(isISODate(d), true, d);
    }
  });

  it('rejects impossible or malformed dates', () => {
    for (const d of [
      '2023-02-29', '1900-02-29', '2026-04-31', '2026-13-01', '2026-00-10', '2026-01-00', '2026-1-5',
      '26-01-05', ' 2026-01-05', '2026-01-05 ', '2026-01-05T00:00:00Z', '2026/01/05', '1899-12-31', '',
      '20260105', 'abcd-ef-gh'
    ]) {
      assert.equal(isISODate(d), false, JSON.stringify(d));
    }
  });

  it('rejects non-strings', () => {
    for (const v of [null, undefined, 20260105, new Date(), {}, ['2026-01-05']]) assert.equal(isISODate(v), false);
  });
});

describe('dates: addMonths', () => {
  it('clamps to the end of shorter months', () => {
    assert.equal(addMonths('2026-01-31', 1), '2026-02-28');
    assert.equal(addMonths('2026-03-31', 1), '2026-04-30');
    assert.equal(addMonths('2026-05-31', 4), '2026-09-30');
  });

  it('handles leap years', () => {
    assert.equal(addMonths('2024-01-31', 1), '2024-02-29');
    assert.equal(addMonths('2024-02-29', 12), '2025-02-28');
    assert.equal(addMonths('2024-02-29', 48), '2028-02-29');
    assert.equal(addYears('2024-02-29', 1), '2025-02-28');
    assert.equal(addYears('2024-02-29', 4), '2028-02-29');
  });

  it('keeps an anchor day after a short month', () => {
    assert.equal(addMonths('2026-02-28', 1, 31), '2026-03-31');
    assert.equal(addMonths('2026-02-28', 2, 31), '2026-04-30');
    assert.equal(addMonths('2026-04-30', 1, 31), '2026-05-31');
    assert.equal(addMonths('2026-02-28', 1, 30), '2026-03-30');
    assert.equal(addMonths('2026-02-28', 12, 29), '2027-02-28');
    assert.equal(addMonths('2027-02-28', 12, 29), '2028-02-29');
  });

  it('steps backwards (negative months) across years', () => {
    assert.equal(addMonths('2026-03-31', -1), '2026-02-28');
    assert.equal(addMonths('2026-01-15', -1), '2025-12-15');
    assert.equal(addMonths('2026-01-15', -13), '2024-12-15');
    assert.equal(addMonths('2026-10-12', -12), '2025-10-12');
    assert.equal(addMonths('2026-10-12', -60), '2021-10-12');
    assert.equal(addMonths('2024-03-31', -1), '2024-02-29');
  });

  it('adds zero months unchanged', () => {
    assert.equal(addMonths('2026-10-12', 0), '2026-10-12');
  });
});

describe('dates: day arithmetic', () => {
  it('addDays crosses months, years and UK clock changes without slipping', () => {
    assert.equal(addDays('2026-01-31', 1), '2026-02-01');
    assert.equal(addDays('2026-12-31', 1), '2027-01-01');
    assert.equal(addDays('2026-03-28', 1), '2026-03-29');
    assert.equal(addDays('2026-03-28', 2), '2026-03-30'); // BST starts 29 March 2026
    assert.equal(addDays('2026-10-24', 2), '2026-10-26'); // GMT returns 25 October 2026
    assert.equal(addDays('2024-02-28', 1), '2024-02-29');
    assert.equal(addDays('2026-01-01', -1), '2025-12-31');
  });

  it('diffDays counts whole days in both directions', () => {
    assert.equal(diffDays('2026-03-28', '2026-03-30'), 2);
    assert.equal(diffDays('2026-10-24', '2026-10-26'), 2);
    assert.equal(diffDays('2025-12-31', '2026-01-01'), 1);
    assert.equal(diffDays('2026-01-01', '2025-12-31'), -1);
    assert.equal(diffDays('2024-01-01', '2025-01-01'), 366);
    assert.equal(diffDays('2026-10-12', '2026-10-12'), 0);
  });

  it('daysInMonth knows February in leap years', () => {
    assert.equal(daysInMonth(2024, 2), 29);
    assert.equal(daysInMonth(2026, 2), 28);
    assert.equal(daysInMonth(1900, 2), 28);
    assert.equal(daysInMonth(2000, 2), 29);
    assert.equal(daysInMonth(2026, 12), 31);
  });

  it('month boundaries, min/max and day of month', () => {
    assert.equal(startOfMonth('2026-10-12'), '2026-10-01');
    assert.equal(endOfMonth('2024-02-10'), '2024-02-29');
    assert.equal(endOfMonth('2026-04-01'), '2026-04-30');
    assert.equal(minDate('2026-01-02', '2026-01-01'), '2026-01-01');
    assert.equal(maxDate('2026-01-02', '2026-01-01'), '2026-01-02');
    assert.equal(dayOfMonth('2026-10-07'), 7);
    assert.equal(fromParts(2026, 3, 4), '2026-03-04');
  });

  it('today() uses the local calendar date of the given moment', () => {
    const d = new Date(2026, 9, 12, 23, 59, 0); // local time
    assert.equal(today(d), '2026-10-12');
    assert.equal(today(new Date(2026, 0, 1, 0, 0, 1)), '2026-01-01');
  });
});

describe('dates: dateSteps', () => {
  it('lists every day inclusive', () => {
    assert.deepEqual(dateSteps('2026-10-10', '2026-10-12'), ['2026-10-10', '2026-10-11', '2026-10-12']);
  });

  it('always ends exactly on the last date, without duplicates', () => {
    assert.deepEqual(dateSteps('2026-10-01', '2026-10-08', 3), ['2026-10-01', '2026-10-04', '2026-10-07', '2026-10-08']);
    assert.deepEqual(dateSteps('2026-10-01', '2026-10-07', 3), ['2026-10-01', '2026-10-04', '2026-10-07']);
  });

  it('handles a single day and reversed ranges', () => {
    assert.deepEqual(dateSteps('2026-10-12', '2026-10-12'), ['2026-10-12']);
    assert.deepEqual(dateSteps('2026-10-13', '2026-10-12'), []);
  });

  it('crosses the spring clock change one day at a time', () => {
    const steps = dateSteps('2026-03-27', '2026-04-01');
    assert.deepEqual(steps, ['2026-03-27', '2026-03-28', '2026-03-29', '2026-03-30', '2026-03-31', '2026-04-01']);
  });
});
