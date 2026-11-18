import { vi } from 'vitest';
import { installTelegramChannel } from '../src/channels/telegram/adapter.js';
import example from '../config/example.json';

installTelegramChannel();
import { configSchema } from '../src/config/schema.js';
import { DemoConnector } from '../src/connector/demo.js';
import { draftSchema, type Client, type OrderDraft } from '../src/domain/types.js';
import { prepareOrder } from '../src/domain/prepare.js';
import { createDraftApi } from '../src/assistant/drafts.js';
import { createIdentityResolver } from '../src/matching/resolver.js';
import { matchingConfigSchema } from '../src/matching/config.js';
import type { TurnInput, TurnOutput } from '../src/channel/controller.js';
import type { Conversation } from '../src/channel/store.js';
export const config = () => configSchema.parse(structuredClone(example));

/** Fictional shop/hotel siblings: everyday place name in notes or street, different legal names. */
export const harborSiblings = (): { shop: Client; hotel: Client; cafe: Client } => {
  const place = { country: 'IT' as const, city: 'Genova', postalCode: '16100', email: 'orders@fable-harbor.invalid' };
  return {
    shop: { id: '210', name: 'Fable Harbor Shop Srl', ...place, street: 'Harbour Dock 2', vatNumber: 'DEMO-FABLE-SHOP', notes: 'Fable Harbor shop' },
    hotel: { id: '211', name: 'Fable Rooms Srl', ...place, street: 'Fable Harbor Walk 4', vatNumber: 'DEMO-FABLE-ROOMS', notes: 'hotel' },
    cafe: { id: '212', name: 'Fable Harbor Cafe', ...place, street: 'Other Street 9', vatNumber: 'DEMO-FABLE-CAFE', notes: 'call after 10' },
  };
};

/**
 * Legal name differs from the everyday name, which lives in notes (not in the legal name or as the only
 * street match). Shop sibling uses the everyday place as its legal name, with empty notes.
 */
export const monasterySiblings = (): { shop: Client; hotel: Client } => {
  const place = { country: 'IT' as const, city: 'Genova', postalCode: '16100', email: 'orders@harbour-hotel.invalid' };
  return {
    shop: { id: '220', name: 'Harbour Shop Ltd', ...place, street: 'Quay Dock 2', vatNumber: 'DEMO-HARBOUR-SHOP', notes: '' },
    hotel: { id: '221', name: 'Example Monastery Ltd', ...place, street: 'Monastery Walk 1', vatNumber: 'DEMO-HARBOUR-HOTEL', notes: 'Harbour Hotel' },
  };
};

/** Unrelated accounts that only share a generic trade word, with different distinctive names. */
export const pharmacyTypeAccounts = (): { willowmere: Client; cinderford: Client; pebblebrook: Client } => {
  const place = { country: 'IT' as const, city: 'Genova', postalCode: '16100', email: 'orders@pharmacy-type.invalid' };
  return {
    willowmere: { id: '310', name: 'Willowmere Pharmacy Srl', ...place, street: 'Willowmere Lane 1', vatNumber: 'DEMO-WILLOWMERE', notes: '' },
    cinderford: { id: '311', name: 'Cinderford Pharmacy Srl', ...place, street: 'Cinderford Road 8', vatNumber: 'DEMO-CINDERFORD', notes: '' },
    pebblebrook: { id: '312', name: 'Pebblebrook Pharmacy Srl', ...place, street: 'Pebblebrook Way 3', vatNumber: 'DEMO-PEBBLEBROOK', notes: '' },
  };
};

/** Distinctive business name versus another account that only has that word in its street. */
export const willowmereStayAccounts = (): { agriturismo: Client; streetOnly: Client; east: Client } => {
  const place = { country: 'IT' as const, city: 'Genova', postalCode: '16100', email: 'orders@willowmere-stay.invalid' };
  return {
    agriturismo: { id: '410', name: 'Willowmere Agriturismo', ...place, street: 'Hill Road 12', vatNumber: 'DEMO-WILLOWMERE-STAY', notes: 'Willowmere stay' },
    streetOnly: { id: '411', name: 'Oakridge Farm Srl', ...place, street: 'Willowmere Lane 8', vatNumber: 'DEMO-OAKRIDGE', notes: '' },
    east: { id: '412', name: 'Willowmere East Farm Srl', ...place, street: 'East Lane 4', vatNumber: 'DEMO-WILLOWMERE-EAST-STAY', notes: '' },
  };
};

