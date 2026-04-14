import type { NoteAttachment } from '../types';

const PDF_MIME_TYPE = 'application/pdf';
const IMAGE_MIME_PREFIX = 'image/';

const createAttachmentId = () => (
  globalThis.crypto?.randomUUID?.() ??
  `att_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`
);

const readFileAsDataUrl = (file: File) => new Promise<string>((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(reader.result as string);
  reader.onerror = () => reject(reader.error ?? new Error('Dosya okunamadi.'));
  reader.readAsDataURL(file);
});

export const isSupportedAttachmentFile = (file: File) => (
  file.type.startsWith(IMAGE_MIME_PREFIX) || file.type === PDF_MIME_TYPE
);

export const createNoteAttachmentFromFile = async (file: File): Promise<NoteAttachment> => {
  if (!isSupportedAttachmentFile(file)) {
    throw new Error(`${file.name} desteklenmeyen bir dosya turu.`);
  }

  return {
    id: createAttachmentId(),
    name: file.name,
    type: file.type === PDF_MIME_TYPE ? 'pdf' : 'image',
    mimeType: file.type || (file.name.toLowerCase().endsWith('.pdf') ? PDF_MIME_TYPE : 'image/*'),
    size: file.size,
    dataUrl: await readFileAsDataUrl(file),
    createdAt: Date.now(),
  };
};

export const formatAttachmentSize = (size: number) => {
  if (!Number.isFinite(size) || size <= 0) return '0 KB';

  if (size >= 1024 * 1024) {
    return `${(size / (1024 * 1024)).toFixed(1)} MB`;
  }

  return `${Math.max(1, Math.round(size / 1024))} KB`;
};

export const getAttachmentPreviewSrc = (attachment: NoteAttachment) => (
  attachment.type === 'pdf'
    ? `${attachment.dataUrl}#toolbar=0&navpanes=0&scrollbar=0&view=FitH`
    : attachment.dataUrl
);

export const getNormalizedAttachments = (attachments: unknown): NoteAttachment[] => {
  if (!Array.isArray(attachments)) return [];

  return attachments.flatMap((item) => {
    if (!item || typeof item !== 'object') return [];

    const raw = item as Partial<NoteAttachment>;
    const derivedType = raw.type === 'image' || raw.type === 'pdf'
      ? raw.type
      : typeof raw.mimeType === 'string' && raw.mimeType.startsWith(IMAGE_MIME_PREFIX)
        ? 'image'
        : raw.mimeType === PDF_MIME_TYPE
          ? 'pdf'
          : null;

    if (!derivedType || typeof raw.dataUrl !== 'string' || !raw.dataUrl.startsWith('data:')) {
      return [];
    }

    return [{
      id: typeof raw.id === 'string' && raw.id ? raw.id : createAttachmentId(),
      name: typeof raw.name === 'string' && raw.name ? raw.name : 'Ek',
      type: derivedType,
      mimeType: typeof raw.mimeType === 'string' && raw.mimeType
        ? raw.mimeType
        : derivedType === 'pdf'
          ? PDF_MIME_TYPE
          : 'image/*',
      size: typeof raw.size === 'number' && Number.isFinite(raw.size) ? raw.size : 0,
      dataUrl: raw.dataUrl,
      createdAt: typeof raw.createdAt === 'number' && Number.isFinite(raw.createdAt)
        ? raw.createdAt
        : Date.now(),
    }];
  }).sort((left, right) => left.createdAt - right.createdAt);
};

export const getAttachmentSignature = (attachments: NoteAttachment[]) => (
  attachments
    .map(attachment => [
      attachment.id,
      attachment.name,
      attachment.type,
      attachment.mimeType,
      attachment.size,
      attachment.dataUrl.length,
    ].join(':'))
    .join('||')
);
