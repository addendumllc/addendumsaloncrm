import { config } from '../../config.js';
import { IntegrationError } from '../../lib/errors.js';
import type { HighLevelService, HLContactInput, HLTaskInput, HLUser } from './HighLevelService.js';

/** Live HighLevel client using a sub-account (location) Private Integration Token. */
export class HighLevelApiService implements HighLevelService {
  readonly mode = 'live' as const;
  constructor(private token: string, readonly locationId: string) {}

  private async call<T>(method: string, path: string, body?: unknown, attempt = 0): Promise<T | null> {
    const c = config();
    let res: Response;
    try {
      res = await fetch(`${c.HIGHLEVEL_API_BASE}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.token}`,
          Version: c.HIGHLEVEL_API_VERSION,
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(15_000),
      });
    } catch (e) {
      throw new IntegrationError('highlevel', 'HighLevel could not be reached. It will be retried.', true, false, String(e));
    }
    if (res.status === 429 && attempt < 2) {
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
      return this.call(method, path, body, attempt + 1);
    }
    const json: any = await res.json().catch(() => null);
    if (res.status === 404) return null;
    if (res.status === 401 || res.status === 403) {
      throw new IntegrationError('highlevel', 'HighLevel connection needs attention. Check the Private Integration token and its scopes.', false, true, `${res.status} ${JSON.stringify(json)}`);
    }
    if (!res.ok) {
      throw new IntegrationError('highlevel', 'HighLevel task could not be created. It will be retried.', res.status >= 500 || res.status === 429, false, `${res.status} ${JSON.stringify(json)}`);
    }
    return json as T;
  }

  async contactExists(contactId: string) {
    const r = await this.call<{ contact?: { id: string } }>('GET', `/contacts/${encodeURIComponent(contactId)}`);
    return !!r?.contact?.id;
  }

  async findContact(by: { phone?: string | null; email?: string | null }) {
    // Try phone first, then email, per the salon's matching order.
    for (const [param, value] of [['number', by.phone], ['email', by.email]] as const) {
      if (!value) continue;
      const qs = new URLSearchParams({ locationId: this.locationId, [param]: value });
      const r = await this.call<any>('GET', `/contacts/search/duplicate?${qs}`);
      const id = r?.contact?.id ?? r?.contacts?.[0]?.id ?? null;
      if (id) return id as string;
    }
    return null;
  }

  async createContact(input: HLContactInput) {
    const r = await this.call<{ contact: { id: string } }>('POST', '/contacts/', {
      locationId: this.locationId,
      firstName: input.firstName,
      lastName: input.lastName,
      phone: input.phone ?? undefined,
      email: input.email ?? undefined,
      tags: input.tags,
      source: 'Addendum Salon CRM',
    });
    if (!r?.contact?.id) throw new IntegrationError('highlevel', 'HighLevel contact could not be created.', true);
    return r.contact.id;
  }

  async createTask(contactId: string, task: HLTaskInput) {
    const r = await this.call<{ task: { id: string } }>('POST', `/contacts/${encodeURIComponent(contactId)}/tasks`, {
      title: task.title,
      body: task.body,
      dueDate: task.dueDate,
      completed: false,
      ...(task.assignedTo ? { assignedTo: task.assignedTo } : {}),
    });
    if (!r?.task?.id) throw new IntegrationError('highlevel', 'HighLevel task could not be created. It will be retried.', true);
    return r.task.id;
  }

  async updateTask(contactId: string, taskId: string, task: Partial<HLTaskInput> & { completed?: boolean }) {
    await this.call('PUT', `/contacts/${encodeURIComponent(contactId)}/tasks/${encodeURIComponent(taskId)}`, task);
  }

  async setTaskCompleted(contactId: string, taskId: string, completed: boolean) {
    await this.call('PUT', `/contacts/${encodeURIComponent(contactId)}/tasks/${encodeURIComponent(taskId)}/completed`, { completed });
  }

  async listUsers(): Promise<HLUser[]> {
    const loc = await this.call<{ location?: { companyId?: string } }>('GET', `/locations/${encodeURIComponent(this.locationId)}`);
    const companyId = loc?.location?.companyId;
    if (!companyId) return [];
    const qs = new URLSearchParams({ companyId, locationId: this.locationId, limit: '100' });
    const r = await this.call<{ users?: any[] }>('GET', `/users/search?${qs}`);
    return (r?.users ?? []).filter((u) => !u.deleted).map((u) => ({ id: u.id, name: u.name ?? `${u.firstName ?? ''} ${u.lastName ?? ''}`.trim(), email: u.email ?? null }));
  }

  async testConnection() {
    const loc = await this.call<{ location?: { name?: string } }>('GET', `/locations/${encodeURIComponent(this.locationId)}`);
    if (!loc?.location) throw new IntegrationError('highlevel', 'HighLevel location not found. Check HIGHLEVEL_LOCATION_ID.', false, true);
    return { locationName: loc.location.name ?? null };
  }
}
