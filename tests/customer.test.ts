import { expect, it, vi } from 'vitest';
import { customerCreator } from '../src/telegram/customer.js';
import { WriteJournal } from '../src/storage/write-journal.js';
import { DemoConnector } from '../src/connector/demo.js';
import { draftSchema } from '../src/domain/types.js';
import { config } from './helpers.js';
import type { Conversation } from '../src/telegram/store.js';

it('creates only after confirmation, deduplicates retries, and refuses changed payloads', async () => {
 const journal = new WriteJournal(':memory:'); await journal.init();
 try {
  const client = (await new DemoConnector().listClients())[0]!;
  const { id, ...newClient } = client;
  const ports = { listClients: vi.fn().mockResolvedValue([]), createClient: vi.fn().mockResolvedValue({ ...newClient, id: 999 }) };
  const create = customerCreator(config(), ports, journal);
  const c: Conversation = { kind: 'customer', orderId: 'test', revision: 1, status: 'ready', draft: draftSchema.parse({newClient}), questions: '', policy: '' };
  await expect(create({ ...c, status: 'suspended' })).rejects.toThrow();
  await expect(create(c)).resolves.toContain('999');
  await expect(create(c)).resolves.toContain('999');
  expect(ports.createClient).toHaveBeenCalledTimes(1);
  await expect(create({ ...c, draft: { ...c.draft, newClient: { ...newClient, name: 'Changed' } } })).rejects.toThrow();
  ports.listClients.mockResolvedValue([client]);
  await expect(create({ ...c, orderId: 'other' })).resolves.toContain('già presente');
  expect(ports.createClient).toHaveBeenCalledTimes(1);
 } finally { journal.close(); }
});

it('allows customer creation without email or VAT when deployment requirements are empty', async () => {
 const { customerDetails } = await import('../src/telegram/customer.js');
 const c = config(); c.clients.requiredFields = []; c.clients.sdiCountries = [];
 const details = customerDetails(draftSchema.parse({ newClient: { name: 'Test', country: 'IT', street: 'Via Test 1', city: 'Roma', postalCode: '00100' } }), c);
 expect(details.client?.name).toBe('Test');
 expect(details.client?.vatNumber).toBeUndefined();
 expect(details.client?.email).toBeUndefined();
});
