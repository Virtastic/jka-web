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
export const tmpProfile = (name) =>
  (process.platform === 'win32'
    ? (process.env.TEMP || process.env.TMP || 'C:/Windows/Temp').replace(/\\/g, '/')
    : '/tmp') + '/' + name;
