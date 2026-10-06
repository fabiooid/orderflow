import { LibSQLStore } from '@mastra/libsql';
import { loadConfig } from '../src/config/load.js';
import { TelegramStore } from '../src/telegram/store.js';
import { telegramTraces } from '../src/telegram/traces.js';
const config=await loadConfig(process.env.APP_CONFIG_PATH ?? 'config/example.json');
const mode=process.env.CONNECTOR_MODE ?? 'demo';
if(!['demo','read-only'].includes(mode)) throw new Error('Invalid mode');
const storage=new LibSQLStore({id:'telegram-history',url:`file:.data/telegram-${config.deploymentId}-${mode}.db`});
const journal=new TelegramStore('file:.data/telegram.db','');
const traces=telegramTraces(storage);
try {
 const rows=(await journal.db.execute('SELECT DISTINCT scope FROM tg_updates')).rows;
 let count=0;
 for(const row of rows){const scope=String(row.scope);if(!scope.startsWith(`${config.deploymentId}:${config.telegram.groupId}:${mode}:`))continue;
 const store=new TelegramStore('file:.data/telegram.db',scope);try{count+=await traces.sync(store);}finally{store.close();}}
 console.log(`Imported ${count} Telegram transport records. Existing model traces preserved. No remote calls made.`);
} finally {await traces.shutdown();journal.close();await storage.close();}
