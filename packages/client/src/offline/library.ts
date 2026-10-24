import Dexie, { type Table } from 'dexie';

export interface LocalDocument {
  id: string;
  accountId: string;
  title: string;
  workspaceId?: string;
  registered: boolean;
  modifiedAt: number;
}
export interface PendingUpdate {
  id: string;
  accountId: string;
  documentId: string;
  bytes: Uint8Array;
  createdAt: number;
}
export interface Account {
  id: string;
  workspaceId?: string;
}
class Library extends Dexie {
  documents!: Table<LocalDocument, string>;
  pending!: Table<PendingUpdate, string>;
  constructor() {
    super('oo-personal');
    this.version(1).stores({
      documents: 'id,accountId,modifiedAt',
      pending: 'id,[accountId+documentId],createdAt',
    });
  }
}
export const library = new Library();
export function rememberedAccount(): Account {
  try {
    return JSON.parse(localStorage.getItem('oo:personal-account') ?? '{"id":"local"}') as Account;
  } catch {
    return { id: 'local' };
  }
}
export function rememberAccount(account: Account): void {
  localStorage.setItem('oo:personal-account', JSON.stringify(account));
}
export async function newLocalDocument(
  account: Account,
  title = 'Untitled',
): Promise<LocalDocument> {
  const doc: LocalDocument = {
    id: crypto.randomUUID(),
    accountId: account.id,
    title,
    registered: false,
    modifiedAt: Date.now(),
    ...(account.workspaceId ? { workspaceId: account.workspaceId } : {}),
  };
  await library.documents.add(doc);
  return doc;
}
export function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
export function fromBase64(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
}
