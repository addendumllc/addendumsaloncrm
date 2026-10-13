import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2, Tag } from 'lucide-react';
import { api } from '../../api/client';
import { useTags } from '../../api/hooks';
import { Button, useToast } from '../../components/ui';
import { Card, useCan } from './shared';

// Team members and logins are managed manually (docs/SETUP.md → "Team members & logins").

export function TagSettings() {
  const { data: tags } = useTags();
  const can = useCan();
  const qc = useQueryClient();
  const toast = useToast();
  const [name, setName] = useState('');
  const add = async () => {
    try {
      await api.post('/tags', { name });
      setName('');
      qc.invalidateQueries({ queryKey: ['tags'] });
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };
  const remove = async (id: string, n: string) => {
    if (!confirm(`Delete the tag “${n}”? It will be removed from every client.`)) return;
    await api.del(`/tags/${id}`).catch((e) => toast((e as Error).message, 'error'));
    qc.invalidateQueries({ queryKey: ['tags'] });
  };
  return (
    <Card title="Client tags" description="Tags help you filter clients — e.g. VIP, Bridal, Extensions.">
      <div className="flex flex-wrap gap-2">
        {tags?.map((t) => (
          <span key={t.id} className="inline-flex items-center gap-1.5 rounded-full border border-line bg-white py-1 pl-3 pr-2 text-sm">
            <Tag className="h-3.5 w-3.5 text-stone" />{t.name}<span className="num text-xs text-stone">{t.count}</span>
            {!t.isDefault && can('settings:rules') && <button onClick={() => remove(t.id, t.name)} className="rounded p-0.5 text-stone hover:text-rose" aria-label={`Delete ${t.name}`}><Trash2 className="h-3.5 w-3.5" /></button>}
          </span>
        ))}
      </div>
      {can('clients:write') && (
        <div className="mt-4 flex gap-2 sm:w-96">
          <input className="field" value={name} maxLength={40} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && name.trim() && add()} placeholder="New tag name" />
          <Button onClick={add} disabled={!name.trim()} icon={<Plus className="h-4 w-4" />}>Add</Button>
        </div>
      )}
    </Card>
  );
}
