import sharp from 'sharp';
import { renderPdfPages } from './pdf-pages.js';
import type { DocumentFile, DocumentProvider, DocumentPage, Read, CellRow } from './contract.js';

const MAX_BYTES = 20 * 1024 * 1024;
const MAX_PAGES = 10;
const MAX_PIXELS = 40_000_000;
export type TemplatePageReader = (page: Buffer) => Promise<{
  image: Buffer; template?: { id: string; readings: [CellRow[], CellRow[]] };
}>;

/** Validate every file before model calls. Content, not the supplied MIME label, selects decoding. */
export async function documentPages(files: DocumentFile[]) {
  const pages: { source: DocumentPage['source']; image: Buffer }[] = [];
  for (const [fileIndex, file] of files.entries()) {
    if (!file.data.byteLength || file.data.byteLength > MAX_BYTES) throw new Error('Invalid document size');
    const bytes = Buffer.from(file.data);
    let images: Buffer[];
    if (bytes.subarray(0, 5).toString() === '%PDF-') {
      images = await renderPdfPages(bytes);
    } else {
      const metadata = await sharp(bytes, { limitInputPixels: MAX_PIXELS }).metadata();
      if (!['jpeg', 'png', 'webp', 'gif', 'tiff'].includes(metadata.format ?? '')) throw new Error('Unsupported document format');
      const count = metadata.pages ?? 1;
      if (pages.length + count > MAX_PAGES) throw new Error('Too many document pages');
      if (count > 1 && metadata.format !== 'tiff') throw new Error('Animated images are not supported');
      images = [];
      for (let page = 0; page < count; page++) {
        images.push(await sharp(bytes, { page, pages: 1, limitInputPixels: MAX_PIXELS }).rotate().png().toBuffer());
      }
    }
    if (pages.length + images.length > MAX_PAGES) throw new Error('Too many document pages');
    images.forEach((image, index) => pages.push({ source: { fileIndex, pageNumber: index + 1 }, image }));
  }
  return pages;
}

/** Existing direct-vision baseline behind a replaceable document provider. No business or transport dependencies. */
export function createVisionDocumentProvider(ports: { read: Read; templates?: TemplatePageReader }): DocumentProvider {
  return {
    id: 'direct-vision-v1',
    async read(files) {
      const normalized = await documentPages(files);
      const pages: DocumentPage[] = [];
      for (const page of normalized) {
        const identified = ports.templates ? await ports.templates(page.image) : { image: page.image };
        const text = await ports.read([{ data: identified.image, mimeType: 'image/png' }], !!identified.template);
        pages.push({ source: page.source, text, ...(identified.template ? { template: identified.template } : {}) });
      }
      return { provider: this.id, status: 'needs_review', pages };
    },
  };
}
