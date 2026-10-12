// Mortgage interest used to step month by month without remembering its day, so a mortgage
// started on the 31st drifted to the 28th after February. Each mortgage now keeps the day of
// the month it started on.
import { dayOfMonth, isISODate } from '../../../public/js/shared/dates.js';

export default {
  version: 5,
  name: 'Keep mortgage interest on its day of the month',
  up(data) {
    for (const account of data.accounts) {
      if (account.type !== 'mortgage') continue;
      if (Number.isInteger(account.interestDay) && account.interestDay >= 1 && account.interestDay <= 31) continue;
      // The schedule's own day is right unless it has visibly been squeezed to a month end
      // (a 31st that became the 28th after February); then the day it was opened is the real one.
      const last = isISODate(account.lastInterestAccrual) ? dayOfMonth(account.lastInterestAccrual) : null;
      const created = typeof account.createdAt === 'string' && isISODate(account.createdAt.slice(0, 10)) ? dayOfMonth(account.createdAt.slice(0, 10)) : null;
      if (last && created && last >= 28 && created > last) account.interestDay = created;
      else account.interestDay = last || created || null;
    }
  }
};
