import { createSkill } from '@mastra/core/skills';
import type { AppConfig } from '../../config/schema.js';

/** Native Mastra skill: detailed instructions are loaded on demand, not in the base prompt. */
export function customerCreationSkill(config: AppConfig) {
  return createSkill({
    name: 'customer-creation',
    description: 'Collect or correct a new customer, resolve customer identity, or collect missing customer details during an order. Use for Italian and English requests; not for catalogue-only questions.',
    instructions: `# Customer creation

## Resolve identity first

Use searchClients with the supplied name or VAT number before proposing a new record.
Preserve the exact business name, including words such as "Cliente". For example,
"Cliente Test: 5 saponi" names the client "Cliente Test".
Select clientId only when the match is clear. Ask which business when multiple matches fit.
For one clearly matching existing record, copy its returned id into clientId, keep
clientQuery as that business name, and set the entire newClient object to null.
Do not copy an existing API customer into newClient. Custom prices or discounts do
not mean the customer is new, and changes to order lines must preserve its identity.
For an order, reuse a clearly matching existing customer. In standalone customer collection,
explain an existing match rather than proposing a duplicate. The application checks again before writing.
Do not claim to update existing customer records: that capability is not connected.

## Collect and correct

Required base fields: name, street, city, postalCode and country.
Additional required fields from this deployment: ${config.clients.requiredFields.join(', ') || 'none'}.
SDI is required only for these country codes: ${config.clients.sdiCountries.join(', ') || 'none'}.
Email, phone and VAT are optional unless required above. SDI is optional outside the configured countries.
PEC is not a supported structured field. Never substitute it for email or SDI.
Use country codes expected by the supplied schema. Do not invent addresses or fiscal identifiers.
Ask only for missing required details or ambiguous information. Preserve all previously supplied
fields when applying a correction; never ask the operator to start again.
Keep billing and delivery addresses separate. For orders, put a different shipping address in
 delivery; the application currently adds it to order notes, not to the existing customer record.
An optional VAT number for customer creation does not waive an order's VAT-eligibility checks.

## Structured output

Follow the supplied extraction schema. Place new-customer details in newClient.
Keep clientQuery faithful to the supplied name or identifier, without the order items,
prices or surrounding request wording. Do not invent clientId.
Use null for unknown optional values, not empty strings or fabricated defaults.
For standalone customer creation, do not ask for products or quantities.
When the customer belongs to an order, preserve the order lines and other draft fields.

## Review and confirmation

The application validates the fields and renders the customer or order summary.
The operator may correct it in ordinary language. A correction needs a fresh confirmation.
Standalone customers are saved through the latest confirmation button or /confermacliente
(/confirmcustomer). A new customer collected within an order is handled by that order's
confirmed save process; do not promise a separate customer-creation step.
A conversational "yes" alone is not a write authorization in this integration.
Your tools cannot create records. Only report success after an application success result.
If creation is uncertain, explain that it needs checking; never suggest starting another request
or blindly retrying the write. Never send anything to the customer.
`,
  });
}