/** Distinctive account names that differ only by a short extra or missing ending. */
export const sampleNameAccounts = (): { sample: Client; sampler: Client; east: Client } => {
  const place = { country: 'IT' as const, city: 'Genova', postalCode: '16100', email: 'orders@sample-name.invalid' };
  return {
    sample: { id: '510', name: 'Cliente Sample', ...place, street: 'Sample Lane 1', vatNumber: 'DEMO-CLIENTE-SAMPLE', notes: '' },
    sampler: { id: '511', name: 'Cliente Sampler', ...place, street: 'Sampler Road 2', vatNumber: 'DEMO-CLIENTE-SAMPLER', notes: '' },
    east: { id: '512', name: 'Cliente Sample East', ...place, street: 'East Lane 5', vatNumber: 'DEMO-CLIENTE-SAMPLE-EAST', notes: '' },
  };
};
export const draft = () => draftSchema.parse({
  clientQuery: 'Example Studio', clientId: '201',
  lines: [{ query: 'Pebble hand wash 250 ml', productId: '101', quantity: 2 }],
  shippingPrice: 8, discountPercent: 10,
});
export async function prepared() {
  const result = await prepareOrder(draft(), config(), new DemoConnector(), '2026-01-15');
  if (!result.ready) throw new Error('Fixture did not prepare');
  return result.order;
}

/** Identity pass then commercial prepare. Use this when the fixture has queries rather than accepted ids. */
export async function complete(input: OrderDraft, connector = new DemoConnector(), operatorText?: string) {
  const matching = createIdentityResolver(config(), connector, { config: matchingConfigSchema.parse({ mode: 'off' }) });
  const spoken = operatorText ?? [input.clientQuery, ...input.lines.map(line => line.query)].filter(Boolean).join(' ');
  const result = await createDraftApi(config(), connector, matching).order(input, {
    orderId: 'test', revision: 1, operatorText: spoken, operatorWords: spoken,
  }, '2026-01-15');
  if (result.status === 'ready') return { ready: true as const, order: result.order, draft: result.draft, issues: [] as const };
  return { ready: false as const, issues: result.issues, draft: result.draft, clientId: result.client?.id };
}

/** Telegram updates as the group sends them: a message (optionally a reply) or a button press under a bot message. */
export function message(id: number, text: string, reply?: number, sender = 5) {
  return { update_id: id, message: { message_id: id, chat: { id: -1000000000001, type: 'supergroup' }, from: { id: sender, is_bot: false }, text, reply_to_message: reply ? { message_id: reply } : undefined } };
}
export function press(id: number, data: string, messageId: number, sender = 5) {
  return { update_id: id, callback_query: { id: `q${id}`, from: { id: sender, is_bot: false }, data, message: { message_id: messageId, chat: { id: -1000000000001, type: 'supergroup' } } } };
}

/**
 * A stand-in for the agent: each turn opens a new request or moves the open one to `status`, replying `text`. When
 * another request blocks a new one, it reports that the way the draft tools do.
 */
export function stubEngine(status: Conversation['status'] = 'ready', text = 'Summary', kind: 'order' | 'customer' = 'order') {
  return {
    turn: vi.fn(async (input: TurnInput): Promise<TurnOutput> => {
      if (!input.request && input.locked) return { text: 'Another request is open.', reply: '', locale: 'it', blocked: true };
      const previous = input.request ?? input.fresh(kind);
      return { text, reply: '', locale: 'it', order: { ...previous, revision: previous.revision + 1, status } };
    }),
    revise: vi.fn(async (previous: Conversation) => ({ order: { ...previous, revision: previous.revision + 1, status }, text })),
  };
}
