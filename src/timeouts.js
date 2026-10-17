'use strict';

// One place for every wait budget, so the trade-off between fast failure and flaky success is tuned here.
module.exports = {
  // Per-CDP-call budget for puppeteer (ChromeClient.connect).
  PROTOCOL_TIMEOUT_MS: 30000,
  // Default navigation budget for ChromeClient.goto.
  GOTO_TIMEOUT_MS: 15000,
  // CLI navigation budget (cli.js goto calls).
  CLI_NAV_TIMEOUT_MS: 30000,
  // CLI element/navigation waits (click, type, wait).
  CLI_ACTION_TIMEOUT_MS: 5000,
  // CLI wait for the first WebSocket frame after navigation.
  CLI_WS_WAIT_MS: 8000,
  // Default dwell for `traffic` in live-tab mode, in seconds.
  CLI_DEFAULT_WAIT_S: 5,
  // Default budget for waitUntil / assertEventually / waitForEvent.
  WAIT_TIMEOUT_MS: 20000,
  // Budget for Tracing.end to stream the trace back.
  TRACE_STOP_TIMEOUT_MS: 30000,
  // How long connect() and status wait for a renderer that is not answering before degrading.
  // A blocked renderer never answers, so without this every command dies on connect().
  UNRESPONSIVE_WAIT_MS: 3000,
  // How long teardown waits for the pause-exception cleanup: detaching the session removes it anyway.
  CLEANUP_WAIT_MS: 1000,
  // Budgets for Chromium to apply a minimize / restore of an occluded window.
  WINDOW_HIDE_WAIT_MS: 1000,
  WINDOW_SHOW_WAIT_MS: 2000,
};
