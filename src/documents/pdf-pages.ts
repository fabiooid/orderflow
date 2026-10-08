/** Render page composition, not embedded images: text, rotations and overlays matter. */
export async function renderPdfPages(bytes: Uint8Array): Promise<Buffer[]> {
  if (bytes.byteLength > 20 * 1024 * 1024) throw new Error('PDF exceeds size limit');
  const { createCanvas } = await import('@napi-rs/canvas');
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = getDocument({ data: new Uint8Array(bytes), useSystemFonts: true, stopAtErrors: true });
  try {
    const pdf = await task.promise;
    if (pdf.numPages > 10) throw new Error('PDF exceeds ten-page limit');
    const pages: Buffer[] = [];
    for (let number = 1; number <= pdf.numPages; number++) {
      const page = await pdf.getPage(number);
      const original = page.getViewport({ scale: 1 });
      if (!Number.isFinite(original.width * original.height) || Math.min(original.width, original.height) <= 0) throw new Error('Invalid PDF page dimensions');
      const viewport = page.getViewport({ scale: Math.min(2, 2400 / Math.max(original.width, original.height)) });
      const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
      await page.render({ canvas: canvas as unknown as HTMLCanvasElement, viewport }).promise;
      pages.push(canvas.toBuffer('image/png'));
      page.cleanup();
    }
    return pages;
  } finally { await task.destroy(); }
}
