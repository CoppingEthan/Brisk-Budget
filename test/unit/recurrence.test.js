import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  anchorDayFor, firstOnOrAfter, frequencyLabel, isEnded, monthlyEquivalent, nextDate, normaliseFrequency,
  occurrenceAllowed, statusOf, stepDate, upcoming
} from '../../public/js/shared/recurrence.js';

const monthly = { type: 'months', interval: 1 };
const weekly = { type: 'weeks', interval: 1 };

function template(fields = {}) {
  return {
    frequency: monthly,
    startDate: '2026-01-31',
    nextDueDate: '2026-01-31',
    endCondition: { type: 'never', value: null },
    occurrencesCompleted: 0,
    paused: false,
    ...fields
  };
}

describe('recurrence: stepping', () => {
  it('a monthly schedule on the 31st stays anchored after short months', () => {
    const t = template({ anchorDay: 31 });
    const dates = [];
    let d = t.startDate;
    for (let i = 0; i < 12; i++) { dates.push(d); d = nextDate(t, d); }
    assert.deepEqual(dates, [
      '2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30', '2026-05-31', '2026-06-30',
      '2026-07-31', '2026-08-31', '2026-09-30', '2026-10-31', '2026-11-30', '2026-12-31'
    ]);
  });

  it('falls back to the start date day when no anchorDay is stored (data from old versions)', () => {
    const t = template({ anchorDay: undefined });
    assert.equal(anchorDayFor(t), 31);
    assert.equal(nextDate(t, '2026-02-28'), '2026-03-31');
  });

  it('weekly payments do not slip across UK clock changes', () => {
    let d = '2026-03-16';
    const out = [];
    for (let i = 0; i < 4; i++) { d = stepDate(d, weekly); out.push(d); }
    assert.deepEqual(out, ['2026-03-23', '2026-03-30', '2026-04-06', '2026-04-13']);
    assert.equal(stepDate('2026-10-19', weekly), '2026-10-26');
  });

  it('steps days, fortnights, quarters and years', () => {
    assert.equal(stepDate('2026-10-12', { type: 'days', interval: 3 }), '2026-10-15');
    assert.equal(stepDate('2026-10-12', { type: 'weeks', interval: 2 }), '2026-10-26');
    assert.equal(stepDate('2026-11-30', { type: 'months', interval: 3 }, 30), '2027-02-28');
    assert.equal(stepDate('2027-02-28', { type: 'months', interval: 3 }, 30), '2027-05-30');
    assert.equal(stepDate('2024-02-29', { type: 'years', interval: 1 }, 29), '2025-02-28');
    assert.equal(stepDate('2027-02-28', { type: 'years', interval: 1 }, 29), '2028-02-29');
  });

  it('normaliseFrequency repairs junk', () => {
    assert.deepEqual(normaliseFrequency(undefined), { type: 'months', interval: 1 });
    assert.deepEqual(normaliseFrequency({ type: 'fortnights', interval: '2' }), { type: 'months', interval: 2 });
    assert.deepEqual(normaliseFrequency({ type: 'weeks', interval: 0 }), { type: 'weeks', interval: 1 });
    assert.deepEqual(normaliseFrequency({ type: 'days', interval: 2.7 }), { type: 'days', interval: 2 });
  });
});

describe('recurrence: end conditions', () => {
  it('after_occurrences counts completed plus the offset of each future occurrence', () => {
    const t = template({ endCondition: { type: 'after_occurrences', value: 3 }, occurrencesCompleted: 1 });
    assert.equal(occurrenceAllowed(t, '2026-02-28', 0), true);
    assert.equal(occurrenceAllowed(t, '2026-03-31', 1), true);
    assert.equal(occurrenceAllowed(t, '2026-04-30', 2), false);
    assert.equal(isEnded(t), false);
    assert.equal(isEnded({ ...t, occurrencesCompleted: 3 }), true);
  });

  it('on_date is checked for every occurrence, inclusive of the end date', () => {
    const t = template({ endCondition: { type: 'on_date', value: '2026-03-31' } });
    assert.equal(occurrenceAllowed(t, '2026-03-31', 5), true);
    assert.equal(occurrenceAllowed(t, '2026-04-01', 0), false);
    assert.equal(isEnded({ ...t, nextDueDate: '2026-04-30' }), true);
    assert.equal(isEnded({ ...t, nextDueDate: '2026-03-31' }), false);
  });

  it('never ends', () => {
    assert.equal(occurrenceAllowed(template(), '2999-01-01', 9999), true);
  });

  it('statusOf: ended beats paused beats active', () => {
    assert.equal(statusOf(template()), 'active');
    assert.equal(statusOf(template({ paused: true })), 'paused');
    assert.equal(statusOf(template({ paused: true, endCondition: { type: 'after_occurrences', value: 1 }, occurrencesCompleted: 1 })), 'ended');
  });
});

