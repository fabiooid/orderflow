import { conversationCases, evalConnector } from '../src/evals/conversations.js';
import { runEvals } from '../src/evals/harness.js';

await runEvals('Conversations', conversationCases, evalConnector);
