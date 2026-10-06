import { loadConfig } from '../src/config/load.js';
import { TelegramApi } from '../src/telegram/api.js';
try {
 const config = await loadConfig(process.env.APP_CONFIG_PATH ?? 'config/example.json');
 const api = new TelegramApi(process.env.TELEGRAM_BOT_TOKEN ?? '');
 const scope = {type:'chat',chat_id:config.telegram.groupId};
 const commands = [
  {command:'cliente',description:'Inizia la creazione di un cliente'},
  {command:'ordine',description:'Prepara un ordine da controllare'},
  ...(config.orderSavingEnabled ? [{command:'confermaordine',description:'Salva ordine e ricevi PDF: rispondi al riepilogo'}] : []),
  {command:'confermacliente',description:'Conferma il cliente: rispondi al suo riepilogo'},
  {command:'annulla',description:'Annulla la richiesta non salvata'},
 ];
 await api.call('setMyCommands',{scope,commands});
 const registered=await api.call<{command:string}[]>('getMyCommands',{scope});
 if(commands.some(c=>!registered.some(r=>r.command===c.command))) throw new Error();
 console.log('Italian command menu registered and verified for the configured group.');
} catch { console.error('Command registration failed. Check Telegram access and configuration.'); process.exitCode=1; }
