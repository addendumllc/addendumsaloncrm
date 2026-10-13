// Production start: `npm start`. Builds the app first if it hasn't been built (e.g. a host whose build step
// was only `npm install`), then runs the server and passes stop signals through so it can close the database.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const built = fs.existsSync(path.join(root, 'server/dist/index.js')) && fs.existsSync(path.join(root, 'web/dist/index.html'));

if (!built) {
  console.log('[start] No build found: building the app first…');
  // Building needs the dev tools (Vite, tsup), which `npm install` skips when NODE_ENV=production.
  const steps = fs.existsSync(path.join(root, 'node_modules/.bin/vite')) ? [] : [[npm, ['install', '--include=dev']]];
  for (const [cmd, args] of [...steps, [npm, ['run', 'build']]]) {
    const r = spawnSync(cmd, args, { cwd: root, stdio: 'inherit' });
    if (r.status !== 0) {
      console.error(`[start] "${cmd} ${args.join(' ')}" failed. Use the build command: npm ci --include=dev && npm run build`);
      process.exit(r.status ?? 1);
    }
  }
}

const server = spawn(process.execPath, ['--env-file-if-exists=../.env', 'dist/index.js'], { cwd: path.join(root, 'server'), stdio: 'inherit' });
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => server.kill(sig));
server.on('exit', (code, signal) => process.exit(code ?? (signal ? 0 : 1)));
