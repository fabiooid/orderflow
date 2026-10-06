import { loadConfig } from '../src/config/load.js';
import { checkConnections } from '../src/health/check.js';
import { liveHealthPorts } from '../src/health/ports.js';
try {
  const config = await loadConfig(process.env.APP_CONFIG_PATH ?? 'config/example.json');
  const missing = ['TELEGRAM_BOT_TOKEN', 'FIC_ACCESS_TOKEN'].filter(key => !process.env[key]);
  if (missing.length) console.log(`FAIL | Missing local credentials: ${missing.join(', ')}. Add them to .env; do not paste them in chat.`);
  const report = await checkConnections(config, liveHealthPorts(config, process.env));
  for (const check of report) console.log(`${check.status.toUpperCase()} | ${check.name}: ${check.detail}`);
  console.log('Read-only check complete. Manual items are not verified; no orders or messages were created.');
  if (report.some(c => c.status === 'fail')) process.exitCode = 1;
} catch { console.error('Connection check could not start. Validate APP_CONFIG_PATH with config:check.'); process.exitCode = 1; }
