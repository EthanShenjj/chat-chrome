import { openDB } from 'idb';
import type { Session, Operation, Delivery } from '../../../packages/contracts/index';
const db = () => openDB('ae-chat-agent', 2, { upgrade(db) { for (const name of ['state', 'operations', 'deliveries', 'sessions']) if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, name === 'state' ? undefined : { keyPath: 'id' }); } });
export const journal = {
  async session(): Promise<Session | undefined> { return (await db()).get('state', 'session'); },
  async saveSession(s: Session) { const database = await db(); const tx = database.transaction(['state', 'sessions'], 'readwrite'); await tx.objectStore('state').put(structuredClone(s), 'session'); await tx.objectStore('sessions').put(structuredClone(s)); await tx.done; },
  async sessions(): Promise<Session[]> { return (await db()).getAll('sessions'); },
  async operations(): Promise<Operation[]> { return (await db()).getAll('operations'); },
  async saveOperation(o: Operation) { return (await db()).put('operations', structuredClone(o)); },
  async deliveries(): Promise<Delivery[]> { return (await db()).getAll('deliveries'); },
  async saveDelivery(d: Delivery) { return (await db()).put('deliveries', structuredClone(d)); }
};
