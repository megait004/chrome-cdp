#!/usr/bin/env node
'use strict';

// The entry point stays small on purpose: parse argv, record the step, look the verb up in the command table,
// hand it one Ctx. Everything else lives in src/cli/* (helpers) and src/commands/* (the commands themselves).
const fs = require('node:fs');
const path = require('node:path');
const { expandEquals, isHttpUrl, parseGlobalOptions } = require('./src/cli/args');
const { HELP_TEXT } = require('./src/cli/help');
const { redactHeaders, redactRawText, slimEntry, slimSocket } = require('./src/cli/output');
const { releaseActive, setTabIndex } = require('./src/cli/session');
const { COMMANDS } = require('./src/commands');

/** @typedef {import('./src/cli/session').Ctx} Ctx */

const ACTION_COMMANDS = new Set(['click', 'type', 'fill', 'press', 'click-at', 'drag', 'wheel', 'key', 'goto', 'resume']);

/** @param {Record<string, unknown>} step */
function recordStep(step) {
  const file = path.join(__dirname, '.tmp', 'steps.jsonl');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(step)}\n`);
}

async function main() {
  const argv = expandEquals(process.argv.slice(2));

  if (argv.includes('--version') || argv.includes('-v')) {
    console.log(require('./package.json').version);
    process.exit(0);
  }

  if (!argv[0] || argv.includes('--help') || argv.includes('-h')) {
    console.log(HELP_TEXT);
    process.exit(0);
  }

  const { positional: args, port, isJson, out: outFile, tab } = parseGlobalOptions(argv);
  setTabIndex(tab);
  const command = args[0];
  const ctx = { command, args, port, isJson, outFile, tab };
  // Every action leaves one line in .tmp/steps.jsonl, so a later reader can see which step changed what.
  if (ACTION_COMMANDS.has(command)) {
    const started = Date.now();
    // record the raw argv, so flags like --frame and --canvas are kept
    const raw = process.argv.slice(2);
    process.once('exit', (exitCode) => recordStep({
      ts: new Date(started).toISOString(),
      command,
      // typed text can be a password: keep only the selector for type and fill
      args: command === 'type' || command === 'fill' ? raw.slice(0, 2) : raw,
      exitCode,
      ms: Date.now() - started,
    }));
  }

  const handler = COMMANDS[command];
  if (!handler) {
    console.error(`Unknown command: ${command}`);
    console.log(HELP_TEXT);
    throw new Error(`Unknown command: ${command}`);
  }
  await handler(ctx);
}

module.exports = { expandEquals, redactRawText, redactHeaders, slimEntry, slimSocket, isHttpUrl };

if (require.main === module) main()
  .catch((err) => {
    console.error(`[Error] ${err.message}`);
    // A blocked renderer (for example a synchronous XMLHttpRequest) never answers CDP, so the call times out.
    if (/timed out/i.test(err.message) && /Runtime\.|protocol/i.test(err.message)) {
      console.error('[hint] The page did not answer within the protocol timeout. A synchronous call (sync XMLHttpRequest, a busy loop) blocks the page. Use `await fetch(...)` in an async expression, and do not raise the timeout to hide it. See SKILL.md "When it does not work".');
    }
    process.exitCode = 1;
  })
  .finally(async () => {
    await releaseActive();
    // A failure inside puppeteer.connect() can leave its socket open, which keeps Node alive after the error.
    // Exit only on the error path: after a successful command, exiting could truncate a large stdout write.
    if (process.exitCode) {
      // An empty write's callback runs after the pending writes are flushed; process.exit() would drop them.
      process.stderr.write('', () => process.exit(process.exitCode));
    }
  });
