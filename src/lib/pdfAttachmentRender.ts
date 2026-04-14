import { GlobalWorkerOptions, getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import workerSrc from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url';
import type { NoteAttachment } from '../types';

GlobalWorkerOptions.workerSrc = workerSrc;

export type PdfExportAttachment = {
  id: string;
  name: string;
  type: 'image' | 'pdf';
  mimeType: string;
  size: number;
  renderedImages: string[];
  pageCount: number;
};

const MAX_RENDER_WIDTH = 1200;

const dataUrlToUint8Array = (dataUrl: string) => {
  const encoded = dataUrl.split(',')[1] ?? '';
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return bytes;
};

const renderPdfAttachment = async (attachment: NoteAttachment): Promise<PdfExportAttachment> => {
  const loadingTask = getDocument({
    data: dataUrlToUint8Array(attachment.dataUrl),
    useSystemFonts: true,
  });

  const documentProxy = await loadingTask.promise;
  const renderedImages: string[] = [];

  try {
    for (let pageNumber = 1; pageNumber <= documentProxy.numPages; pageNumber += 1) {
      const page = await documentProxy.getPage(pageNumber);
      const baseViewport = page.getViewport({ scale: 1 });
      const scale = Math.min(2, MAX_RENDER_WIDTH / baseViewport.width);
      const viewport = page.getViewport({ scale: Math.max(scale, 1) });
      const canvas = document.createElement('canvas');
      const context = canvas.getContext('2d', { alpha: false });

      if (!context) {
        throw new Error('PDF sayfasi cizim alani olusturulamadi.');
      }

      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);

      await page.render({
        canvas,
        canvasContext: context,
        viewport,
      }).promise;

      renderedImages.push(canvas.toDataURL('image/png'));
      page.cleanup();
      canvas.width = 0;
      canvas.height = 0;
    }
  } finally {
    await loadingTask.destroy();
  }

  return {
    id: attachment.id,
    name: attachment.name,
    type: 'pdf',
    mimeType: attachment.mimeType,
    size: attachment.size,
    renderedImages,
    pageCount: documentProxy.numPages,
  };
};

export const renderAttachmentsForPdfExport = async (
  attachments: NoteAttachment[],
): Promise<PdfExportAttachment[]> => {
  const results: PdfExportAttachment[] = [];

  for (const attachment of attachments) {
    if (attachment.type === 'image') {
      results.push({
        id: attachment.id,
        name: attachment.name,
        type: 'image',
        mimeType: attachment.mimeType,
        size: attachment.size,
        renderedImages: [attachment.dataUrl],
        pageCount: 1,
      });
      continue;
    }

    results.push(await renderPdfAttachment(attachment));
  }

  return results;
};
