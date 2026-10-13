import bcrypt from 'bcryptjs';
import { createApp } from './app.js';
import { loadSavedCredentials } from './integrations/credentials.js';
import { loadConfig } from './config.js';
import { createDb, migrate, setDb } from './db/index.js';
import { startScheduler } from './domain/scheduler.js';
import { seedDemo } from './seed/demo.js';
import { DEFAULT_TAGS } from '@addendum/shared';

async function main() {
  const cfg = loadConfig();
  const db = await createDb({ databaseUrl: cfg.DATABASE_URL, pgliteDir: cfg.PGLITE_DIR });
  setDb(db);
  await migrate(db);
  // Credentials saved in Settings → API & Integrations (encrypted) are layered over the environment.
  await loadSavedCredentials();

  const staffCount = (await db.one<{ n: number }>('SELECT count(*)::int AS n FROM staff'))!.n;
  if (staffCount === 0) {
    if (cfg.DEMO_MODE) {
      console.log('[startup] Demo Mode: creating demo data…');
      await seedDemo();
    } else {
      // First production start: create the owner account from env.
      if (cfg.NODE_ENV === 'production' && cfg.OWNER_PASSWORD.length < 10) {
        throw new Error('Set OWNER_PASSWORD (10+ characters) so the first administrator login can be created.');
      }
      await db.query(`INSERT INTO staff(name, email, role, password_hash) VALUES ('Salon Owner', $1, 'admin', $2)`, [
        cfg.OWNER_EMAIL.toLowerCase(), await bcrypt.hash(cfg.OWNER_PASSWORD, 12),
      ]);
      for (const t of DEFAULT_TAGS) await db.query('INSERT INTO tags(name, is_default) VALUES ($1, true) ON CONFLICT DO NOTHING', [t]);
      console.log(`[startup] Created owner account ${cfg.OWNER_EMAIL}`);
    }
  }

  const app = createApp();
  const server = app.listen(cfg.PORT, () => {
    console.log(`Addendum Salon CRM running on http://localhost:${cfg.PORT} (${cfg.DEMO_MODE ? 'DEMO MODE' : 'live'}; database: ${db.kind})`);
  });
  startScheduler();

  // Close the database cleanly on stop/restart (Ctrl+C, `tsx watch` reloads, hosting restarts).
  // The embedded database is damaged if the process is killed while it's open.
  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    console.log(`[shutdown] ${signal}: closing the database…`);
    server.close();
    const force = setTimeout(() => process.exit(1), 8000);
    try {
      await db.close();
    } finally {
      clearTimeout(force);
      process.exit(0);
    }
  };
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.on(sig, () => void shutdown(sig));
}

main().catch((e) => {
  console.error('Failed to start:', e);
  process.exit(1);
});
