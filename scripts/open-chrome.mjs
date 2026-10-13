#!/usr/bin/env node
/**
 * Waits until the app is answering, then opens it in a NEW Google Chrome window.
 * Works on macOS, Windows and Linux. Falls back to the default browser if Chrome isn't found.
 *
 *   node scripts/open-chrome.mjs [url-to-open] [urls-to-wait-for…]
 *
 * Set NO_BROWSER=1 to skip opening a window (e.g. when restarting often).
 */
import { spawn } from 'node:child_process';

const url = process.argv[2] ?? 'http://localhost:5173';
const waitFor = process.argv.length > 3 ? process.argv.slice(3) : [`${url.replace(/\/$/, '')}/api/health`];
const timeoutMs = 120_000;

if (process.env.NO_BROWSER === '1') process.exit(0);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitUntilUp() {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const results = await Promise.all(waitFor.map((u) => fetch(u, { signal: AbortSignal.timeout(2000) }).then((r) => r.ok, () => false)));
    if (results.every(Boolean)) return true;
    await sleep(700);
  }
  return false;
}

function run(cmd, args) {
  return new Promise((resolve) => {
    try {
      const p = spawn(cmd, args, { stdio: 'ignore', detached: true, shell: false });
      p.on('error', () => resolve(false));
      p.on('spawn', () => {
        p.unref();
        resolve(true);
      });
    } catch {
      resolve(false);
    }
  });
}

async function openChrome() {
  const p = process.platform;
  if (p === 'darwin') {
    // -n: new instance request, so Chrome opens a fresh window even if it's already running.
    if (await run('open', ['-na', 'Google Chrome', '--args', '--new-window', url])) return 'Chrome';
    if (await run('open', [url])) return 'your default browser';
  } else if (p === 'win32') {
    // "start" finds Chrome through Windows' App Paths, even when it isn't on PATH.
    if (await run('cmd', ['/c', 'start', '""', 'chrome', '--new-window', url])) return 'Chrome';
    if (await run('cmd', ['/c', 'start', '""', url])) return 'your default browser';
  } else {
    for (const bin of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser']) {
      if (await run(bin, ['--new-window', url])) return 'Chrome';
    }
    if (await run('xdg-open', [url])) return 'your default browser';
  }
  return null;
}

const up = await waitUntilUp();
if (!up) {
  console.log(`\n⚠  The app didn't start within ${timeoutMs / 1000}s. Check the messages above, then open ${url} yourself.\n`);
  process.exit(0);
}
const opened = await openChrome();
console.log(opened
  ? `\n✓ Addendum Salon CRM is running — opened ${url} in ${opened}.\n  Demo sign-in: owner@addendumsalon.com / addendum-demo\n  Press Ctrl+C in this window to stop the app.\n`
  : `\n✓ Addendum Salon CRM is running at ${url} — open it in Chrome.\n`);
