import type { Note } from '../types';
import { toEditorContent } from './noteContent';
import type { PdfExportAttachment } from './pdfAttachmentRender';

type NotePdfBuildOptions = {
  preparedAttachments?: PdfExportAttachment[];
};

const escapeHtml = (value: string) => (
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
);

const formatTimestamp = (timestamp: number) => new Intl.DateTimeFormat('tr-TR', {
  dateStyle: 'medium',
  timeStyle: 'short',
}).format(new Date(timestamp));

const renderAttachment = (
  attachment: PdfExportAttachment,
) => {
  const safeName = escapeHtml(attachment.name);
  const label = attachment.type === 'image'
    ? 'Resim'
    : `PDF${attachment.pageCount > 1 ? ` · ${attachment.pageCount} sayfa` : ''}`;
  const pagesMarkup = attachment.renderedImages
    .map((image, index) => `
      <figure class="attachment-page">
        <img class="attachment-image" src="${image}" alt="${safeName}${attachment.type === 'pdf' ? ` sayfa ${index + 1}` : ''}" />
      </figure>
    `)
    .join('');

  return `
    <section class="attachment-card">
      <div class="attachment-meta">
        <span class="attachment-type">${label}</span>
        <span>${safeName}</span>
      </div>
      <div class="attachment-pages">
        ${pagesMarkup}
      </div>
    </section>
  `;
};

export const buildNotePdfHtml = (
  note: Note,
  options: NotePdfBuildOptions = {},
) => {
  const content = toEditorContent(note.content);
  const preparedAttachments = options.preparedAttachments ?? (note.attachments ?? []).map((attachment): PdfExportAttachment => ({
    id: attachment.id,
    name: attachment.name,
    type: attachment.type,
    mimeType: attachment.mimeType,
    size: attachment.size,
    renderedImages: attachment.type === 'image' ? [attachment.dataUrl] : [],
    pageCount: attachment.type === 'image' ? 1 : 0,
  }));
  const tagsMarkup = note.tags.length > 0
    ? `
      <div class="tags">
        ${note.tags.map(tag => `<span class="tag">${escapeHtml(tag)}</span>`).join('')}
      </div>
    `
    : '';
  const attachmentsMarkup = preparedAttachments.length > 0
    ? `
      <section class="attachments-section">
        <h2>Ekler</h2>
        <div class="attachments-grid">
          ${preparedAttachments.map(attachment => renderAttachment(attachment)).join('')}
        </div>
      </section>
    `
    : '';

  return `
    <!DOCTYPE html>
    <html lang="tr">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>${escapeHtml(note.title || 'Basliksiz Not')}</title>
        <style>
          :root {
            color-scheme: light;
            font-family: "Segoe UI", Arial, sans-serif;
            color: #1a1a1b;
            background: #ffffff;
          }

          * {
            box-sizing: border-box;
          }

          @page {
            size: A4;
            margin: 20mm 16mm;
          }

          body {
            margin: 0;
            background: #f3f4f6;
            color: #1a1a1b;
          }

          .page {
            width: 100%;
            max-width: 210mm;
            margin: 0 auto;
            padding: 0;
          }

          .card {
            background: #ffffff;
            border-radius: 24px;
            padding: 28px;
          }

          .header {
            border-bottom: 1px solid #e5e7eb;
            padding-bottom: 20px;
            margin-bottom: 24px;
          }

          .title {
            margin: 0 0 10px;
            font-size: 30px;
            line-height: 1.15;
          }

          .meta {
            display: flex;
            flex-wrap: wrap;
            gap: 12px;
            color: #6b7280;
            font-size: 13px;
          }

          .tags {
            display: flex;
            flex-wrap: wrap;
            gap: 8px;
            margin-top: 14px;
          }

          .tag {
            border-radius: 999px;
            background: #f3f4f6;
            color: #111827;
            font-size: 11px;
            font-weight: 600;
            padding: 5px 10px;
            text-transform: uppercase;
            letter-spacing: 0.05em;
          }

          .content {
            font-size: 15px;
            line-height: 1.7;
          }

          .content h1,
          .content h2,
          .content h3 {
            line-height: 1.2;
            margin: 1.4em 0 0.6em;
          }

          .content p,
          .content ul,
          .content ol,
          .content table,
          .content blockquote {
            margin: 0 0 1rem;
          }

          .content ul,
          .content ol {
            padding-left: 1.4rem;
          }

          .content table {
            width: 100%;
            border-collapse: collapse;
          }

          .content th,
          .content td {
            border: 1px solid #d1d5db;
            padding: 10px 12px;
            text-align: left;
            vertical-align: top;
          }

          .content th {
            background: #f9fafb;
          }

          .content a {
            color: #111827;
          }

          .attachments-section {
            margin-top: 32px;
            page-break-inside: avoid;
          }

          .attachments-section h2 {
            margin: 0 0 14px;
            font-size: 18px;
          }

          .attachments-grid {
            display: grid;
            gap: 16px;
          }

          .attachment-card {
            border: 1px solid #e5e7eb;
            border-radius: 18px;
            overflow: hidden;
            page-break-inside: avoid;
          }

          .attachment-meta {
            display: flex;
            justify-content: space-between;
            gap: 12px;
            padding: 12px 14px;
            background: #f9fafb;
            font-size: 12px;
            color: #4b5563;
          }

          .attachment-type {
            font-weight: 700;
            text-transform: uppercase;
            letter-spacing: 0.05em;
          }

          .attachment-image {
            display: block;
            width: 100%;
            object-fit: contain;
            background: #ffffff;
          }

          .attachment-pages {
            display: grid;
            gap: 14px;
            padding: 14px;
            background: #ffffff;
          }

          .attachment-page {
            margin: 0;
            border: 1px solid #e5e7eb;
            border-radius: 12px;
            overflow: hidden;
            background: #ffffff;
          }
        </style>
      </head>
      <body>
        <main class="page">
          <article class="card">
            <header class="header">
              <h1 class="title">${escapeHtml(note.title || 'Basliksiz Not')}</h1>
              <div class="meta">
                <span>Olusturma: ${formatTimestamp(note.createdAt)}</span>
                <span>Guncelleme: ${formatTimestamp(note.updatedAt)}</span>
              </div>
              ${tagsMarkup}
            </header>
            <section class="content">${content}</section>
            ${attachmentsMarkup}
          </article>
        </main>
      </body>
    </html>
  `;
};
