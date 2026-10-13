import { IntegrationError } from '../../lib/errors.js';
import { getKV, setKV } from '../../repos/settings.js';
import type { HighLevelService, HLContactInput, HLTaskInput } from './HighLevelService.js';

/**
 * DEMO MODE: a simulated HighLevel sub-account (contacts, tasks, users) stored in the database.
 * Can simulate an outage to demonstrate retry behaviour. Nothing is sent to HighLevel.
 */
export interface DemoHLState {
  outage: boolean;
  contacts: { id: string; name: string; phone: string | null; email: string | null }[];
  tasks: { id: string; contactId: string; title: string; body: string; dueDate: string; assignedTo: string | null; completed: boolean }[];
  users: { id: string; name: string; email: string }[];
}

const KEY = 'demo.highlevel';

export async function loadDemoHL(): Promise<DemoHLState> {
  return (await getKV<DemoHLState>(KEY)) ?? { outage: false, contacts: [], tasks: [], users: [] };
}
export const saveDemoHL = (s: DemoHLState) => setKV(KEY, s);

const rid = (p: string) => `${p}${Math.random().toString(36).slice(2, 12)}`;

export class MockHighLevelService implements HighLevelService {
  readonly mode = 'demo' as const;
  readonly locationId = 'demo-location';

  private async state() {
    const s = await loadDemoHL();
    if (s.outage) throw new IntegrationError('highlevel', 'HighLevel task could not be created. It will be retried.', true, false, 'simulated outage');
    return s;
  }
  async contactExists(id: string) {
    return (await this.state()).contacts.some((c) => c.id === id);
  }
  async findContact(by: { phone?: string | null; email?: string | null }) {
    const s = await this.state();
    const c =
      (by.phone && s.contacts.find((x) => x.phone === by.phone)) ||
      (by.email && s.contacts.find((x) => x.email?.toLowerCase() === by.email!.toLowerCase()));
    return c ? c.id : null;
  }
  async createContact(input: HLContactInput) {
    const s = await this.state();
    const id = rid('hlc_');
    s.contacts.push({ id, name: `${input.firstName} ${input.lastName}`.trim(), phone: input.phone ?? null, email: input.email ?? null });
    await saveDemoHL(s);
    return id;
  }
  async createTask(contactId: string, t: HLTaskInput) {
    const s = await this.state();
    const id = rid('hlt_');
    s.tasks.push({ id, contactId, title: t.title, body: t.body, dueDate: t.dueDate, assignedTo: t.assignedTo ?? null, completed: false });
    await saveDemoHL(s);
    return id;
  }
  async updateTask(_contactId: string, taskId: string, t: Partial<HLTaskInput> & { completed?: boolean }) {
    const s = await this.state();
    const task = s.tasks.find((x) => x.id === taskId);
    if (task) Object.assign(task, t);
    await saveDemoHL(s);
  }
  async setTaskCompleted(_c: string, taskId: string, completed: boolean) {
    const s = await this.state();
    const task = s.tasks.find((x) => x.id === taskId);
    if (task) task.completed = completed;
    await saveDemoHL(s);
  }
  async listUsers() {
    return (await this.state()).users.map((u) => ({ ...u }));
  }
  async testConnection() {
    await this.state();
    return { locationName: 'Addendum Salon (Demo HighLevel)' };
  }
}
