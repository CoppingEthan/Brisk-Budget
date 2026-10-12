// Small input-validation helpers. Each returns a cleaned value or throws a 400 with a message
// a person can act on.
import { badRequest } from './errors.js';
import { isISODate } from '../../public/js/shared/dates.js';
import { round2 } from '../../public/js/shared/money.js';
import { isSafeId } from './ids.js';

export const has = (obj, key) => obj !== null && typeof obj === 'object' && Object.prototype.hasOwnProperty.call(obj, key);

export function requireObject(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) throw badRequest('Expected a JSON object');
  return body;
}

export function str(value, field, { required = false, max = 500, allowEmpty = true } = {}) {
  if (value === undefined || value === null) {
    if (required) throw badRequest(`${field} is required`);
    return '';
  }
  if (typeof value !== 'string' && typeof value !== 'number') throw badRequest(`${field} must be text`);
  const text = String(value).trim();
  if (!text && (required || !allowEmpty)) throw badRequest(`${field} is required`);
  if (text.length > max) throw badRequest(`${field} is too long (max ${max} characters)`);
  return text;
}

export function num(value, field, { required = false, min = -Infinity, max = Infinity, integer = false, fallback = null } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) throw badRequest(`${field} is required`);
    return fallback;
  }
  let n;
  if (typeof value === 'number') {
    n = value;
  } else if (typeof value === 'string') {
    const text = value.trim();
    if (!text) {
      if (required) throw badRequest(`${field} is required`);
      return fallback;
    }
    // Plain decimal numbers only: no hex, no "1e5" surprises from typed text
    if (!/^[+-]?(\d+\.?\d*|\.\d+)$/.test(text)) throw badRequest(`${field} must be a number`);
    n = Number(text);
  } else {
    throw badRequest(`${field} must be a number`);
  }
  if (!Number.isFinite(n)) throw badRequest(`${field} must be a number`);
  if (integer && !Number.isInteger(n)) throw badRequest(`${field} must be a whole number`);
  if (n < min || n > max) throw badRequest(`${field} must be between ${min} and ${max}`);
  return n;
}

export function money(value, field, opts = {}) {
  const n = num(value, field, { min: -1e12, max: 1e12, ...opts });
  return n === null ? null : round2(n);
}

export function date(value, field, { required = false } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) throw badRequest(`${field} is required`);
    return null;
  }
  if (!isISODate(value)) throw badRequest(`${field} must be a date like 2026-01-31`);
  return value;
}

export function bool(value, field) {
  if (value === undefined || value === null) return false;
  if (typeof value !== 'boolean') throw badRequest(`${field} must be true or false`);
  return value;
}

export function oneOf(value, field, options, { required = false, fallback } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) throw badRequest(`${field} is required`);
    return fallback;
  }
  if (!options.includes(value)) throw badRequest(`${field} must be one of: ${options.join(', ')}`);
  return value;
}

export function id(value, field, { required = false } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) throw badRequest(`${field} is required`);
    return null;
  }
  if (!isSafeId(value)) throw badRequest(`${field} is not a valid id`);
  return value;
}

export function idList(value, field, { max = 10000 } = {}) {
  if (!Array.isArray(value)) throw badRequest(`${field} must be a list`);
  if (value.length > max) throw badRequest(`${field} has too many items`);
  return value.map((v, i) => id(v, `${field}[${i}]`, { required: true }));
}
