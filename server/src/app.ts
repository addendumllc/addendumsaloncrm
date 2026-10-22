import cookieParser from 'cookie-parser';
import express, { type NextFunction, type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadUser, requireAuth, apiGate } from './auth/session.js';
import { config } from './config.js';
import { AppError, IntegrationError } from './lib/errors.js';
import { appointmentsRouter } from './routes/appointments.js';
import { authRouter } from './routes/auth.js';
import { clientsRouter, notesRouter } from './routes/clients.js';
import { demoRouter } from './routes/demo.js';
import { integrationsRouter } from './routes/integrations.js';
import { adminRouter } from './routes/admin.js';
import { usersRouter } from './routes/users.js';
import { timeclockRouter } from './routes/timeclock.js';
import { commissionRouter } from './routes/commission.js';
import { rebookingRouter } from './routes/rebooking.js';
import { inventorySyncRouter } from './routes/inventorySync.js';
import { hairRouter } from './routes/hair.js';
import { inventoryRouter } from './routes/inventory.js';
import { leadsRouter } from './routes/leads.js';
import { messagesRouter } from './routes/messages.js';
import { miscRouter } from './routes/misc.js';
import { serveFont, serveLoginImage, serveLogo, settingsRouter } from './routes/settings.js';
import { tasksRouter } from './routes/tasks.js';
import { accessRouter } from './routes/access.js';
import { announcementsRouter } from './routes/announcements.js';
import { projectionsRouter } from './routes/projections.js';
import { networkGate } from './auth/access.js';
import { webhooksRouter } from './routes/webhooks.js';

