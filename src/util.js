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
 * The value of `work` if it settles within `ms`, else `fallback` (with a warning on stderr).
 * A renderer that is blocked by a busy loop never answers, and awaiting it would kill the command,
 * so a slow or failed step degrades the command instead of hanging it.
 * @template T
 * @param {Promise<T>} work
 * @param {number} ms
 * @param {string} what
 * @param {T} [fallback]
 * @returns {Promise<T | undefined>}
 */
function settleWithin(work, ms, what, fallback) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      // The call is still in flight: swallow the rejection the session teardown will cause.
      work.catch(() => {});
      process.stderr.write(`[warn] ${what} did not answer within ${ms}ms; continuing without it.\n`);
      resolve(fallback);
    }, ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        process.stderr.write(`[warn] ${what} failed (${messageOf(error)}); continuing without it.\n`);
        resolve(fallback);
      }
    );
  });
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

module.exports = { messageOf, safeDecode, settleWithin, sleep };
