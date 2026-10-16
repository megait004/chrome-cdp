'use strict';

/**
 * Substring or RegExp match. Anything that is not a string never matches.
 * @param {unknown} value
 * @param {string | RegExp} query
 * @returns {boolean}
 */
function matchesQuery(value, query) {
  if (typeof value !== 'string') return false;
  if (!(query instanceof RegExp)) return value.includes(query);
  query.lastIndex = 0;
  return query.test(value);
}

module.exports = matchesQuery;
