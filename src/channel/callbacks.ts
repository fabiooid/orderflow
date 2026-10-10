import type { OrderLink } from './contract.js';

const callbackActions = { save: 'confirmOrder', customer: 'confirmCustomer', review: 'review', cancel: 'cancel', cancelall: 'cancelAll' } as const;

/** What a button press is recorded as in the conversation: the button's own label. */
export const callbackLabels = { save: '✅ Conferma e salva', customer: '✅ Conferma e salva', review: '👀 Controllato', cancel: '❌ Annulla', cancelall: '🗑 Annulla tutte' } as const;

export const callbackData = (action: keyof typeof callbackActions, link: OrderLink) => `${action}:${link.orderId}:${link.revision}`;

/** A candidate button under a draft: the request revision, the field it settles and the record picked. */
export const pickData = (link: OrderLink, field: string, id: string) => `pick:${link.orderId}:${link.revision}:${field}:${id}`;

/** Buttons under a prompt for media that did not say what to do with it. */
export const mediaCallbackData = (message: number, accept: boolean) => `media:${message}:${accept ? 'y' : 'n'}`;

export { callbackActions };
