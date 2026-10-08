import { existsSync, readFileSync } from 'node:fs';
import { access, readFile } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { configSchema } from './schema.js';

function orderflowRoot(start: string) {
  let dir = start;
  while (true) {
    const pkg = resolve(dir, 'package.json');
    if (existsSync(pkg)) {
      try {
        if (JSON.parse(readFileSync(pkg, 'utf8')).name === 'orderflow') return dir;
      } catch { /* keep walking */ }
    }
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/** Studio's working directory is src/mastra/public, so try the project root when a relative path is missing. */
async function orderFormFile(form: string) {
  if (isAbsolute(form)) return form;
  try {
    await access(form);
    return form;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const root = orderflowRoot(process.env.MASTRA_PROJECT_ROOT ?? process.cwd());
  return root ? resolve(root, form) : form;
}

/** Order forms may be listed as paths so large, private templates stay in their own files. */
export async function loadConfig(path: string) {
  const raw = JSON.parse(await readFile(path, 'utf8'));
  if (Array.isArray(raw?.orderForms)) {
    raw.orderForms = await Promise.all(raw.orderForms.map(async (form: unknown) => typeof form === 'string' ? JSON.parse(await readFile(await orderFormFile(form), 'utf8')) : form));
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
