// Where is Chrome? Every CDP harness in this directory used to hardcode the macOS bundle
// path, which made all 30 of them unrunnable anywhere else — the port builds fine on Linux
// and on Windows/Git Bash, but its own test suite did not. Resolve per-platform instead,
// first hit wins, with $CHROME as the always-available override.
//
// Chromium and Edge are accepted as fallbacks on purpose: these probes drive WebGL1 through
// plain CDP, so any Blink build does the job, and CI images rarely carry branded Chrome.
import fs from 'node:fs';

const CANDIDATES = {
  darwin: [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
  ],
  win32: [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    (process.env.LOCALAPPDATA || '') + '/Google/Chrome/Application/chrome.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  ],
  linux: [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/snap/bin/chromium',
  ],
};

function resolve() {
  if (process.env.CHROME) return process.env.CHROME;
  for (const p of CANDIDATES[process.platform] || CANDIDATES.linux) {
    try { if (p && fs.existsSync(p)) return p; } catch {}
  }
  // Let the caller fail on spawn with a path in the message rather than on a bare undefined.
  return (CANDIDATES[process.platform] || CANDIDATES.linux)[0];
}

export const CHROME = resolve();

// Harnesses scribble a throwaway profile per run. '/tmp/...' is not a writable absolute path
// on Windows (node reads it as <current drive>:\tmp), so route through the real temp dir.
const _profiles = new Set();
export const tmpProfile = (name) => {
  const dir = (process.platform === 'win32'
    ? (process.env.TEMP || process.env.TMP || 'C:/Windows/Temp').replace(/\\/g, '/')
    : '/tmp') + '/' + name;
  // Clean up after ourselves. These directories are tens of MB each and nothing ever removed
  // them: 529 had piled up before one stale SingletonLock started making every later Chrome
  // exit instantly, and a later sweep found 20.4 GB of them. Only reap names carrying our pid,
  // so a concurrent harness sharing a fixed name is never touched.
  if (name.includes(String(process.pid))) _profiles.add(dir);
  return dir;
};
const _reap = () => { for (const d of _profiles) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} } };
process.on('exit', _reap);
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { _reap(); process.exit(130); });

// Fail loudly when Chrome dies instead of waiting on a socket that will never answer.
//
// Every harness polls /json until a page appears, then blocks on CDP. If Chrome exits early --
// a crash, a stale profile lock, a bad flag -- those awaits never settle and the run hangs until
// something outside kills it, which is indistinguishable from a slow run: two sweeps in one
// session sat wedged for 33 minutes apiece looking like progress. Call right after spawning.
export function guardChrome(child, label = 'chrome') {
  child.on('exit', (code, signal) => {
    if (globalThis.__idt3_done) return;   // set before your own clean shutdown
    console.error(`FAIL: ${label} exited early (code=${code} signal=${signal}) -- ` +
                  `the harness would otherwise hang forever waiting for CDP.`);
    process.exit(3);
  });
  return child;
}
