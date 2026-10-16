const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const os = require('node:os');
const { assertEventually } = require('./src/waiting');

const DEFAULT_PORT = 9222;
const DEFAULT_PATHS = [
  String.raw`C:\Program Files\Google\Chrome\Application\chrome.exe`,
  String.raw`C:\Program Files (x86)\Google\Chrome\Application\chrome.exe`,
  path.join(process.env.LOCALAPPDATA || '', String.raw`Google\Chrome\Application\chrome.exe`),
];

function findChromePath() {
  if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) {
    return process.env.CHROME_PATH;
  }
  for (const p of DEFAULT_PATHS) {
    if (fs.existsSync(p)) return p;
  }
  throw new Error('Chrome executable not found. Set CHROME_PATH environment variable.');
}

function checkCdpReady(port = DEFAULT_PORT) {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${port}/json/version`, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch {
          resolve(null);
        }
      });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(1000, () => {
      req.destroy();
      resolve(null);
    });
  });
}

async function waitForCdp(port = DEFAULT_PORT, timeoutMs = 15000) {
  return assertEventually(() => checkCdpReady(port), {
    every: 500,
    timeout: timeoutMs,
    describe: `Chrome CDP endpoint on port ${port}`,
  });
}

/** @param {{ port?: number }} [options] */
async function startChrome(options = {}) {
  const port = options.port || Number(process.env.CDP_PORT) || DEFAULT_PORT;
  const existing = await checkCdpReady(port);
  if (existing) {
    console.log(`[CDP] Chrome is already running with CDP on port ${port}`);
    console.log(`[CDP] Browser: ${existing.Browser}`);
    console.log(`[CDP] WebSocket: ${existing.webSocketDebuggerUrl}`);
    return existing;
  }

  const chromePath = findChromePath();
  const userDataDir =
    process.env.CHROME_USER_DATA_DIR ||
    path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'Google', 'Chrome', 'AutomationProfile');

  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--test-type',
  ];

  console.log(`[CDP] Launching Chrome: ${chromePath}`);
  console.log(`[CDP] User data dir: ${userDataDir}`);
  console.log(`[CDP] Args: ${args.join(' ')}`);

  const child = spawn(chromePath, args, {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();

  console.log(`[CDP] Spawned Chrome (PID: ${child.pid}). Waiting for CDP endpoint...`);
  const info = await waitForCdp(port);

  console.log(`[CDP] Ready!`);
  console.log(`[CDP] Browser: ${info.Browser}`);
  console.log(`[CDP] WebSocket: ${info.webSocketDebuggerUrl}`);
  return info;
}

if (require.main === module) {
  startChrome().catch((err) => {
    console.error(`[CDP] Failed:`, err.message);
    process.exitCode = 1;
  });
}

module.exports = {
  startChrome,
  findChromePath,
  checkCdpReady,
  ChromeClient: require('./src/chrome-client'),
};
