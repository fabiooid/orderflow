import { loadConfig } from '../src/config/load.js';
const path = process.argv[2] ?? 'config/example.json';
try {
  const config = await loadConfig(path);
  console.log(`Configuration valid: ${config.deploymentId} / ${config.policyVersion}. Account references have not been verified.`);
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Invalid configuration');
  process.exitCode = 1;
}
