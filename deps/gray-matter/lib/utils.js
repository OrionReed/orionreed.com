import stripBom from 'strip-bom-string'
import typeOf from 'kind-of'

export function define(obj, key, val) {
  Reflect.defineProperty(obj, key, {
    enumerable: false,
    configurable: true,
    writable: true,
    value: val
  });
};

/**
 * Returns true if `val` is an object
 */

export function isObject(val) {
  return typeOf(val) === 'object';
};

/**
 * Cast `val` to a string.
 */

export function toString(input) {
  if (typeof input !== 'string') {
    throw new TypeError('expected input to be a string');
  }
  return stripBom(input);
};

/**
 * Cast `val` to an array.
 */

export function arrayify(val) {
  return val ? (Array.isArray(val) ? val : [val]) : [];
};

/**
 * Returns true if `str` starts with `substr`.
 */

export function startsWith(str, substr, len) {
  if (typeof len !== 'number') len = substr.length;
  return str.slice(0, len) === substr;
};
