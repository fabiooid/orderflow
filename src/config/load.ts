import { readFile } from 'node:fs/promises';
import { configSchema } from './schema.js';

/** Order forms may be listed as paths (relative to the working directory) so large, private templates stay in their own files. */
export async function loadConfig(path: string) {
  const raw = JSON.parse(await readFile(path, 'utf8'));
  if (Array.isArray(raw?.orderForms)) {
    raw.orderForms = await Promise.all(raw.orderForms.map(async (form: unknown) => typeof form === 'string' ? JSON.parse(await readFile(form, 'utf8')) : form));
  }
  return configSchema.parse(raw);
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
