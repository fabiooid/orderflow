import { readFile } from 'node:fs/promises';
import { configSchema } from './schema.js';

export async function loadConfig(path: string) {
  return configSchema.parse(JSON.parse(await readFile(path, 'utf8')));
}
