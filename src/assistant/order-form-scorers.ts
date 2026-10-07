import { createScorer } from '@mastra/core/evals';
import type { FormLine } from '../telegram/order-forms.js';

/** Expected order for one page: product ID → quantity. */
type Expected = Record<string, number>;
type Output = { lines?: FormLine[] };

function compare(output: Output | undefined, expected: Expected | undefined) {
  const sure = (output?.lines ?? []).filter(l => l.kind === 'sure');
  const wrong = sure.filter(l => expected?.[l.productId] !== l.quantity);
  const right = Object.entries(expected ?? {}).filter(([id, quantity]) => sure.some(l => l.productId === Number(id) && l.quantity === quantity));
  const questions = (output?.lines ?? []).length - sure.length;
  return { sure, wrong, right, questions };
}

/** Deterministic Mastra scorers for the `read-order-form` workflow against a known order; no judge-model spend. */
export const orderFormScorers = {
  /** Share of lines read as certain that are right. Anything below 1 is a wrong quantity nobody would be asked about. */
  noSilentErrors: createScorer<unknown, Output>({ id: 'order-form-no-silent-errors', name: 'Order form: no silent errors', description: 'Lines read as certain match the expected order' })
    .generateScore(({ run }) => {
      const { sure, wrong } = compare(run.output, run.groundTruth);
      return sure.length ? 1 - wrong.length / sure.length : 1;
    })
    .generateReason(({ run }) => {
      const { wrong, questions } = compare(run.output, run.groundTruth);
      return `${wrong.length ? `Wrong: ${wrong.map(l => `${l.productId}×${l.kind === 'sure' ? l.quantity : '?'} (expected ${run.groundTruth?.[l.productId] ?? 0})`).join(', ')}.` : 'No wrong certain lines.'} ${questions} question(s).`;
    }),
  /** Share of the expected order read correctly as certain; the rest became questions or was missed. */
  coverage: createScorer<unknown, Output>({ id: 'order-form-coverage', name: 'Order form: coverage', description: 'Expected lines read correctly without a question' })
    .generateScore(({ run }) => {
      const total = Object.keys(run.groundTruth ?? {}).length;
      return total ? compare(run.output, run.groundTruth).right.length / total : 1;
    }),
};
