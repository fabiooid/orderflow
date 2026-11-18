import { expect, it } from 'vitest';
import { orderDraftInput, parseDraft } from '../src/assistant/draft-schema.js';
it('maps unknown model fields to missing draft data without inventing identifiers or prices', () => {
 const result = parseDraft({ clientQuery: 'Test', clientId: null, newClient: {name:'Test',country:'IT',street:'Via Test 2',city:'Example City',postalCode:'00100',province:null,email:null,certifiedEmail:null,phone:null,vatNumber:null,taxCode:null,sdiCode:null,contactPerson:null,notes:null}, manualVatCheck:null,lines:[],shippingPrice:null,discountPercent:0,discountShipping:null,delivery:null,notes:'',priceTier:null });
 expect(result.newClient).toMatchObject({name:'Test'});
 expect(result.newClient?.email).toBeUndefined();
 expect(result.clientId).toBeUndefined(); expect(result.shippingPrice).toBeUndefined(); expect(result.manualVatCheck).toBeUndefined();
});

it('keeps a tester mark from the model and loads drafts that omit the field', () => {
  const raw = {
    clientQuery: 'Example Studio', clientId: null, newClient: null, manualVatCheck: null,
    lines: [{
      query: 'SOAP250ML Pebble hand wash 250 ml tester', productId: null, quantity: 1, tester: true,
      netPrice: null, documentPrice: null,
    }],
    shippingPrice: null, discountPercent: 0, discountShipping: null, delivery: null, notes: '', priceTier: null,
  };
  expect(parseDraft(raw).lines[0]).toMatchObject({ query: expect.stringMatching(/SOAP250ML/), quantity: 1, tester: true });
  expect(parseDraft({ ...raw, lines: [{ ...raw.lines[0]!, tester: null }] }).lines[0]?.tester).toBeUndefined();
});

it('treats a blank or non-ISO country as unknown instead of rejecting the whole extraction', () => {
  const raw = { clientQuery: 'Cliente Test', clientId: null, newClient: null, manualVatCheck: null, lines: [], shippingPrice: null, discountPercent: 0, discountShipping: null,
    delivery: { country: '', address: 'Example Atelier — Example Road 9, 00000 Example City' }, notes: '', priceTier: null };
  expect(orderDraftInput.safeParse(raw).success).toBe(true);
  expect(parseDraft(raw).delivery).toEqual({ address: 'Example Atelier — Example Road 9, 00000 Example City' });
  expect(parseDraft({ ...raw, delivery: { ...raw.delivery, country: 'it' } }).delivery?.country).toBe('IT');
});
