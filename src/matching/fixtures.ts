import type { SelectionRequest } from './types.js';

const products = [
  { id: 101, code: 'SOAP250', name: 'Orrio Sapone Mani 250 ml' },
  { id: 102, code: 'SOAP500', name: 'Orrio Sapone Mani 500 ml' },
  { id: 103, code: 'SOAP250T', name: 'TESTER Orrio Sapone Mani 250 ml' },
  { id: 104, code: 'CANDLE', name: 'Foglia di Fico Candela Profumata' },
];
const clients = [
  { id: 201, name: 'Rossi Commercio SRL', city: 'Milano', country: 'IT', vatNumber: 'IT00000000001' },
  { id: 202, name: 'Rossi Commercio SRL', city: 'Roma', country: 'IT', vatNumber: 'IT00000000002' },
];
export const matchingFixtures: { name: string; request: SelectionRequest; expected: number | 'ambiguous' | 'no-match' }[] = [
  ...[
    ['exact-code', 'SOAP500', 102],
    ['italian-description', 'sapone al orrio da 250 ml, non tester', 101],
    ['english-description', 'orrio hand soap 500 ml', 102],
    ['tester', 'tester sapone orrio 250 ml', 103],
    ['missing-size', 'sapone al orrio', 'ambiguous'],
    ['missing-product', 'shampoo alla rosa', 'no-match'],
  ].map(([name, query, expected]) => ({ name: String(name),
    request: { kind: 'product' as const, query: String(query), candidates: products,
      retrieval: { complete: true, furtherSearchPossible: false } }, expected: expected as number | 'ambiguous' | 'no-match' })),
  ...[
    ['client-city', 'Rossi Commercio di Roma', 202],
    ['client-ambiguous', 'Rossi Commercio', 'ambiguous'],
    ['client-vat', 'cliente con partita IVA IT00000000001', 201],
    ['client-conflict', 'Rossi Milano con partita IVA IT00000000002', 'no-match'],
  ].map(([name, query, expected]) => ({ name: String(name),
    request: { kind: 'client' as const, query: String(query), candidates: clients,
      retrieval: { complete: true, furtherSearchPossible: false } }, expected: expected as number | 'ambiguous' | 'no-match' })),
];
