// Earlier versions stepped recurring dates in local time, so a payment on the 29th-31st
// slipped to the start of the next month after February, and UK clock changes knocked dates
// back a day each spring. Each schedule now remembers its day of the month, and next-due
// dates that had already slipped are pulled back onto the schedule when the slip is clear-cut.
import { dayOfMonth, diffDays, isISODate } from '../../../public/js/shared/dates.js';
import { nextDate, normaliseFrequency } from '../../../public/js/shared/recurrence.js';

function stepLengthDays(frequency) {
  const { type, interval } = normaliseFrequency(frequency);
  return { days: 1, weeks: 7, months: 30, years: 365 }[type] * interval;
}

export function repairNextDueDate(template) {
  if (!isISODate(template.startDate) || !isISODate(template.nextDueDate)) return null;
  if (template.nextDueDate <= template.startDate) return null;
  const length = stepLengthDays(template.frequency);
  if (length < 7) return null; // too frequent to tell a slip from the real schedule
  const tolerance = Math.min(4, Math.floor((length - 1) / 2));

  let previous = template.startDate;
  let current = template.startDate;
  let guard = 0;
  while (current < template.nextDueDate && guard++ < 20000) {
    previous = current;
    current = nextDate(template, current);
  }
  const before = diffDays(previous, template.nextDueDate);
  const after = diffDays(template.nextDueDate, current);
  const nearest = before <= after ? previous : current;
  const distance = Math.min(before, after);
  if (distance === 0 || distance > tolerance) return null;
  return nearest;
}

export default {
  version: 4,
  name: 'Fix recurring dates that drifted',
  up(data, ctx) {
    for (const r of data.recurring) {
      r.autoLog = r.autoLog === true;
      // A schedule that already has its day of the month is in the current format (this is a
      // re-run after a lost meta.json): its next date may have been moved on purpose
      if (Object.hasOwn(r, 'anchorDay')) continue;
      const { type } = normaliseFrequency(r.frequency);
      r.anchorDay = type === 'months' || type === 'years' ? dayOfMonth(r.startDate) : null;
      const repaired = repairNextDueDate(r);
      if (repaired) {
        ctx.note(`Moved "${r.payee || 'transfer'}" next due date from ${r.nextDueDate} to ${repaired}`);
        r.nextDueDate = repaired;
      }
    }
  }
};
