import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Core folders must not import a specific channel or invoicing adapter. */
const roots = ['src/domain', 'src/assistant', 'src/documents', 'src/channel'];
const forbidden = [
  /channels\/telegram/,
  /\/telegram\//,
  /connector\/fatture-in-cloud/,
  /@fattureincloud\//,
  /node-telegram-bot-api/,
];

async function files(dir: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...await files(path));
    else if (entry.name.endsWith('.ts')) found.push(path);
  }
  return found;
}

const hits: string[] = [];
for (const root of roots) {
  for (const file of await files(root)) {
    const text = await readFile(file, 'utf8');
    for (const rule of forbidden) {
      if (rule.test(text)) hits.push(`${file} matches ${rule}`);
    }
  }
}
if (hits.length) {
  console.error(hits.join('\n'));
  process.exit(1);
}
console.log('Import boundaries hold.');
