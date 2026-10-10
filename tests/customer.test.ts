import { expect, it, vi } from 'vitest';
import { customerCreator } from '../src/channel/customer.js';
import { customerDetails } from '../src/domain/customer.js';
import { customerPreview, optionalCustomerFields } from '../src/channel/preview.js';
import { WriteJournal } from '../src/storage/write-journal.js';
import { DemoConnector } from '../src/connector/demo.js';
import { draftSchema } from '../src/domain/types.js';
import { config } from './helpers.js';
import type { Conversation } from '../src/channel/store.js';

it('creates only after confirmation, deduplicates retries, and refuses changed payloads', async () => {
 const journal = new WriteJournal(':memory:'); await journal.init();
 try {
  const client = (await new DemoConnector().listClients())[0]!;
  const { id, ...newClient } = client;
  const ports = { listClients: vi.fn().mockResolvedValue([]), createClient: vi.fn().mockResolvedValue({ ...newClient, id: 999 }) };
  const create = customerCreator(config(), ports, journal);
  const c: Conversation = { kind: 'customer', orderId: 'test', revision: 1, status: 'ready', draft: draftSchema.parse({newClient}), policy: '' };
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
 const c = config(); c.clients.requiredFields = [];
 const details = customerDetails(draftSchema.parse({ newClient: { name: 'Test', country: 'IT', street: 'Via Test 1', city: 'Roma', postalCode: '00100' } }), c);
 expect(details.client?.name).toBe('Test');
 expect(details.client?.vatNumber).toBeUndefined();
 expect(details.client?.email).toBeUndefined();
});

it('needs only a name to create a customer and lists what can still be added', () => {
  const c = { ...config(), locale: 'it' as const }; c.clients = { ...c.clients, requiredFields: [] };
  const newClient = { name: 'Bottega Esempio', street: 'Example Lane 30', city: 'Example City', postalCode: '00000', province: 'EX', email: 'info@example.invalid' };
  expect(customerDetails(draftSchema.parse({}), c).missing).toEqual(['name']);
  expect(customerDetails(draftSchema.parse({ newClient: { name: 'Bottega Esempio' } }), c).client?.name).toBe('Bottega Esempio');
  const client = customerDetails(draftSchema.parse({ newClient }), c).client!;
  expect(optionalCustomerFields(client, true)).toEqual(['Paese', 'Partita IVA / codice fiscale', 'Telefono']);
  expect(optionalCustomerFields({ ...client, country: 'IT' }, true, { sdiCountries: ['IT'], pecCountries: ['IT'] })).toEqual(['Partita IVA / codice fiscale', 'Codice SDI', 'PEC', 'Telefono']);
  expect(optionalCustomerFields({ ...client, country: 'DE' }, true)).toEqual(['Partita IVA / codice fiscale', 'Telefono']);
  const preview = customerPreview(client, true);
  expect(preview).toContain('• Paese\n• Partita IVA / codice fiscale');
  expect(preview).toContain('servono indirizzo e paese');
  // Deployment rules still block.
  expect(customerDetails(draftSchema.parse({ newClient }), { ...c, clients: { ...c.clients, requiredFields: ['vatNumber'] } }).missing).toEqual(['vatNumber']);
  expect(customerPreview(newClient, true, ['vatNumber'])).toContain('❓ Da completare: partita iva');
});
