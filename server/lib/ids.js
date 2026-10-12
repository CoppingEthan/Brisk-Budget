import crypto from 'node:crypto';

// Short, sortable, filename-safe ids (same style the app has always used)
export const newId = () => Date.now().toString(36) + crypto.randomBytes(6).toString('hex');

// Letters, digits, - and _ only, never a name built into every JavaScript object (like
// "constructor"), and never a name Windows keeps for devices (like "nul"), because ids are used
// as object keys and file names.
const DEVICE_NAMES = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;
export const isSafeId = (value) =>
  typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value) && !(value in Object.prototype) && !DEVICE_NAMES.test(value);
