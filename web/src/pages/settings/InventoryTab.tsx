import { useEffect, useState } from 'react';
import { api } from '../../api/client';
import { useIntegrations } from '../../api/hooks';
import { Button, Field, Toggle, useToast } from '../../components/ui';
import { EnvRow, useSetupInfo } from './IntegrationTabs';
import { Card, SaveBar, StatusLine, useCan, useSection } from './shared';

export function InventorySettings() {
  const inv = useSection('inventory');
  const { data: integ } = useIntegrations();
  const can = useCan();
  const { data: info } = useSetupInfo(can('settings:read'));
  const locked = !can('settings:write');
  const [catalogText, setCatalogText] = useState('');
  const toast = useToast();
  const [testing, setTesting] = useState(false);
  useEffect(() => {
    if (inv.draft) setCatalogText(inv.draft.catalog.join('\n'));
    // only when the saved catalog changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inv.draft?.catalog.join('\n')]);
  if (!inv.draft || !integ) return null;
  const d = inv.draft;
  const testShopify = async () => {
    setTesting(true);
    const r = await api.post<{ ok: boolean; message: string }>('/integrations/shopify/test').catch((e) => ({ ok: false, message: (e as Error).message }));
    toast(r.message, r.ok ? 'success' : 'error');
    setTesting(false);
  };

  return (
    <div className="space-y-6">
      <Card
        title="Order Hair"
        description="Stylists order Addendum Hair from the Order Hair page. Each order is emailed here and tracked until it's received."
        footer={<SaveBar dirty={inv.dirty} saving={inv.saving} onSave={() => inv.save()} onReset={inv.reset} disabled={locked} />}
      >
        <Field label="Send order requests to" hint="Whoever places orders with Addendum Hair. info@addendumhair.com is always copied.">
          <input className="field sm:w-80" type="email" value={d.orderEmail} disabled={locked} onChange={(e) => inv.set('orderEmail', e.target.value)} />
        </Field>
        <div className="mt-2 grid gap-3 sm:grid-cols-2">
          <Field label="Sent from — name" hint="Order emails arrive as a form submission under this name.">
            <input className="field" value={d.orderFromName ?? ''} maxLength={80} disabled={locked} onChange={(e) => inv.set('orderFromName', e.target.value)} placeholder="Addendum Hair Order Form" />
          </Field>
          <Field label="Sent from — address" hint="A form/no-reply address, e.g. orders@addendumsalon.info — not a staff or info@ mailbox. Your email service must be allowed to send from it.">
            <input className="field" type="email" value={d.orderFromAddress ?? ''} disabled={locked} onChange={(e) => inv.set('orderFromAddress', e.target.value)} placeholder="orders@addendumsalon.info" />
          </Field>
        </div>
        <div className="mt-3 space-y-2 rounded-xl border border-line p-3">
          <Toggle label="Send as the person who placed the order" checked={d.sendAsSubmitter ?? true} disabled={locked} onChange={(v) => inv.set('sendAsSubmitter', v)}
            description="Their name is on the email and replies go to them. It comes from their own address when its domain is listed below (your email service must be allowed to send for it); otherwise it shows as “Name via the form name” from the address above." />
          {(d.sendAsSubmitter ?? true) && (
            <Field label="Email domains your email service can send from" hint="Comma-separated, e.g. addendumsalon.com. Leave empty if staff use personal addresses (Gmail, Outlook…).">
              <input className="field font-mono text-[13px]" disabled={locked} defaultValue={(d.senderDomains ?? []).join(', ')}
                onChange={(e) => inv.set('senderDomains', [...new Set(e.target.value.split(/[,\s]+/).map((x) => x.trim().toLowerCase().replace(/^@/, '')).filter(Boolean))])} placeholder="addendumsalon.com" />
            </Field>
          )}
        </div>
        <Toggle label="Copy the stylist" description="CC the person who submitted the request (when they have an email on file), and replies go to them." checked={d.ccRequester} disabled={locked} onChange={(v) => inv.set('ccRequester', v)} />
        <Field label="Quick-pick collections" className="mt-2" hint="One per line. Shown as one-tap buttons when building an order. Collections ordered before are suggested automatically too.">
          <textarea
            className="field min-h-[140px] font-mono text-[13px]" disabled={locked} value={catalogText}
            onChange={(e) => {
              setCatalogText(e.target.value);
              inv.set('catalog', [...new Set(e.target.value.split('\n').map((s) => s.trim()).filter(Boolean))].slice(0, 300));
            }}
            placeholder={'Signature Hand-Tied Weft\nK-Tip Extensions\nTape-In Extensions'}
          />
        </Field>
        {locked && <p className="mt-3 text-[13px] text-stone">Only administrators (with “Edit business settings”) can change where requests are sent.</p>}
      </Card>

      <Card title="Shopify inventory" description="Square is the source of truth for stock. Administrators can push Square's counts to Shopify by hand from Order Hair → Square inventory; products are matched by SKU. Nothing is sent to Shopify automatically, and hair orders never change Shopify.">
        <StatusLine state={integ.shopify.connected ? 'ok' : 'off'}>
          {integ.shopify.mode === 'demo' ? 'Demo Mode — a simulated Shopify store' : integ.shopify.connected ? `Shopify connected ✓${integ.shopify.store ? ` · ${integ.shopify.store}` : ''}` : 'Shopify not connected — the push to Shopify is unavailable until it is'}
        </StatusLine>
        {integ.shopify.connected && can('integrations:manage') && <Button className="mt-4" loading={testing} onClick={testShopify}>Test connection</Button>}
        {info && (
          <details className="mt-5 rounded-xl border border-line px-4 py-3 text-sm">
            <summary className="cursor-pointer font-medium text-ink">Developer setup details</summary>
            <p className="mt-3 text-stone">In Shopify: create an app in the Dev Dashboard (or use an existing custom app), give it these Admin API scopes, install it on the store, then set these on the server and restart:</p>
            <p className="mt-2 text-[13px] text-ink-soft">{info.shopify.scopes.join(', ')}</p>
            <pre className="mt-2 overflow-x-auto rounded-lg bg-mist/60 px-3 py-2 text-[12.5px] text-ink-soft">{'SHOPIFY_STORE_DOMAIN=your-store.myshopify.com\nSHOPIFY_CLIENT_ID=…   SHOPIFY_CLIENT_SECRET=…\n# or, for an older custom app: SHOPIFY_ADMIN_TOKEN=shpat_…\n# only if the store has several locations: SHOPIFY_LOCATION_ID=…'}</pre>
            <ul className="mt-3 space-y-1 text-[13px]">
              <EnvRow ok={!!info.shopify.store} name="SHOPIFY_STORE_DOMAIN" />
              <EnvRow ok={info.shopify.auth !== 'none'} name="SHOPIFY_CLIENT_ID + SHOPIFY_CLIENT_SECRET (or SHOPIFY_ADMIN_TOKEN)" />
            </ul>
          </details>
        )}
      </Card>

      <Card title="Email sending" description="Used for order requests (and email alerts, if turned on in Notifications).">
        <StatusLine state={integ.email.connected ? 'ok' : 'warn'}>
          {integ.email.provider === 'demo' ? 'Demo Mode — emails are simulated, not sent' : integ.email.connected ? 'Email connected ✓' : "Email isn't set up yet — requests are saved and will send once it is"}
        </StatusLine>
        {info?.email.from && <p className="mt-1 text-sm text-ink-soft">Sends from {info.email.from}</p>}
        {info && (
          <details className="mt-4 rounded-xl border border-line px-4 py-3 text-sm">
            <summary className="cursor-pointer font-medium text-ink">Developer setup details</summary>
            <p className="mt-3 text-stone">Set these on the server (any SMTP provider — Google Workspace, Microsoft 365, Postmark, SendGrid…), then restart:</p>
            <pre className="mt-2 overflow-x-auto rounded-lg bg-mist/60 px-3 py-2 text-[12.5px] text-ink-soft">{'SMTP_HOST=smtp.gmail.com\nSMTP_PORT=587\nSMTP_USER=orders@addendumsalon.com\nSMTP_PASS=<app password>\nEMAIL_FROM="Addendum Salon <orders@addendumsalon.com>"'}</pre>
            <p className="mt-2 text-[13px] text-stone">{info.email.configured ? `✓ SMTP_HOST is set (${info.email.host}).` : '! SMTP_HOST is not set.'}</p>
          </details>
        )}
      </Card>
    </div>
  );
}
