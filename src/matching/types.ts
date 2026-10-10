import { z } from 'zod';

export const selectionRequestSchema = z.object({
  kind: z.enum(['product', 'client']),
  query: z.string().trim().min(1).max(4000),
  context: z.string().max(12000).optional(),
  candidates: z.array(z.object({
    id: z.string().min(1),
    name: z.string().min(1).max(500),
    aliases: z.array(z.string().max(160)).max(500).optional(),
    code: z.string().max(200).optional(),
    description: z.string().max(4000).optional(),
    country: z.string().max(100).optional(),
    city: z.string().max(300).optional(),
    vatNumber: z.string().max(100).optional(),
  }).strict()).max(253),
  retrieval: z.object({ complete: z.boolean(), furtherSearchPossible: z.boolean() }).strict(),
}).strict().refine(r => new Set(r.candidates.map(c => c.id)).size === r.candidates.length,
  'Candidate IDs must be unique');

export type SelectionRequest = z.infer<typeof selectionRequestSchema>;
export type Candidate = SelectionRequest['candidates'][number];
export type SelectionResult = {
  status: 'matched' | 'ambiguous' | 'no-match' | 'unavailable';
  /** This is a read-only judgment, not permission to mutate a draft or learn an alias. */
  selectedId?: string;
  clarificationIds?: string[];
  reason?: 'disabled' | 'incomplete-retrieval' | 'invalid-input' | 'invalid-response' | 'service-unavailable';
  evidence: {
    strategy?: string;
    groups?: { candidateCount: number; candidateHash: string; reason?: string; status: SelectionResult['status']; selectedId?: string; evidence: Pick<SelectionResult['evidence'], 'requestHash' | 'promptVersion' | 'model' | 'elapsedMs'> }[];
    requestHash: string;
    promptVersion: string;
    model?: string;
    confidence?: number;
    probabilities?: Record<string, number>;
    usage?: { input_tokens: number; output_tokens: number };
    retrieval: SelectionRequest['retrieval'];
    elapsedMs: number;
  };
};
