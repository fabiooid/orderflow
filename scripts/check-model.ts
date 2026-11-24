import { Agent } from '@mastra/core/agent';
import { loadAppConfig } from '../src/config/load.js';
try {
  const config = await loadAppConfig();
  // The chat model, and the reader model when it differs.
  for (const model of new Set([config.model, config.readerModel ?? config.model])) {
    const agent = new Agent({ id: 'connection-probe', name: 'Connection probe', model, instructions: 'Reply exactly OK.' });
    const response = await agent.generate('Connection test', { maxSteps: 1, modelSettings: { maxOutputTokens: 2048, maxRetries: 0 } });
    if (!response.text.trim()) throw new Error();
    console.log(`PASS | ${model} responded. This checks connectivity, not order accuracy. Provider usage may be billed.`);
  }
} catch { console.error('FAIL | Model connection failed. Check configured model, provider key, credits and network.'); process.exitCode = 1; }
