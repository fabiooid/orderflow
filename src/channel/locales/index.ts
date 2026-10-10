import { en } from './en.js';
import { it } from './it.js';

type ItKeys = keyof typeof it;
type EnKeys = keyof typeof en;
type SameKeys = ItKeys extends EnKeys ? (EnKeys extends ItKeys ? true : never) : never;
const _localesMatch: SameKeys = true;
void _localesMatch;

export type CopyKey = ItKeys;
export type CopyVars = Record<string, string | number>;

/** Operator-facing copy for the configured locale. Wording lives in the locale files, not at the call site. */
export function copy(locale: 'it' | 'en', key: CopyKey, vars: CopyVars = {}) {
  const template = locale === 'it' ? it[key] : en[key];
  return template.replace(/\{(\w+)\}/g, (_, name: string) => String(vars[name] ?? ''));
}
