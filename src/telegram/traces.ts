import { createHash } from 'node:crypto';
import { Mastra } from '@mastra/core';
import { SpanType } from '@mastra/core/observability';
import { Observability, MastraStorageExporter } from '@mastra/observability';
import type { LibSQLStore } from '@mastra/libsql';
import type { TelegramStore } from './store.js';

/** Rebuildable transport records, distinct from actual model execution traces. */
export function telegramTraces(storage: LibSQLStore) {
 const observability = new Observability({configs:{default:{serviceName:'orderflow-telegram-messages',exporters:[new MastraStorageExporter()]}}});
 new Mastra({storage,observability});
 const synced = new Map<number, string>();
 return {
  async sync(store: TelegramStore) {
   const rows = (await store.db.execute({sql:'SELECT id,plan,sending,done FROM tg_updates WHERE scope=?',args:[store.scope]})).rows;
   for(const row of rows) {
    const signature=JSON.stringify(row);
    if(synced.get(Number(row.id))===signature) continue;
    const plan=JSON.parse(String(row.plan));
    const digest=createHash('sha256').update(`${store.scope}:${row.id}`).digest('hex');
    const span=observability.getDefaultInstance()!.startSpan({name:plan.receivedAt ? 'Telegram message' : 'Telegram history (imported)',type:SpanType.GENERIC,traceId:digest.slice(0,32),spanId:digest.slice(32,48),startTime:plan.receivedAt ? new Date(plan.receivedAt) : undefined,tags:['telegram',plan.receivedAt?'message':'historical-import'],input:plan.incomingText ?? {unavailable:'Original input was not retained in the transport journal'},metadata:{updateId:Number(row.id),replyTo:plan.replyTo,conversationId:plan.order?.orderId,revision:plan.order?.revision,imported:!plan.receivedAt,timing:plan.receivedAt?'message processing':'Import time; original timing unavailable'}});
    synced.set(Number(row.id),signature);
    span.end({output:{replies:plan.texts,delivery:row.done?'delivered':row.sending?'uncertain':'pending',note:'Transport record; model executions are separate traces.'}});
   }
   await observability.flush();
   return rows.length;
  },
  shutdown:()=>observability.shutdown(),
 };
}