export function createApp() {
  const c = config();
  const app = express();
  const tp = c.TRUST_PROXY.trim();
  app.set('trust proxy', /^\d+$/.test(tp) ? Number(tp) : tp === 'true' ? true : tp === 'false' ? false : tp);
  app.disable('x-powered-by');

  const embedOrigins = c.ALLOWED_EMBED_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean);
  app.use(
    helmet({
      // Embedding is controlled by CSP frame-ancestors (an allow-list), so the legacy X-Frame-Options is off.
      frameguard: false,
      crossOriginEmbedderPolicy: false,
      contentSecurityPolicy: {
        useDefaults: true,
        directives: {
          'default-src': ["'self'"],
          'script-src': ["'self'"],
          'style-src': ["'self'", "'unsafe-inline'"],
          // Product photos from the listings: Shopify's CDN and Square's catalog image storage.
          'img-src': ["'self'", 'data:', 'https://cdn.shopify.com', 'https://items-images-production.s3.us-west-2.amazonaws.com', 'https://items-images-sandbox.s3.us-west-2.amazonaws.com'],
          'font-src': ["'self'", 'data:'],
          'connect-src': ["'self'"],
          'frame-ancestors': ["'self'", ...embedOrigins],
          'form-action': ["'self'"],
          'upgrade-insecure-requests': c.COOKIE_SECURE ? [] : null,
        },
      },
    }),
  );

  // Old or alternate addresses (www., the previous subdomain) forward to the main address in APP_URL.
  // Only page loads are redirected: API calls and webhooks on an old host are left alone so nothing half-works.
  const canonical = new URL(c.APP_URL);
  const redirectHosts = new Set(c.REDIRECT_HOSTS.split(',').map((h) => h.trim().toLowerCase()).filter((h) => h && h !== canonical.hostname));
  if (redirectHosts.size) {
    app.use((req, res, next) => {
      if ((req.method === 'GET' || req.method === 'HEAD') && redirectHosts.has(req.hostname.toLowerCase()) && !req.path.startsWith('/api/')) {
        return res.redirect(301, `${canonical.origin}${req.originalUrl}`);
      }
      next();
    });
  }

  // Webhooks first: they need raw bodies and are authenticated by signatures, not sessions.
  app.use('/api/webhooks', webhooksRouter);

  app.use(cookieParser());
  // Font uploads are larger than anything else the app receives; everything else stays at 1 MB.
  app.use('/api/settings/font', express.json({ limit: '2.5mb' }));
  app.use('/api/settings/login-image', express.json({ limit: '2.5mb' }));
  app.use(express.json({ limit: '1mb' }));
  app.get('/api/health', (_req, res) => res.json({ ok: true }));
  app.get('/brand/logo', (req, res, next) => serveLogo(req, res).catch(next));
  app.get('/brand/font/:slot', (req, res, next) => serveFont(req, res).catch(next));
  app.get('/brand/login-image', (req, res, next) => serveLoginImage(req, res).catch(next));

  // CSRF defence: state-changing API calls must carry a custom header, which other sites can't send
  // cross-origin without a CORS preflight (and no CORS is enabled).
  app.use('/api', (req, res, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    if (req.get('x-requested-with') !== 'addendum-crm') {
      return res.status(403).json({ error: { code: 'csrf', message: 'Request blocked for your security. Please refresh the page.' } });
    }
    next();
  });
  app.use('/api', rateLimit({ windowMs: 60_000, limit: 600, standardHeaders: true, legacyHeaders: false }));
  app.use('/api', loadUser);
  app.use('/api', networkGate);
  app.use('/api/auth', authRouter);
  app.use('/api', requireAuth);
  app.use('/api', apiGate);
  app.use('/api/access', accessRouter);
  app.use('/api/announcements', announcementsRouter);
  app.use('/api/projections', projectionsRouter);
  app.use('/api', miscRouter);
  app.use('/api', settingsRouter);
  app.use('/api/clients', clientsRouter);
  app.use('/api/notes', notesRouter);
  app.use('/api/leads', leadsRouter);
  app.use('/api/appointments', appointmentsRouter);
  app.use('/api/messages', messagesRouter);
  app.use('/api/tasks', tasksRouter);
  app.use('/api/integrations', integrationsRouter);
  app.use('/api/admin', adminRouter);
  app.use('/api/admin', usersRouter);
  app.use('/api/inventory-sync', inventorySyncRouter);
  app.use('/api/hair', hairRouter);
  app.use('/api/rebooking', rebookingRouter);
  app.use('/api/commission', commissionRouter);
  app.use('/api/timeclock', timeclockRouter);
  app.use('/api/inventory', inventoryRouter);
  app.use('/api/demo', demoRouter);
  app.use('/api', (_req, res) => res.status(404).json({ error: { code: 'not_found', message: 'Not found.' } }));

  // Serve the built web app (single deployable).
  const here = path.dirname(fileURLToPath(import.meta.url));
  const webDist = [path.resolve(here, '../../web/dist'), path.resolve(here, '../web/dist'), path.resolve(process.cwd(), 'web/dist')].find((p) => fs.existsSync(p));
  if (webDist) {
    app.use(express.static(webDist, {
      index: false,
      maxAge: '1h',
      setHeaders: (res, p) => {
        if (p.includes('/assets/')) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        // The embed script is loaded by the salon website (another origin), so it must be cross-origin loadable.
        if (p.endsWith(`${path.sep}embed.js`)) {
          res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
          res.setHeader('Cache-Control', 'public, max-age=300');
        }
      },
    }));
    app.get('*', (_req, res) => res.sendFile(path.join(webDist, 'index.html')));
  }

  // Friendly errors only — technical details stay in the server log.
  app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof AppError) return res.status(err.status).json({ error: { code: err.code, message: err.userMessage, details: err.details } });
    if (err instanceof IntegrationError) {
      console.warn(`[${err.provider}] ${err.technical ?? err.message}`);
      return res.status(err.authProblem ? 409 : 502).json({ error: { code: `${err.provider}_error`, message: err.userMessage } });
    }
    console.error(`[error] ${req.method} ${req.path}`, err);
    res.status(500).json({ error: { code: 'server_error', message: 'Something went wrong. Your data is safe — please try again.' } });
  });
  return app;
}
