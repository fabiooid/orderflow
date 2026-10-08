import type { z } from 'zod';

/** Provider-neutral inputs contain no Telegram IDs, order IDs or catalogue bindings. */
export type DocumentFile = { data: Uint8Array; mimeType: string };
export type DocumentTemplate = {
  id: string; name: string; headings: string[];
  columns: { id: string; heading: string; value: 'quantity' | 'mark' }[];
  rows: { code: string; label: string }[];
};
export type CellRow = { row: number; [column: string]: number | boolean | null };
export type Vision = <T extends z.ZodType>(images: Buffer[], prompt: string, schema: T) => Promise<z.infer<T>>;
export type Read = (files: DocumentFile[], contextOnly?: boolean) => Promise<string>;
export type DocumentPage = {
  source: { fileIndex: number; pageNumber: number };
  text: string;
  /** Agreement is not verified accuracy. Both raw readings are retained. */
  template?: { id: string; readings: [CellRow[], CellRow[]] };
};
export type DocumentResult = {
  provider: string;
  /** Baseline vision results always require review; no calibrated quality gate yet. */
  status: 'needs_review';
  pages: DocumentPage[];
};
export interface DocumentProvider {
  readonly id: string;
  read(files: DocumentFile[]): Promise<DocumentResult>;
}
