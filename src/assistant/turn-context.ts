import type { RequestContext } from '@mastra/core/request-context';
import type { ConfirmedChoice } from '../matching/resolver.js';
import type { DraftResult } from './drafts.js';

/** The request a turn works on. */
export type TurnRequest = { kind: 'order' | 'customer'; orderId: string; revision: number; confirmedChoices?: ConfirmedChoice[] };

/** What the application tells the tools about a turn. Absent in Studio, where no request is open. */
export type Turn = {
  request?: TurnRequest;
  /** Another open request that this turn cannot change (such as a save awaiting a check); it blocks new work. */
  locked?: string;
  /** Evidence for identity matching: the request's conversation so far and this message, with any attachment content. */
  evidence: string;
  /** The operator's own words: the only text that can teach an alias. */
  operatorWords: string;
  senderId: string;
  /** Names already in the open draft, which an alias correction may refer to. */
  knownPhrases: string[];
};

/** What the tools did, read by the application after the agent's turn. */
export type TurnOutcome = { result?: DraftResult; cancel?: boolean; refused?: boolean };

const TURN = 'orderflowTurn', OUTCOME = 'orderflowOutcome';

export function startTurn(context: RequestContext, turn: Turn) {
  const outcome: TurnOutcome = {};
  context.set(TURN, turn);
  context.set(OUTCOME, outcome);
  return outcome;
}
export const turnOf = (context?: RequestContext) => context?.get(TURN) as Turn | undefined;
/** Studio has no turn: outcomes are then discarded. */
export const outcomeOf = (context?: RequestContext) => (context?.get(OUTCOME) as TurnOutcome | undefined) ?? {};
