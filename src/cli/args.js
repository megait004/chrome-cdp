'use strict';
// argv handling: global options, --flag=value, and which first argument is a URL rather than a selector.

/** @param {unknown} s */
/**
 * A navigable URL: http(s), but also data: and file: for synthetic test pages.
 * @param {unknown} s @returns {boolean}
 */
function isHttpUrl(s) {
  return typeof s === 'string' && /^(https?|data|file):/i.test(s);
}

/**
 * Splits global options out of argv so they never land in a positional slot, so `eval <expr> --port 9333`
 * evaluates only the expression.
 * @param {string[]} argv
 * @returns {{ positional: string[], port: number, isJson: boolean, out: string|null, tab: number }}
 */
function parseGlobalOptions(argv) {
  const positional = [];
  let port = 9222;
  let isJson = false;
  let out = null;
  let tab = 0;

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--port') {
      port = Number(argv[++i]);
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error('Port must be an integer between 1 and 65535');
      }
    } else if (argv[i] === '--json') {
      isJson = true;
    } else if (argv[i] === '--tab') {
      tab = Number(argv[++i]);
      if (!Number.isInteger(tab) || tab < 0) throw new Error('--tab expects a tab index from 0, e.g. --tab 1 (see: node cli.js tabs)');
    } else if (argv[i] === '--out') {
      out = argv[++i] || null;
      if (!out) throw new Error('--out requires a file path: --out result.json');
    } else {
      positional.push(argv[i]);
    }
  }

  return { positional, port, isJson, out, tab };
}

// Canvas and raw input: games draw on <canvas> inside iframes, so there are no selectors.
// Use `snapshot` for each frame's URL and canvas index, then act by coordinates.
/** @param {string[]} args @param {string} name @returns {string | null} */
function takeFlag(args, name) {
  const i = args.indexOf(name);
  if (i === -1) return null;
  const [, value] = args.splice(i, 2);
  if (value === undefined) throw new Error(`${name} needs a value`);
  return value;
}

/**
 * `--flag=value` -> `--flag value`, so both spellings parse the same.
 * @param {string[]} argv @returns {string[]}
 */
function expandEquals(argv) {
  return argv.flatMap((/** @type {string} */ arg) => {
    const m = /^--([a-z0-9-]+)=([\s\S]*)$/i.exec(arg);
    return m ? [`--${m[1]}`, m[2]] : [arg];
  });
}

module.exports = { expandEquals, parseGlobalOptions, takeFlag, isHttpUrl };
