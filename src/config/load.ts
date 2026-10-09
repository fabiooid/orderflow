import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { configSchema } from './schema.js';

/** Order forms may be listed as paths so large, private templates stay in their own files. */
export async function loadConfig(path: string, projectRoot = process.cwd()) {
  const raw = JSON.parse(await readFile(resolve(projectRoot, path), 'utf8'));
  if (Array.isArray(raw?.orderForms)) {
    raw.orderForms = await Promise.all(raw.orderForms.map(async (form: unknown) => typeof form === 'string' ? JSON.parse(await readFile(resolve(projectRoot, form), 'utf8')) : form));
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
