import { PDFDocument } from 'pdf-lib';
import { Capacitor } from '@capacitor/core';
import { createNoteAttachmentFromFile } from './noteAttachments';

const MAX_IMAGE_EDGE = 1600;
const MAX_IMAGES_PER_PDF = 5;
const MAX_PDF_BYTES = 3 * 1024 * 1024;
const A4_WIDTH = 595.28;
const A4_HEIGHT = 841.89;
const PAGE_MARGIN = 28;
const JPEG_QUALITY = 0.72;

const sanitizePdfFileName = (value: string) => {
  const normalized = value
    .trim()
    .replace(/[<>:"/\\|?*\x00-\x1F]+/g, '_')
    .replace(/\s+/g, '_')
    .slice(0, 48);

  return `${normalized || 'mobil_foto_notu'}.pdf`;
};

const getUniqueValues = (values: string[]) => (
  values.filter((value, index, items) => !!value && items.indexOf(value) === index)
);

const readBlobFromUri = async (uri: string) => {
  const candidateUris = getUniqueValues([
    Capacitor.convertFileSrc(uri),
    uri,
  ]);

  for (const candidateUri of candidateUris) {
    try {
      const response = await fetch(candidateUri);
      if (!response.ok) {
        continue;
      }

      return await response.blob();
    } catch {
      // Try the next source.
    }
  }

  throw new Error('Taranan PDF dosyasina ulasilamadi.');
};

const loadImageFromFile = (file: File) => new Promise<HTMLImageElement>((resolve, reject) => {
  const objectUrl = URL.createObjectURL(file);
  const image = new Image();

  image.onload = () => {
    URL.revokeObjectURL(objectUrl);
    resolve(image);
  };

  image.onerror = () => {
    URL.revokeObjectURL(objectUrl);
    reject(new Error(`${file.name} gorseli okunamadi.`));
  };

  image.src = objectUrl;
});

const renderImageForPdf = async (file: File) => {
  const image = await loadImageFromFile(file);
  const longestEdge = Math.max(image.naturalWidth, image.naturalHeight, 1);
  const scale = Math.min(1, MAX_IMAGE_EDGE / longestEdge);
  const width = Math.max(1, Math.round(image.naturalWidth * scale));
  const height = Math.max(1, Math.round(image.naturalHeight * scale));
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d');

  if (!context) {
    throw new Error('Fotoğraf PDF icin hazirlanamadi.');
  }

  canvas.width = width;
  canvas.height = height;
  context.fillStyle = '#FFFFFF';
  context.fillRect(0, 0, width, height);
  context.drawImage(image, 0, 0, width, height);

  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((nextBlob) => {
      if (nextBlob) {
        resolve(nextBlob);
        return;
      }

      reject(new Error(`${file.name} JPEG formatina donusturulemedi.`));
    }, 'image/jpeg', JPEG_QUALITY);
  });

  return {
    bytes: new Uint8Array(await blob.arrayBuffer()),
    width,
    height,
  };
};

export const createPdfAttachmentFromImages = async (files: File[], baseFileName: string) => {
  const imageFiles = files.filter((file) => file.type.startsWith('image/'));

  if (imageFiles.length === 0) {
    throw new Error('PDF olusturmak icin en az bir fotograf secin.');
  }

  if (imageFiles.length > MAX_IMAGES_PER_PDF) {
    throw new Error(`Tek seferde en fazla ${MAX_IMAGES_PER_PDF} fotograf secilebilir.`);
  }

  const pdfDocument = await PDFDocument.create();

  for (const file of imageFiles) {
    const renderedImage = await renderImageForPdf(file);
    const embeddedImage = await pdfDocument.embedJpg(renderedImage.bytes);
    const page = pdfDocument.addPage([A4_WIDTH, A4_HEIGHT]);
    const maxWidth = A4_WIDTH - PAGE_MARGIN * 2;
    const maxHeight = A4_HEIGHT - PAGE_MARGIN * 2;
    const scale = Math.min(maxWidth / renderedImage.width, maxHeight / renderedImage.height);
    const drawWidth = renderedImage.width * scale;
    const drawHeight = renderedImage.height * scale;

    page.drawImage(embeddedImage, {
      x: (A4_WIDTH - drawWidth) / 2,
      y: (A4_HEIGHT - drawHeight) / 2,
      width: drawWidth,
      height: drawHeight,
    });
  }

  const pdfBytes = await pdfDocument.save();
  if (pdfBytes.length > MAX_PDF_BYTES) {
    throw new Error('PDF cok buyuk oldu. Daha az fotograf secin veya tek tek ekleyin.');
  }

  const pdfFile = new File(
    [pdfBytes],
    sanitizePdfFileName(baseFileName),
    { type: 'application/pdf', lastModified: Date.now() },
  );

  return createNoteAttachmentFromFile(pdfFile);
};

export const createPdfAttachmentFromUri = async (uri: string, baseFileName: string) => {
  const blob = await readBlobFromUri(uri);
  const pdfFile = new File(
    [blob],
    sanitizePdfFileName(baseFileName),
    { type: 'application/pdf', lastModified: Date.now() },
  );

  return createNoteAttachmentFromFile(pdfFile);
};
