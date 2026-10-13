/**
 * Command-line team & login management — the recovery route if nobody can sign in as an administrator.
 * Day-to-day, use Settings → Users & Permissions in the app.
 *
 *   npm run users -w server -- list
 *   npm run users -w server -- add --name "Emily Tran" --email emily@addendumsalon.com [--role stylist] [--password "..."]
 *   npm run users -w server -- set-password --email emily@addendumsalon.com [--password "..."]
 *   npm run users -w server -- set-role --email emily@addendumsalon.com --role receptionist
 *   npm run users -w server -- deactivate --email emily@addendumsalon.com
 *   npm run users -w server -- activate --email emily@addendumsalon.com
 *
 * In Docker:  docker compose exec app node dist/users.js list
 * Roles: admin | receptionist | stylist | assistant (default). If --password is left out, a strong one is generated and printed once.
 */
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import { loadConfig } from '../config.js';
import { createDb, migrate, setDb } from '../db/index.js';

const ROLES = ['admin', 'receptionist', 'stylist', 'assistant'];
const [cmd, ...rest] = process.argv.slice(2);
const args: Record<string, string> = {};
for (let i = 0; i < rest.length; i++) if (rest[i].startsWith('--')) args[rest[i].slice(2)] = rest[i + 1]?.startsWith('--') ? 'true' : (rest[++i] ?? 'true');

const fail = (msg: string): never => {
  console.error(`✗ ${msg}`);
  process.exit(1);
};
const genPassword = () => crypto.randomBytes(12).toString('base64url');

async function main() {
  const cfg = loadConfig();
  const db = await createDb({ databaseUrl: cfg.DATABASE_URL, pgliteDir: cfg.PGLITE_DIR });
  setDb(db);
  await migrate(db);
  const email = args.email?.trim().toLowerCase();
  const needEmail = () => email || fail('--email is required');
  const findOne = async () => (await db.one<any>('SELECT id, name, role, active FROM staff WHERE email = $1', [needEmail()])) ?? fail(`No team member with email ${email}`);

  switch (cmd) {
    case 'list': {
      const rows = await db.query<any>('SELECT name, email, role, active, password_hash IS NOT NULL AS can_login FROM staff ORDER BY role, name');
      console.table(rows.map((r) => ({ name: r.name, email: r.email ?? '—', role: r.role, active: r.active, 'can sign in': r.can_login })));
      break;
    }
    case 'add': {
      if (!args.name) fail('--name is required');
      const role = args.role ?? 'assistant'; // new accounts start with the least access
      if (!ROLES.includes(role)) fail(`--role must be one of ${ROLES.join(', ')}`);
      const password = args.password ?? genPassword();
      if (password.length < 10) fail('Password must be at least 10 characters');
      const exists = await db.one('SELECT 1 FROM staff WHERE email = $1', [needEmail()]);
      if (exists) fail(`${email} already exists — use set-password or set-role`);
      await db.query('INSERT INTO staff(name, email, role, password_hash) VALUES ($1,$2,$3,$4)', [args.name, email, role, await bcrypt.hash(password, 12)]);
      console.log(`✓ Added ${args.name} <${email}> as ${role}`);
      if (!args.password) console.log(`  Temporary password: ${password}`);
      break;
    }
    case 'set-password': {
      const u = await findOne();
      const password = args.password ?? genPassword();
      if (password.length < 10) fail('Password must be at least 10 characters');
      await db.query('UPDATE staff SET password_hash = $2, updated_at = now() WHERE id = $1', [u.id, await bcrypt.hash(password, 12)]);
      await db.query('DELETE FROM sessions WHERE staff_id = $1', [u.id]);
      console.log(`✓ Password updated for ${u.name} (signed out everywhere)`);
      if (!args.password) console.log(`  New password: ${password}`);
      break;
    }
    case 'set-role': {
      const u = await findOne();
      if (!ROLES.includes(args.role)) fail(`--role must be one of ${ROLES.join(', ')}`);
      if (u.role === 'admin' && args.role !== 'admin') {
        const admins = await db.one<any>("SELECT count(*)::int n FROM staff WHERE role = 'admin' AND active", []);
        if (admins.n <= 1) fail('Refusing to remove the last active administrator');
      }
      await db.query('UPDATE staff SET role = $2, updated_at = now() WHERE id = $1', [u.id, args.role]);
      console.log(`✓ ${u.name} is now ${args.role}`);
      break;
    }
    case 'deactivate':
    case 'activate': {
      const u = await findOne();
      const active = cmd === 'activate';
      if (!active && u.role === 'admin') {
        const owners = await db.one<any>("SELECT count(*)::int n FROM staff WHERE role = 'admin' AND active", []);
        if (owners.n <= 1) fail('Refusing to deactivate the last active administrator');
      }
      await db.query('UPDATE staff SET active = $2, updated_at = now() WHERE id = $1', [u.id, active]);
      if (!active) await db.query('DELETE FROM sessions WHERE staff_id = $1', [u.id]);
      console.log(`✓ ${u.name} ${active ? 'activated' : 'deactivated and signed out'}`);
      break;
    }
    default:
      console.log('Commands: list | add | set-password | set-role | deactivate | activate  (see the top of src/cli/users.ts)');
  }
  await db.close?.();
}

main().then(() => process.exit(0), (e) => fail(e?.message ?? String(e)));
