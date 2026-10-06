import { readFile } from 'node:fs/promises';
import { configSchema } from './schema.js';

export async function loadConfig(path: string) {
  return configSchema.parse(JSON.parse(await readFile(path, 'utf8')));
}

export function loadAppConfig(env: NodeJS.ProcessEnv = process.env) {
  return loadConfig(env.APP_CONFIG_PATH ?? 'config/example.json');
}

export type ConnectorMode = 'demo' | 'read-only';
export function connectorMode(env: NodeJS.ProcessEnv = process.env): ConnectorMode {
  const mode = env.CONNECTOR_MODE ?? 'demo';
  if (mode !== 'demo' && mode !== 'read-only') throw new Error('CONNECTOR_MODE supports demo or read-only only');
  return mode;
}
