import { execFileSync } from 'node:child_process';
import { expect, it } from 'vitest';

it('keeps channel and invoicing adapters out of core folders', () => {
  expect(() => execFileSync('node', ['--import', 'tsx', 'scripts/check-boundaries.ts'], { encoding: 'utf8' })).not.toThrow();
});
