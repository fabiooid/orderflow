import { DemoConnector } from '../src/connector/demo.js';
import { acceptanceCases } from '../src/evals/acceptance.js';
import { runEvals } from '../src/evals/harness.js';

await runEvals('Acceptance', acceptanceCases, () => new DemoConnector());
