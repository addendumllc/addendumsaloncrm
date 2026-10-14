// Diagnoses the Shopify connection from inside the running CRM (server environment values).
// Run on the server:  sudo docker compose exec -T app node - < deploy/check-shopify.mjs
// Prints only statuses and Shopify's error text — never the client secret or an access token.
const domain = (process.env.SHOPIFY_STORE_DOMAIN || '').trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
const version = process.env.SHOPIFY_API_VERSION || '2026-07';
const out = (...a) => console.log(...a);
const why = (e) => String(e?.cause?.code || e?.cause || e);

out('store:', domain || '(not set)', '| client id set:', !!process.env.SHOPIFY_CLIENT_ID, '| secret set:', !!process.env.SHOPIFY_CLIENT_SECRET, '| legacy token set:', !!process.env.SHOPIFY_ADMIN_TOKEN);
if (!domain) process.exit(0);

let token = process.env.SHOPIFY_ADMIN_TOKEN || null;
if (!token) {
  try {
    const t0 = Date.now();
    const r = await fetch(`https://${domain}/admin/oauth/access_token`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ client_id: process.env.SHOPIFY_CLIENT_ID, client_secret: process.env.SHOPIFY_CLIENT_SECRET, grant_type: 'client_credentials' }),
      signal: AbortSignal.timeout(20000),
    });
    const text = await r.text();
    if (r.ok) { token = JSON.parse(text).access_token; out(`token request: HTTP ${r.status} OK in ${Date.now() - t0} ms (token received, not shown)`); }
    else out(`token request: HTTP ${r.status} — Shopify says: ${text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 220)}`);
  } catch (e) {
    out('token request FAILED (network):', why(e));
  }
}
if (token) {
  try {
    const r = await fetch(`https://${domain}/admin/api/${version}/graphql.json`, {
      method: 'POST', headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: '{ shop { name } currentAppInstallation { accessScopes { handle } } }' }),
      signal: AbortSignal.timeout(20000),
    });
    const j = await r.json().catch(() => ({}));
    out(`API request: HTTP ${r.status}`, j?.data?.shop ? `— shop: ${j.data.shop.name}; scopes: ${j.data.currentAppInstallation.accessScopes.map((s) => s.handle).join(', ')}` : `— ${JSON.stringify(j.errors ?? j).slice(0, 220)}`);
  } catch (e) {
    out('API request FAILED (network):', why(e));
  }
}
