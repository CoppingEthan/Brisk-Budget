import { today as localToday } from '../../public/js/shared/dates.js';

// The one place the server asks what time it is, so tests (and BRISK_NOW) can pin the date.
let fixed = process.env.BRISK_NOW ? Date.parse(process.env.BRISK_NOW) : null;

export const clock = {
  now() {
    return fixed !== null && !Number.isNaN(fixed) ? new Date(fixed) : new Date();
  },
  today() {
    return localToday(clock.now());
  },
  set(value) {
    fixed = value === null || value === undefined ? null : new Date(value).getTime();
  }
};