describe('recurrence: upcoming', () => {
  it('lists occurrences from the next due date up to and including the limit date', () => {
    const t = template({ anchorDay: 31, nextDueDate: '2026-02-28' });
    assert.deepEqual(upcoming(t, '2026-05-31').map(o => o.date), ['2026-02-28', '2026-03-31', '2026-04-30', '2026-05-31']);
    assert.deepEqual(upcoming(t, '2026-05-31').map(o => o.offset), [0, 1, 2, 3]);
  });

  it('stops at an end condition', () => {
    const byCount = template({ anchorDay: 31, endCondition: { type: 'after_occurrences', value: 4 }, occurrencesCompleted: 2 });
    assert.deepEqual(upcoming(byCount, '2027-01-01').map(o => o.date), ['2026-01-31', '2026-02-28']);
    const byDate = template({ anchorDay: 31, endCondition: { type: 'on_date', value: '2026-04-15' } });
    assert.deepEqual(upcoming(byDate, '2027-01-01').map(o => o.date), ['2026-01-31', '2026-02-28', '2026-03-31']);
  });

  it('respects the limit option and invalid next dates', () => {
    const daily = template({ frequency: { type: 'days', interval: 1 }, nextDueDate: '2026-01-01' });
    assert.equal(upcoming(daily, '2030-01-01', { limit: 5 }).length, 5);
    assert.deepEqual(upcoming(template({ nextDueDate: 'garbage' }), '2030-01-01'), []);
    assert.deepEqual(upcoming(template({ nextDueDate: '2026-12-01' }), '2026-11-30'), []);
  });
});

describe('recurrence: firstOnOrAfter', () => {
  it('returns the start date when it is already on or after the target', () => {
    assert.equal(firstOnOrAfter(template({ startDate: '2026-11-01' }), '2026-10-12'), '2026-11-01');
    assert.equal(firstOnOrAfter(template({ startDate: '2026-10-12' }), '2026-10-12'), '2026-10-12');
  });

  it('monthly schedules keep their anchor day', () => {
    assert.equal(firstOnOrAfter(template({ startDate: '2026-01-31' }), '2026-03-01'), '2026-03-31');
    assert.equal(firstOnOrAfter(template({ startDate: '2026-01-31' }), '2026-02-28'), '2026-02-28');
    assert.equal(firstOnOrAfter(template({ startDate: '2025-12-16' }), '2026-10-12'), '2026-10-16');
    assert.equal(firstOnOrAfter(template({ startDate: '2020-01-31' }), '2026-10-12'), '2026-10-31');
  });

  it('weekly and daily schedules land on the right weekday', () => {
    const t = template({ startDate: '2026-01-15', frequency: weekly }); // a Thursday
    assert.equal(firstOnOrAfter(t, '2026-10-12'), '2026-10-15');
    assert.equal(firstOnOrAfter(t, '2026-10-15'), '2026-10-15');
    assert.equal(firstOnOrAfter(template({ startDate: '2026-10-01', frequency: { type: 'days', interval: 5 } }), '2026-10-12'), '2026-10-16');
  });

  it('yearly schedules on 29 February', () => {
    const t = template({ startDate: '2024-02-29', frequency: { type: 'years', interval: 1 } });
    assert.equal(firstOnOrAfter(t, '2026-10-12'), '2027-02-28');
    assert.equal(firstOnOrAfter(t, '2027-03-01'), '2028-02-29');
  });
});

describe('recurrence: monthlyEquivalent and labels', () => {
  it('converts every frequency to a monthly figure', () => {
    assert.equal(monthlyEquivalent(-100, monthly), -100);
    assert.equal(monthlyEquivalent(-300, { type: 'months', interval: 3 }), -100);
    assert.equal(monthlyEquivalent(-1200, { type: 'years', interval: 1 }), -100);
    assert.ok(Math.abs(monthlyEquivalent(10, weekly) - 43.48125) < 1e-9);
    assert.ok(Math.abs(monthlyEquivalent(10, { type: 'weeks', interval: 2 }) - 21.740625) < 1e-9);
    assert.ok(Math.abs(monthlyEquivalent(1, { type: 'days', interval: 1 }) - 30.4375) < 1e-9);
    assert.equal(monthlyEquivalent('junk', monthly), 0);
  });

  it('labels', () => {
    assert.equal(frequencyLabel(monthly), 'Monthly');
    assert.equal(frequencyLabel({ type: 'weeks', interval: 2 }), 'Fortnightly');
    assert.equal(frequencyLabel({ type: 'months', interval: 3 }), 'Quarterly');
    assert.equal(frequencyLabel({ type: 'days', interval: 10 }), 'Every 10 days');
  });
});
