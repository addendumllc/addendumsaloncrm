/**
 * HighLevel (LeadConnector) boundary. Verified against HighLevel's official OpenAPI specs
 * (github.com/GoHighLevel/highlevel-api-docs), API v2, header `Version: 2021-07-28`:
 *  GET  /contacts/{contactId}                       contacts.readonly
 *  GET  /contacts/search/duplicate?locationId&number|email   contacts.readonly
 *  POST /contacts/                                  contacts.write
 *  POST /contacts/{contactId}/tasks                 contacts.write   body: title, body, dueDate, completed, assignedTo
 *  PUT  /contacts/{contactId}/tasks/{taskId}        contacts.write
 *  PUT  /contacts/{contactId}/tasks/{taskId}/completed  contacts.write
 *  GET  /locations/{locationId}                     locations.readonly  (gives companyId)
 *  GET  /users/search?companyId&locationId          users.readonly
 *  GET  /contacts/?locationId&limit&startAfterId&startAfter   contacts.readonly  (Addendum Hair client import)
 * HighLevel tasks have NO priority field — priority is carried in the task title.
 */
export interface HLContactInput {
  firstName: string;
  lastName: string;
  phone?: string | null;
  email?: string | null;
  tags?: string[];
}

export interface HLTaskInput {
  title: string;
  body: string;
  dueDate: string; // ISO 8601
  assignedTo?: string | null;
}

/** A contact as listed by HighLevel (for importing clients). */
export interface HLContact {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  company: string | null;
  tags: string[];
}
/** Where the next page of contacts starts (HighLevel's cursor), or null on the last page. */
export type HLContactCursor = { startAfterId: string; startAfter: number } | null;

export interface HLUser {
  id: string;
  name: string;
  email: string | null;
}

export interface HighLevelService {
  readonly mode: 'live' | 'demo';
  readonly locationId: string | null;
  contactExists(contactId: string): Promise<boolean>;
  findContact(by: { phone?: string | null; email?: string | null }): Promise<string | null>;
  createContact(input: HLContactInput): Promise<string>;
  createTask(contactId: string, task: HLTaskInput): Promise<string>;
  updateTask(contactId: string, taskId: string, task: Partial<HLTaskInput> & { completed?: boolean }): Promise<void>;
  setTaskCompleted(contactId: string, taskId: string, completed: boolean): Promise<void>;
  listUsers(): Promise<HLUser[]>;
  listContacts(after?: HLContactCursor): Promise<{ contacts: HLContact[]; next: HLContactCursor }>;
  testConnection(): Promise<{ locationName: string | null }>;
}
