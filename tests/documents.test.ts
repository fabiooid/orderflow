import sharp from 'sharp';
import { describe, expect, it, vi } from 'vitest';
import { createVisionDocumentProvider, documentPages } from '../src/documents/reader.js';
import { createDocumentWorkflow, workflowTemplatePages } from '../src/documents/workflow.js';
import type { DocumentTemplate, Vision } from '../src/documents/contract.js';
import { documentForms, documentTemplates } from '../src/telegram/order-forms.js';
import { createMediaReader } from '../src/telegram/media.js';
import { DemoConnector } from '../src/connector/demo.js';
import { config } from './helpers.js';
import { mixedPdf } from './pdf-fixture.js';

const image = () => sharp({ create: { width: 40, height: 30, channels: 3, background: 'white' } }).jpeg().toBuffer();
const template: DocumentTemplate = { id: 'test', name: 'Test', headings: ['Quantity'], columns: [{ id: 'qty', heading: 'Quantity', value: 'quantity' }], rows: [{ code: 'A', label: 'Item A' }] };

describe('document service boundary', () => {
  it('normalizes content independently of MIME hints and retains file/page provenance', async () => {
    const read = vi.fn(async () => 'observed text');
    const result = await createVisionDocumentProvider({ read }).read([
      { data: await image(), mimeType: 'application/pdf' },
      { data: mixedPdf(), mimeType: 'image/png' },
    ]);
    expect(result.status).toBe('needs_review');
    expect(result.pages.map(p => p.source)).toEqual([
      { fileIndex: 0, pageNumber: 1 }, { fileIndex: 1, pageNumber: 1 }, { fileIndex: 1, pageNumber: 2 },
    ]);
    expect(read).toHaveBeenCalledTimes(3);
    for (const [files] of read.mock.calls as unknown as [{ data: Buffer; mimeType: string }[]][]) {
      expect(files[0]!.mimeType).toBe('image/png');
      expect((await sharp(files[0]!.data).metadata()).format).toBe('png');
    }
  });

  it('enforces aggregate limits and rejects invalid files before any provider call', async () => {
    const read = vi.fn(async () => 'text');
    const provider = createVisionDocumentProvider({ read });
    await expect(provider.read([{ data: mixedPdf(11), mimeType: 'application/pdf' }])).rejects.toThrow('ten-page');
    await expect(provider.read([{ data: mixedPdf(6), mimeType: 'application/pdf' }, { data: mixedPdf(5), mimeType: 'application/pdf' }])).rejects.toThrow('Too many');
    await expect(provider.read([{ data: await image(), mimeType: 'image/jpeg' }, { data: Buffer.from('not an image'), mimeType: 'image/png' }])).rejects.toThrow();
    await expect(provider.read([{ data: Buffer.alloc(20 * 1024 * 1024 + 1), mimeType: 'image/png' }])).rejects.toThrow('size');
    expect(read).not.toHaveBeenCalled();
  });

  it('reads all TIFF pages and refuses animated GIFs', async () => {
    const pixels = Buffer.alloc(20 * 40 * 3, 255);
    pixels.fill(0, 20 * 20 * 3);
    const input = { raw: { width: 20, height: 40, channels: 3 as const, pageHeight: 20 } };
    const tiff = await sharp(pixels, input).tiff().toBuffer();
    const pages = await documentPages([{ data: tiff, mimeType: 'image/tiff' }]);
    expect(pages).toHaveLength(2);
    expect((await sharp(pages[1]!.image).metadata()).height).toBe(20);
    const gif = await sharp(pixels, input).gif().toBuffer();
    await expect(documentPages([{ data: gif, mimeType: 'image/gif' }])).rejects.toThrow('Animated');
  });

  it('retains two raw readings through the traced workflow, mapping products only afterwards', async () => {
    const form = { ...template, schemaVersion: 1 as const, rows: [{ ...template.rows[0]!, cells: { qty: { productId: 101 } } }] };
    const templates = documentTemplates([form]);
    expect(JSON.stringify(templates)).not.toContain('productId');
    let calls = 0;
    const vision = (async (_images: Buffer[], prompt: string) => prompt.startsWith('Printed text')
      ? { textTop: 'top', form: 'test' }
      : { rows: [{ row: 1, qty: ++calls === 1 ? 3 : 8 }] }) as Vision;
    const provider = createVisionDocumentProvider({
      read: async () => 'Customer notes',
      templates: workflowTemplatePages(createDocumentWorkflow(templates, vision)),
    });
    const result = await provider.read([{ data: await image(), mimeType: 'image/jpeg' }]);
    expect(result.pages[0]!.template).toEqual({ id: 'test', readings: expect.arrayContaining([[{ row: 1, qty: 3 }], [{ row: 1, qty: 8 }]]) });
    expect(JSON.stringify(result)).not.toContain('productId');
    expect(documentForms(result, [form])[0]!.lines).toEqual([{ kind: 'unsure', productId: 101, readings: expect.arrayContaining([3, 8]) }]);
  });

  it('accepts a replacement provider without accessing the catalogue for general documents', async () => {
    const connector = new DemoConnector();
    const products = vi.spyOn(connector, 'listProducts');
    const read = vi.fn(async () => ({ provider: 'fake-ocr', status: 'needs_review' as const, pages: [{ source: { fileIndex: 0, pageNumber: 1 }, text: 'two soaps' }] }));
    const media = createMediaReader(config(), connector, async () => new Uint8Array([1]), { documents: { id: 'fake-ocr', read } });
    const result = await media({ updateId: 1, messageId: 1, groupId: config().telegram.groupId, senderId: '1', text: '', attachments: [{ kind: 'image', mimeType: 'image/png', fileId: 'example' }] });
    expect(result.text).toContain('two soaps');
    expect(read).toHaveBeenCalledTimes(1);
    expect(products).not.toHaveBeenCalled();
  });
});
