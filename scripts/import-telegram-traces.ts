import { LibSQLStore } from '@mastra/libsql';
import { connectorMode, loadAppConfig } from '../src/config/load.js';
import { TELEGRAM_STATE_URL, TelegramStore, telegramMemoryUrl, telegramScopePrefix } from '../src/channel/store.js';
import { telegramTraces } from '../src/channels/telegram/traces.js';
const config=await loadAppConfig();
const mode=connectorMode();
const storage=new LibSQLStore({id:'telegram-history',url:telegramMemoryUrl(config,mode)});
const journal=new TelegramStore(TELEGRAM_STATE_URL,'');
const traces=telegramTraces(storage);
try {
 const rows=(await journal.db.execute('SELECT DISTINCT scope FROM tg_updates')).rows;
 let count=0;
 for(const row of rows){const scope=String(row.scope);if(!scope.startsWith(telegramScopePrefix(config,mode)))continue;
 const store=new TelegramStore(TELEGRAM_STATE_URL,scope);try{count+=await traces.sync(store);}finally{store.close();}}
 console.log(`Imported ${count} Telegram transport records. Existing model traces preserved. No remote calls made.`);
} finally {await traces.shutdown();journal.close();await storage.close();}
