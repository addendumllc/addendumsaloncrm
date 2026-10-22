import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { KeyRound } from 'lucide-react';
import { api } from '../api/client';
import { phone } from '../lib/format';
import { Avatar, Button, Field, Segmented, Spinner, cx, useToast } from '../components/ui';
import { useWorkspace } from '../lib/workspace';
import { USER_COLORS } from '../lib/theme';
import { DisplayChoices } from '../components/layout/TextSizeButton';
import { MyAppearance } from './settings/MyAppearance';
import { ChangePasswordModal } from '../components/layout/ChangePassword';

/**
 * Settings → You: everyone's own profile (mobile), display (text size, light/dark, accent) and password. These live in
 * the Settings page alongside the salon's settings.
 */
export function DisplayPanel() {
  return (
    <div className="space-y-4">
      <MyWorkspace />
      <MyAppearance />
      <div className="panel p-4"><DisplayChoices /></div>
      {/* Calendar colour: separate from the theme (changing your accent never changes it). */}
      <MyColor />
    </div>
  );
}

/** Which business the CRM opens in (also changed from the switcher at the top of the sidebar). Only with access to both. */
function MyWorkspace() {
  const { current, available, switchTo } = useWorkspace();
  if (available.length < 2 || !current) return null;
  return (
    <div className="panel p-4">
      <p className="text-[11px] uppercase tracking-wide text-stone">Default business</p>
      <p className="mb-3 mt-1 text-[13px] text-ink-soft">Which business pages like Tasks, Follow-Ups, Inventory and Clients open on. You can switch on each page; the menu shows both businesses’ tools you can use.</p>
      <Segmented value={current.id} onChange={(id) => void switchTo(id)} options={available.map((w) => ({ value: w.id, label: w.name }))} />
    </div>
  );
}

/** Your own colour: on the appointment calendar and next to your name, for everyone. Saved as soon as you pick. */
function MyColor() {
  const toast = useToast();
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ['my-profile'], queryFn: () => api.get<{ profile: { name: string; color: string | null } }>('/my-profile').then((r) => r.profile) });
  const [color, setColor] = useState<string | null>(null);
  useEffect(() => { if (data) setColor(data.color); }, [data]);
  // Dragging around the picker changes the colour many times a second: save once it settles.
  const timer = useRef<number | undefined>(undefined);
  const pickSoon = (c: string) => {
    setColor(c.toUpperCase());
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => void pick(c), 400);
  };
  const pick = async (c: string) => {
    setColor(c.toUpperCase());
    try {
      await api.patch('/my-profile', { color: c });
      for (const k of ['my-profile', 'staff', 'admin-users', 'appointments']) qc.invalidateQueries({ queryKey: [k] });
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };
  if (!data) return null;
  const current = (color ?? '#75716B').toUpperCase();
  return (
    <div className="panel p-4">
      <p className="text-[11px] uppercase tracking-wide text-stone">Calendar color</p>
      <p className="mb-3 mt-1 flex items-center gap-2 text-[13px] text-ink-soft"><Avatar name={data.name} color={current} size="sm" />Your color on the appointment calendar and next to your name, for everyone. Separate from your theme — changing your colors never changes it.</p>
      <div className="grid w-max grid-cols-[repeat(8,1.75rem)] gap-2 md:grid-cols-[repeat(12,1.75rem)]">
        {USER_COLORS.map((c) => (
          <button key={c} type="button" onClick={() => pick(c)} aria-label={`Colour ${c}`} aria-pressed={current === c}
            className={cx('h-7 w-7 rounded-full transition-transform hover:scale-110', current === c && 'ring-2 ring-ink/70 ring-offset-2')} style={{ background: c }} />
        ))}
      </div>
      <label className="mt-3 flex items-center gap-2 text-[13px] text-stone">
        <input type="color" value={current} onChange={(e) => pickSoon(e.target.value)} className="h-8 w-10 cursor-pointer rounded-md border border-line-strong bg-white p-0.5" aria-label="Pick any colour" />Any colour
      </label>
    </div>
  );
}

export function ProfilePanel() {
  const toast = useToast();
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({ queryKey: ['my-profile'], queryFn: () => api.get<{ profile: { name: string; email: string | null; roleLabel: string; mobilePhone: string | null } }>('/my-profile').then((r) => r.profile) });
  const [mobile, setMobile] = useState('');
  const [saving, setSaving] = useState(false);
  useEffect(() => { if (data) setMobile(data.mobilePhone ? phone(data.mobilePhone) : ''); }, [data]);
  if (isLoading || !data) return <div className="flex justify-center py-8"><Spinner /></div>;
  const dirty = mobile.trim() !== (data.mobilePhone ? phone(data.mobilePhone) : '');
  const save = async () => {
    setSaving(true);
    try {
      await api.patch('/my-profile', { mobilePhone: mobile.trim() || null });
      qc.invalidateQueries({ queryKey: ['my-profile'] });
      qc.invalidateQueries({ queryKey: ['staff'] });
      toast('Saved');
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setSaving(false);
    }
  };
  return (
    <div className="panel max-w-xl space-y-4 p-4">
      <dl className="grid gap-3 text-[14px] sm:grid-cols-2">
        <div><dt className="text-stone">Name</dt><dd className="text-ink">{data.name}</dd></div>
        <div><dt className="text-stone">Email (sign-in)</dt><dd className="break-all text-ink">{data.email ?? '—'}</dd></div>
        <div><dt className="text-stone">Role</dt><dd className="text-ink">{data.roleLabel}</dd></div>
      </dl>
      <p className="text-[12px] text-stone">To change your name, email or role, ask an administrator (Settings → Users &amp; Permissions).</p>
      <Field label="Mobile" hint="So the team can text you tasks and notifications.">
        <input className="field max-w-xs" type="tel" value={mobile} onChange={(e) => setMobile(e.target.value)} placeholder="(619) 555-0100" />
      </Field>
      {dirty && <Button variant="primary" size="sm" loading={saving} onClick={save}>Save</Button>}
    </div>
  );
}

export function PasswordPanel() {
  const [open, setOpen] = useState(false);
  return (
    <div className="panel max-w-xl p-4">
      <p className="text-[14px] text-ink-soft">Change the password you sign in with. Other devices are signed out when you do.</p>
      <Button className="mt-3" icon={<KeyRound className="h-4 w-4" />} onClick={() => setOpen(true)}>Change password</Button>
      {open && <ChangePasswordModal onClose={() => setOpen(false)} />}
    </div>
  );
}
