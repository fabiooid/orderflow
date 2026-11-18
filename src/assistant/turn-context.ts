import type { RequestContext } from '@mastra/core/request-context';
import type { ConfirmedChoice, PendingQuestion, SearchEvidence } from '../matching/resolver.js';
import type { OrderDraft } from '../domain/types.js';
import type { DraftResult } from './drafts.js';
import type { ReadingLine } from '../documents/product-lines.js';

/** The request a turn works on. `draft` is the canonical open draft for this request. */
export type TurnRequest = {
  kind: 'order' | 'customer';
  orderId: string;
  revision: number;
  confirmedChoices?: ConfirmedChoice[];
  draft: OrderDraft;
  pendingQuestion?: PendingQuestion;
  searchEvidence?: SearchEvidence[];
  operatorWords?: string;
  attachmentText?: string;
};

/** What the application tells the tools about a turn. Absent in Studio, where no request is open. */
export type Turn = {
  request?: TurnRequest;
  locked?: string;
  evidence: string;
  operatorWords: string;
  turnWords: string;
  attachmentText?: string;
  attachmentLines?: ReadingLine[];
  senderId: string;
  knownPhrases: string[];
  searchEvidence: SearchEvidence[];
};

/** What the tools did, read by the application after the agent's turn. */
export type TurnOutcome = { result?: DraftResult; cancel?: boolean; refused?: boolean };

const TURN = 'orderflowTurn', OUTCOME = 'orderflowOutcome';

export function startTurn(context: RequestContext, turn: Omit<Turn, 'searchEvidence' | 'turnWords'> & Partial<Pick<Turn, 'searchEvidence' | 'turnWords'>>) {
  const outcome: TurnOutcome = {};
  const live = Object.assign(turn, { searchEvidence: turn.searchEvidence ?? [], turnWords: turn.turnWords ?? turn.operatorWords });
  context.set(TURN, live);
  context.set(OUTCOME, outcome);
  return outcome;
}
export const turnOf = (context?: RequestContext) => context?.get(TURN) as Turn | undefined;
export const outcomeOf = (context?: RequestContext) => (context?.get(OUTCOME) as TurnOutcome | undefined) ?? {};

export function recordSearch(context: RequestContext | undefined, evidence: SearchEvidence) {
  const turn = turnOf(context);
  if (!turn) return;
  turn.searchEvidence = [...(turn.searchEvidence ?? []).filter(item => !(item.kind === evidence.kind && item.query === evidence.query)), evidence].slice(-20);
}
