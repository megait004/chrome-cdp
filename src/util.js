'use strict';

/**
 * Text for an error of unknown shape: its message, a string as it is, or the value as JSON.
 * @param {unknown} err
 * @returns {string}
 */
function messageOf(err) {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err) ?? 'unknown error';
  } catch {
    return 'unknown error';
  }
}

/**
 * decodeURIComponent that leaves malformed escapes alone.
 * @param {string} text
 * @returns {string}
 */
function safeDecode(text) {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

/** @param {number} ms */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = { messageOf, safeDecode, sleep };
