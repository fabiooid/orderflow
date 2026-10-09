import { expect, it } from 'vitest';
import { orderDraftInput, parseDraft } from '../src/assistant/draft-schema.js';
it('maps unknown model fields to missing draft data without inventing identifiers or prices', () => {
 const result = parseDraft({ clientQuery: 'Test', clientId: null, newClient: {name:'Test',country:'IT',street:'Via Test 2',city:'Example City',postalCode:'00100',province:null,email:null,certifiedEmail:null,phone:null,vatNumber:null,taxCode:null,sdiCode:null,notes:null}, manualVatCheck:null,lines:[],shippingPrice:null,discountPercent:0,discountShipping:null,delivery:null,notes:'',priceTier:null });
 expect(result.newClient).toMatchObject({name:'Test'});
 expect(result.newClient?.email).toBeUndefined();
 expect(result.clientId).toBeUndefined(); expect(result.shippingPrice).toBeUndefined(); expect(result.manualVatCheck).toBeUndefined();
});

it('treats a blank or non-ISO country as unknown instead of rejecting the whole extraction', () => {
  const raw = { clientQuery: 'Cliente Test', clientId: null, newClient: null, manualVatCheck: null, lines: [], shippingPrice: null, discountPercent: 0, discountShipping: null,
    delivery: { country: '', address: 'Purani — Via Tornabuoni 9, 63848 Petritoli' }, notes: '', priceTier: null };
  expect(orderDraftInput.safeParse(raw).success).toBe(true);
  expect(parseDraft(raw).delivery).toEqual({ address: 'Purani — Via Tornabuoni 9, 63848 Petritoli' });
  expect(parseDraft({ ...raw, delivery: { ...raw.delivery, country: 'it' } }).delivery?.country).toBe('IT');
});
