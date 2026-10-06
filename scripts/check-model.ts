import { Agent } from '@mastra/core/agent';
import { loadConfig } from '../src/config/load.js';
try {
  const config = await loadConfig(process.env.APP_CONFIG_PATH ?? 'config/example.json');
  const agent = new Agent({ id: 'connection-probe', name: 'Connection probe', model: config.model, instructions: 'Reply exactly OK.' });
  const response = await agent.generate('Connection test', { maxSteps: 1, modelSettings: { maxOutputTokens: 2048, maxRetries: 0 } });
  if (!response.text.trim()) throw new Error();
  console.log('PASS | Configured model responded. This checks connectivity, not order accuracy. Provider usage may be billed.');
} catch { console.error('FAIL | Model connection failed. Check configured model, provider key, credits and network.'); process.exitCode = 1; }
