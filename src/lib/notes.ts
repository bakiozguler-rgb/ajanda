import type { Note } from '../types';
import { getNormalizedAttachments } from './noteAttachments';

export const TRASH_RETENTION_MS = 10 * 24 * 60 * 60 * 1000;

export const createNoteId = () => (
  globalThis.crypto?.randomUUID?.() ??
  `note_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`
);

export const createEmptyNote = (overrides: Partial<Note> = {}): Note => {
  const now = Date.now();

  return {
    id: overrides.id ?? createNoteId(),
    title: overrides.title ?? '',
    content: overrides.content ?? '',
    attachments: getNormalizedAttachments(overrides.attachments),
    tags: Array.isArray(overrides.tags) ? overrides.tags.filter((tag): tag is string => typeof tag === 'string') : [],
    isFavorite: !!overrides.isFavorite,
    isArchived: !!overrides.isArchived,
    isTrashed: !!overrides.isTrashed,
    color: overrides.color,
    createdAt: typeof overrides.createdAt === 'number' ? overrides.createdAt : now,
    updatedAt: typeof overrides.updatedAt === 'number' ? overrides.updatedAt : now,
    deletedAt: typeof overrides.deletedAt === 'number' ? overrides.deletedAt : undefined,
    reminderAt: typeof overrides.reminderAt === 'number' ? overrides.reminderAt : undefined,
    reminderActive: !!overrides.reminderActive,
  };
};

export const purgeExpiredTrash = (items: Note[], now = Date.now()): Note[] => {
  let changed = false;

  const filtered = items.filter((note) => {
    const isExpired = !!note.isTrashed && !!note.deletedAt && now - note.deletedAt >= TRASH_RETENTION_MS;
    if (isExpired) changed = true;
    return !isExpired;
  });

  return changed ? filtered : items;
};

export const normalizeNotes = (items: unknown): Note[] => {
  if (!Array.isArray(items)) return [];

  return purgeExpiredTrash(
    items.flatMap((item) => {
      if (!item || typeof item !== 'object') return [];

      const note = item as Partial<Note>;
      if (typeof note.id !== 'string' || !note.id.trim()) return [];

      return [createEmptyNote({
        ...note,
        id: note.id,
      })];
    }),
  );
};

export const toMobileNote = (note: Partial<Note>): Note => (
  createEmptyNote({
    ...note,
    attachments: getNormalizedAttachments(note.attachments),
    id: typeof note.id === 'string' ? note.id : undefined,
    title: typeof note.title === 'string' ? note.title : '',
    content: typeof note.content === 'string' ? note.content : '',
  })
);

export const normalizeMobileNotes = (items: unknown): Note[] => {
  if (!Array.isArray(items)) return [];

  return purgeExpiredTrash(
    items.flatMap((item) => {
      if (!item || typeof item !== 'object') return [];

      const note = item as Partial<Note>;
      if (typeof note.id !== 'string' || !note.id.trim()) return [];

      return [toMobileNote(note)];
    }),
  );
};

export const sortNotesByUpdatedAt = (items: Note[]) => (
  [...items].sort((left, right) => right.updatedAt - left.updatedAt)
);

export const getMobileVisibleNotes = (items: Note[]) => (
  sortNotesByUpdatedAt(items.filter((note) => !note.isTrashed))
);

export const upsertNote = (items: Note[], updatedNote: Note) => {
  const existingIndex = items.findIndex((note) => note.id === updatedNote.id);
  if (existingIndex === -1) {
    return sortNotesByUpdatedAt([updatedNote, ...items]);
  }

  const nextItems = [...items];
  nextItems[existingIndex] = updatedNote;
  return sortNotesByUpdatedAt(nextItems);
};
