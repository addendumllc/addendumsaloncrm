import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Plus } from 'lucide-react';
import type { ContentPostDTO } from '@addendum/shared';
import { api } from '../api/client';
import { Button, PageHeader, PageLoading, PageTabs } from '../components/ui';
import { useContentBasics } from './content/common';
import { CalendarTab } from './content/Calendar';
import { IdeasTab } from './content/Ideas';
import { AssetsTab } from './content/Assets';
import { AnalyticsTab } from './content/Analytics';
import { SettingsTab } from './content/SettingsTab';
import { PostEditor, type Prefill } from './content/PostEditor';
import { StudioTab } from './content/Studio';
import { useCanDo } from '../api/hooks';

type Tab = 'calendar' | 'studio' | 'ideas' | 'assets' | 'planning' | 'analytics' | 'settings';

/** Content calendar — or just the Content Studio for people who only have "Content Studio". */
export function ContentPage() {
  const canDo = useCanDo();
  if (!canDo('content:manage') && !canDo('*')) return (
    <div><PageHeader title="Content Studio" subtitle="On-brand copy and photo/video ideas for every format." /><StudioTab /></div>
  );
  return <ContentCalendarPage />;
}

/** Content calendar for @addendum.salon, @addendumhair and @addendumhairpro: plan, write, review, publish and measure. */
function ContentCalendarPage() {
  const b = useContentBasics();
  const [params, setParams] = useSearchParams();
  // Planning now sits under the calendar (old ?tab=planning links open the calendar).
  const tab = ((params.get('tab') === 'planning' ? 'calendar' : params.get('tab')) as Tab) || 'calendar';
  const setTab = (t: Tab) => { const p = new URLSearchParams(params); p.set('tab', t); setParams(p, { replace: true }); };
  const [editing, setEditing] = useState<{ post: ContentPostDTO | null; prefill?: Prefill } | null>(null);
  // Opened from a notification (?post=…).
  const focus = params.get('post');
  useEffect(() => {
    if (!focus) return;
    void api.get<{ post: ContentPostDTO }>(`/content/posts/${focus}`).then((r) => setEditing({ post: r.post })).catch(() => undefined);
    const p = new URLSearchParams(params); p.delete('post'); setParams(p, { replace: true });
  }, [focus]); // eslint-disable-line react-hooks/exhaustive-deps
  // Open a post another part of the page asks for (e.g. a blog draft just made from a post).
  useEffect(() => {
    const h = (e: Event) => setEditing({ post: (e as CustomEvent<ContentPostDTO>).detail });
    window.addEventListener('content:open', h);
    return () => window.removeEventListener('content:open', h);
  }, []);
  if (b.loading) return <PageLoading />;
  const open = (post: ContentPostDTO) => setEditing({ post });
  const create = (prefill?: Prefill) => setEditing({ post: null, prefill });
  return (
    <div>
      <PageHeader title="Content calendar" subtitle={b.mine.map((a) => a.name).join(' · ')}
        actions={<Button variant="primary" icon={<Plus className="h-4 w-4" />} onClick={() => create()}>New post</Button>} />
      <PageTabs value={tab} onChange={setTab} options={[
        { value: 'calendar', label: 'Calendar' }, { value: 'studio', label: 'Studio' }, { value: 'ideas', label: 'Ideas library' }, { value: 'assets', label: 'Assets' }, { value: 'analytics', label: 'Analytics' },
        ...(b.isAdmin ? [{ value: 'settings' as const, label: 'Settings' }] : []),
      ]} />
      {tab === 'calendar' && <CalendarTab b={b} onOpen={open} onNew={(date) => create({ date })} onUse={create} />}
      {tab === 'studio' && <StudioTab />}
      {tab === 'ideas' && <IdeasTab b={b} onUse={create} />}
      {tab === 'assets' && <AssetsTab b={b} />}
      {tab === 'analytics' && <AnalyticsTab b={b} onOpen={open} />}
      {tab === 'settings' && b.isAdmin && b.settings && <SettingsTab b={b} />}
      {editing && <PostEditor post={editing.post} prefill={editing.prefill} b={b} onClose={() => setEditing(null)} />}
    </div>
  );
}
