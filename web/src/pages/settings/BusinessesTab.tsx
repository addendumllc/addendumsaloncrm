import { useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { ImageIcon, Trash2, Upload } from 'lucide-react';
import { BUSINESSES, DEFAULT_LOGIN, DEFAULT_MENU_GROUPS, DEFAULT_MENU_ORDER, DEFAULT_MENU_SECTIONS, DEFAULT_WORKSPACES, LOGIN_IMAGE_MAX_BYTES, ROLES, type AppSettings, type BuiltinRole, type BusinessId, type LoginSettings, type SidebarDefaults, type WorkspaceSettings } from '@addendum/shared';
import { api } from '../../api/client';
import { Button, Field, Segmented, useToast } from '../../components/ui';
import { NAV } from '../../components/layout/AppShell';
import { MenuEditor } from '../../components/layout/sidebarLayout';
import { Card, SaveBar, useCan, useSection } from './shared';

/**
 * Settings → Businesses (organization level): each business's name and tagline, which sidebar tabs belong to which
 * business, and the sign-in screen. Each business's look is in Appearance & Display; who can use each business is a
 * permission in Users & Permissions; each person's own preferences are theirs (Organization → Business → User).
 */
export function BusinessesSettings() {
  const can = useCan();
  const editable = can('settings:write');
  return (
    <div className="space-y-6">
      <WorkspacesCard editable={editable} />
      <LoginCard editable={editable} />
      <Card title="Where the rest lives" description="Organization → Business → You: each level has its own settings, and one never overwrites another.">
        <ul className="space-y-1.5 text-[14px] text-ink-soft">
          <li><Link className="text-plum hover:underline" to="/settings?tab=display">Appearance &amp; Display</Link> — each business’s look: themes, colours, fonts, type and corners, with a live preview.</li>
          <li><Link className="text-plum hover:underline" to="/settings?tab=users">Users &amp; Permissions</Link> — who can use each business (“Addendum Salon workspace”, “Addendum Hair workspace”) and what they can see in it.</li>
          <li><Link className="text-plum hover:underline" to="/settings?tab=roles">Role Templates</Link> — the starting permissions for each role.</li>
          <li>Each person’s own theme, light/dark, calendar colour, text size and default business — in their own Appearance &amp; Display.</li>
        </ul>
      </Card>
    </div>
  );
}

function WorkspacesCard({ editable }: { editable: boolean }) {
  const sec = useSection('workspaces');
  const d: WorkspaceSettings = { ...DEFAULT_WORKSPACES, ...(sec.draft ?? {}), businesses: { ...DEFAULT_WORKSPACES.businesses, ...(sec.draft?.businesses ?? {}) } };
  const setBiz = (id: BusinessId, patch: Partial<{ name: string; tagline: string }>) => sec.setDraft({ ...d, businesses: { ...d.businesses, [id]: { ...d.businesses[id], ...patch } } });
  return (
    <Card title="Businesses" description="Addendum Salon and Addendum Hair: two businesses in one CRM, sharing the team and settings. Pages like Tasks, Inventory and Clients let you pick the business at the top."
      footer={<SaveBar dirty={sec.dirty} saving={sec.saving} onSave={() => sec.save()} onReset={sec.reset} disabled={!editable} />}>
      <div className="grid gap-4 sm:grid-cols-2">
        {BUSINESSES.map((b) => (
          <div key={b.id} className="border border-line p-3">
            <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-stone">{b.id === 'salon' ? 'Salon workspace' : 'Hair workspace'}</p>
            <Field label="Name"><input className="field" disabled={!editable} maxLength={40} value={d.businesses[b.id].name} onChange={(e) => setBiz(b.id, { name: e.target.value })} /></Field>
            <Field label="Tagline" className="mt-3" hint="Under the name in the switcher."><input className="field" disabled={!editable} maxLength={60} value={d.businesses[b.id].tagline} onChange={(e) => setBiz(b.id, { tagline: e.target.value })} /></Field>
          </div>
        ))}
      </div>
      <MenuDefaultsEditor value={d} onChange={sec.setDraft} editable={editable} />
    </Card>
  );
}

const ROLE_LABEL: Record<BuiltinRole, string> = { admin: 'Admin', receptionist: 'Reception', stylist: 'Stylist', assistant: 'Assistant' };

/**
 * The sidebar for everyone (organization level): which section each tab is in, and each role's default menu — order,
 * hidden by default, and required tabs nobody can hide. Defaults apply to people who haven't customized their own
 * menu; nobody's own menu is overwritten.
 */
function MenuDefaultsEditor({ value, onChange, editable }: { value: WorkspaceSettings; onChange: (v: WorkspaceSettings) => void; editable: boolean }) {
  const [role, setRole] = useState<BuiltinRole>('receptionist');
  // "/my-calendar" is the same tab as "/appointments" (just their own calendar): edited together.
  const items = NAV.filter((n) => n.to !== '/my-calendar');
  const groups = { ...DEFAULT_MENU_GROUPS, ...(value.groups ?? {}) };
  const sections = { ...DEFAULT_MENU_SECTIONS, ...(value.sections ?? {}) };
  const d: SidebarDefaults = { order: DEFAULT_MENU_ORDER, hidden: [], required: [], ...(value.menuDefaults?.[role] ?? {}) };
  const twin = (list: string[]) => list.flatMap((p) => (p === '/appointments' ? [p, '/my-calendar'] : p === '/my-calendar' ? [] : [p]));
  const put = (patch: Partial<SidebarDefaults>) => onChange({ ...value, menuDefaults: { ...(value.menuDefaults ?? {}), [role]: { ...d, ...patch } } });
  return (
    <div className={editable ? 'mt-6' : 'pointer-events-none mt-6 opacity-70'}>
      <p className="mb-1 text-[14px] font-medium text-ink">Menu</p>
      <p className="mb-3 text-[13px] text-stone">Each role’s default menu — sections and their headings, tab names, order and shown tabs — for people who haven’t customized their own menu (nobody’s own menu is changed). Required tabs can’t be hidden. The menu only arranges — what each person can open is decided by their permissions.</p>
      <Segmented className="mb-3" value={role} onChange={setRole} options={ROLES.map((r) => ({ value: r, label: ROLE_LABEL[r] }))} />
      <MenuEditor admin items={items} groups={groups} sections={{ ...sections, ...(d.sections ?? {}) }} required={d.required}
        value={{ order: d.order, hidden: d.hidden, sections: d.sections, sectionList: d.sectionList, labels: d.labels }}
        onChange={(v) => put({ order: twin(v.order), hidden: twin(v.hidden), sections: v.sections ? { ...v.sections, '/my-calendar': v.sections['/appointments'] ?? 'daily' } : d.sections, sectionList: v.sectionList, labels: v.labels })}
        onRequired={(r) => put({ required: twin(r) })} />
      <Button size="sm" variant="ghost" className="mt-2" onClick={() => onChange({ ...value, menuDefaults: { ...(value.menuDefaults ?? {}), [role]: { order: DEFAULT_MENU_ORDER, hidden: [], required: [] } } })}>Restore the built-in menu</Button>
    </div>
  );
}

function LoginCard({ editable }: { editable: boolean }) {
  const sec = useSection('login');
  const qc = useQueryClient();
  const toast = useToast();
  const file = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const d: LoginSettings = { ...DEFAULT_LOGIN, ...(sec.draft ?? {}) };
  const after = (r: { settings: AppSettings }) => {
    qc.setQueryData(['settings'], { settings: r.settings });
    sec.setDraft(r.settings.login);
    qc.invalidateQueries({ queryKey: ['auth-config'] });
  };
  const upload = async (f: File | undefined) => {
    if (!f) return;
    setBusy(true);
    try {
      // Any photo works: larger ones are resized here first (about 1600px wide, JPEG), so they fit the 1.5 MB limit.
      const dataUrl = f.size <= LOGIN_IMAGE_MAX_BYTES && /^image\/(jpeg|png|webp)$/.test(f.type)
        ? await new Promise<string>((ok, fail) => { const r = new FileReader(); r.onload = () => ok(String(r.result)); r.onerror = fail; r.readAsDataURL(f); })
        : await shrinkPhoto(f, LOGIN_IMAGE_MAX_BYTES);
      after(await api.put<{ settings: AppSettings }>('/settings/login-image', { dataUrl }));
      toast('Photo saved');
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(false);
      if (file.current) file.current.value = '';
    }
  };
  const remove = async () => {
    setBusy(true);
    try { after(await api.del<{ settings: AppSettings }>('/settings/login-image')); } catch (e) { toast((e as Error).message, 'error'); } finally { setBusy(false); }
  };
  const save = () => sec.save();
  return (
    <Card title="Sign-in page" description="One umbrella sign-in for both businesses; each person lands in their own workspace (with its look) once signed in."
      footer={<SaveBar dirty={sec.dirty} saving={sec.saving} onSave={save} onReset={sec.reset} disabled={!editable} />}>
      <div className="grid gap-5 sm:grid-cols-[1fr_240px]">
        <div className="space-y-3">
          <Field label="Message" hint="Optional — shown on the photo on large screens. The name shows once, above the form (your logo)."><input className="field" disabled={!editable} maxLength={160} value={d.message} onChange={(e) => sec.setDraft({ ...d, message: e.target.value })} /></Field>
          <div className="flex flex-wrap gap-2">
            <input ref={file} type="file" accept="image/jpeg,image/png,image/webp" className="hidden" onChange={(e) => upload(e.target.files?.[0])} />
            <Button size="sm" icon={<Upload className="h-4 w-4" />} loading={busy} disabled={!editable} onClick={() => file.current?.click()}>{d.imageVersion ? 'Replace photo' : 'Upload photo'}</Button>
            {d.imageVersion && <Button size="sm" variant="ghost" icon={<Trash2 className="h-4 w-4" />} disabled={!editable || busy} onClick={remove}>Remove photo</Button>}
          </div>
          <p className="text-[12px] text-stone">An editorial photo beside the form — behind it on phones (any size; large photos are resized for you). Without one, a quiet dark panel is shown.</p>
        </div>
        <div className="flex aspect-[4/5] items-end overflow-hidden border border-line bg-[#14110E] p-4 text-[#F3EEE7]" style={d.imageVersion ? { backgroundImage: `url(/brand/login-image?v=${d.imageVersion})`, backgroundSize: 'cover', backgroundPosition: 'center' } : undefined}>
          {!d.imageVersion && <ImageIcon className="mb-auto h-5 w-5 opacity-40" />}
          {d.message && <span className="text-[12px] drop-shadow">{d.message}</span>}
        </div>
      </div>
    </Card>
  );
}

/** A photo resized in the browser (longest side about 1600px, then smaller if needed) as a JPEG data URL under `maxBytes`. */
async function shrinkPhoto(f: File, maxBytes: number): Promise<string> {
  let bmp: ImageBitmap;
  try { bmp = await createImageBitmap(f); } catch { throw new Error('That photo couldn’t be read — save it as a JPG or PNG and try again.'); }
  try {
    for (const side of [1600, 1400, 1200, 1000]) {
      const scale = Math.min(1, side / Math.max(bmp.width, bmp.height));
      const c = document.createElement('canvas');
      c.width = Math.round(bmp.width * scale); c.height = Math.round(bmp.height * scale);
      c.getContext('2d')!.drawImage(bmp, 0, 0, c.width, c.height);
      for (const q of [0.86, 0.78, 0.7]) {
        const url = c.toDataURL('image/jpeg', q);
        if ((url.length - url.indexOf(',') - 1) * 0.75 <= maxBytes) return url;
      }
    }
  } finally { bmp.close(); }
  throw new Error('That photo is too large even after resizing — try a smaller one.');
}
