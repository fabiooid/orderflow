import { z } from 'zod';
import { createStep, createWorkflow, type AnyWorkflow } from '@mastra/core/workflows';
import { tracingContext } from '../assistant/execution-trace.js';
import { enlarged, identify, readCells } from './templates.js';
import type { DocumentTemplate, Vision, CellRow } from './contract.js';
import type { TemplatePageReader } from './reader.js';

const bytes = z.custom<Buffer>(Buffer.isBuffer);
const rows = z.array(z.record(z.string(), z.union([z.number(), z.boolean(), z.null()])));

/** Generic traced page reading: business configuration never crosses this boundary. */
export function createDocumentWorkflow(templates: DocumentTemplate[], vision: Vision) {
  const identified = z.object({ image: bytes, templateId: z.string().nullable() });
  const identifyStep = createStep({
    id: 'identify', inputSchema: z.object({ page: bytes }), outputSchema: identified,
    execute: async ({ inputData }) => {
      const { image, form } = await identify(inputData.page, templates, vision);
      return { image, templateId: form?.id ?? null };
    },
  });
  const reading = (id: string) => createStep({
    id, inputSchema: identified, outputSchema: rows,
    execute: async ({ inputData }) => {
      const template = templates.find(t => t.id === inputData.templateId);
      return template ? readCells(await enlarged(inputData.image), template, vision) : [];
    },
  });
  const collect = createStep({
    id: 'collect', inputSchema: z.record(z.string(), rows),
    outputSchema: z.object({ image: bytes, templateId: z.string().nullable(), readings: z.tuple([rows, rows]) }),
    execute: async ({ inputData, getStepResult }) => ({
      ...getStepResult(identifyStep), readings: [inputData['read-1']!, inputData['read-2']!] as [CellRow[], CellRow[]],
    }),
  });
  return createWorkflow({ id: 'read-document-page', inputSchema: z.object({ page: bytes }), outputSchema: collect.outputSchema, options: { shouldPersistSnapshot: () => false } })
    .then(identifyStep).parallel([reading('read-1'), reading('read-2')]).then(collect).commit();
}

export function workflowTemplatePages(workflow: AnyWorkflow): TemplatePageReader {
  return async page => {
    const result = await (await workflow.createRun()).start({ tracingContext: tracingContext(), inputData: { page } });
    if (result.status !== 'success') throw new Error('Document page reading failed');
    const { image, templateId, readings } = result.result as { image: Buffer; templateId: string | null; readings: [CellRow[], CellRow[]] };
    return { image, ...(templateId ? { template: { id: templateId, readings } } : {}) };
  };
}

export function directTemplatePages(templates: DocumentTemplate[], vision: Vision): TemplatePageReader {
  return async page => {
    const { image, form } = await identify(page, templates, vision);
    if (!form) return { image };
    const enlargedPage = await enlarged(image);
    const readings = await Promise.all([readCells(enlargedPage, form, vision), readCells(enlargedPage, form, vision)]);
    return { image, template: { id: form.id, readings } };
  };
}
