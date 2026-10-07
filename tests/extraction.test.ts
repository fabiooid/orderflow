import { expect, it } from 'vitest';
import { parseExtraction } from '../src/assistant/extraction-schema.js';
it('maps unknown model fields to missing draft data without inventing identifiers or prices', () => {
 const result = parseExtraction({ clientQuery: 'Test', clientId: null, newClient: {name:'Test',country:'IT',street:'Via Test 2',city:'Example City',postalCode:'00100',province:null,email:null,phone:null,vatNumber:null,taxCode:null,sdiCode:null,notes:null}, manualVatCheck:null,lines:[],shippingPrice:null,discountPercent:0,discountShipping:null,delivery:null,notes:'',priceTier:null });
 expect(result.newClient).toMatchObject({name:'Test'});
 expect(result.newClient?.email).toBeUndefined();
 expect(result.clientId).toBeUndefined(); expect(result.shippingPrice).toBeUndefined(); expect(result.manualVatCheck).toBeUndefined();
});
