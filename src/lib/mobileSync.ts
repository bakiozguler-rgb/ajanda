import type { Note, MobileSyncConfig } from '../types';
import { normalizeMobileNotes } from './notes';

const NOTES_ENDPOINT = '/api/mobile-sync/notes';
const STATUS_ENDPOINT = '/api/mobile-sync/status';
const REQUEST_TIMEOUT_MS = 60000;

export type PendingSyncMutation = {
  id: string;
  noteId: string;
  note: Note;
  createdAt: number;
};

type SyncNotesResponse = {
  notes?: unknown;
  syncCursor?: unknown;
  fullSync?: unknown;
  acknowledgedMutationIds?: unknown;
};

export type SyncNotesResult = {
  notes: Note[];
  syncCursor: number;
  fullSync: boolean;
  acknowledgedMutationIds: string[];
};

const buildUrl = (serverUrl: string, pathname: string) => (
  `${serverUrl.replace(/\/+$/, '')}${pathname}`
);

const appendNoCacheQuery = (pathname: string) => (
  `${pathname}${pathname.includes('?') ? '&' : '?'}_ts=${Date.now()}`
);

const getCandidateServerUrls = (config: MobileSyncConfig) => {
  const urls = [config.serverUrl, ...(config.fallbackServerUrls ?? [])]
    .filter((url) => typeof url === 'string')
    .map((url) => url.trim().replace(/\/+$/, ''))
    .filter(Boolean);

  return urls.filter((url, index) => urls.indexOf(url) === index);
};

const getHeaders = (authKey: string) => ({
  'Content-Type': 'application/json',
  'x-zennotes-key': authKey,
});

const getNoteSyncTimestamp = (note: Partial<Note>) => (
  Math.max(
    typeof note.updatedAt === 'number' && Number.isFinite(note.updatedAt) ? note.updatedAt : 0,
    typeof note.deletedAt === 'number' && Number.isFinite(note.deletedAt) ? note.deletedAt : 0,
    typeof note.createdAt === 'number' && Number.isFinite(note.createdAt) ? note.createdAt : 0,
  )
);

const parseSyncCursor = (value: unknown) => (
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
);

const normalizeAcknowledgedMutationIds = (value: unknown) => (
  Array.isArray(value)
    ? value.filter((mutationId): mutationId is string => typeof mutationId === 'string' && mutationId.trim().length > 0)
    : []
);

const normalizeSyncResponse = (payload: SyncNotesResponse): SyncNotesResult => ({
  notes: normalizeMobileNotes(payload.notes),
  syncCursor: parseSyncCursor(payload.syncCursor),
  fullSync: payload.fullSync === true,
  acknowledgedMutationIds: normalizeAcknowledgedMutationIds(payload.acknowledgedMutationIds),
});

const mergeServerNotes = (currentNotes: Note[], incomingNotes: Note[], fullSync: boolean) => {
  if (fullSync) {
    return normalizeMobileNotes(incomingNotes);
  }

  const mergedNotes = [...normalizeMobileNotes(currentNotes)];

  for (const incomingNote of normalizeMobileNotes(incomingNotes)) {
    const index = mergedNotes.findIndex((note) => note.id === incomingNote.id);
    if (index === -1) {
      mergedNotes.unshift(incomingNote);
      continue;
    }

    if (getNoteSyncTimestamp(incomingNote) >= getNoteSyncTimestamp(mergedNotes[index])) {
      mergedNotes[index] = incomingNote;
    }
  }

  return mergedNotes;
};

const fetchWithTimeout = async (input: string, init?: RequestInit) => {
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    return await fetch(input, {
      ...init,
      cache: 'no-store',
      signal: controller.signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new Error(`PC uygulamasına bağlanırken zaman aşımı oluştu (${REQUEST_TIMEOUT_MS / 1000}sn). PC'nin açık ve aynı ağda olduğunu kontrol edin.`);
    }

    if (error instanceof TypeError) {
      throw new Error('PC uygulamasına ulaşılamadı. Aynı ağda (Wi-Fi) olduğunuzu ve masaüstü uygulamasının açık olduğunu kontrol edin.');
    }

    throw error;
  } finally {
    window.clearTimeout(timeoutId);
  }
};

const readResponseError = async (response: Response) => {
  try {
    const payload = await response.json();
    if (payload && typeof payload.error === 'string') {
      return payload.error;
    }
  } catch {
    // Response body is not JSON.
  }

  return `Sunucu hatasi: ${response.status}`;
};

export const fetchDesktopNotes = async (
  config: MobileSyncConfig,
  syncCursor = 0,
): Promise<SyncNotesResult> => {
  let lastError: Error | null = null;
  const pathWithQuery = appendNoCacheQuery(
    syncCursor > 0 ? `${NOTES_ENDPOINT}?since=${syncCursor}` : NOTES_ENDPOINT,
  );

  for (const serverUrl of getCandidateServerUrls(config)) {
    try {
      const response = await fetchWithTimeout(buildUrl(serverUrl, pathWithQuery), {
        method: 'GET',
        headers: {
          ...getHeaders(config.authKey),
          'Cache-Control': 'no-cache',
          Pragma: 'no-cache',
        },
      });

      if (!response.ok) {
        throw new Error(await readResponseError(response));
      }

      return normalizeSyncResponse(await response.json() as SyncNotesResponse);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error('Notlar alinamadi.');
    }
  }

  throw lastError ?? new Error('PC uygulamasina ulasilamadi.');
};

export const pushDesktopNotes = async (
  config: MobileSyncConfig,
  pendingMutations: PendingSyncMutation[],
  syncCursor = 0,
): Promise<SyncNotesResult> => {
  let lastError: Error | null = null;

  for (const serverUrl of getCandidateServerUrls(config)) {
    try {
      const response = await fetchWithTimeout(buildUrl(serverUrl, NOTES_ENDPOINT), {
        method: 'POST',
        headers: getHeaders(config.authKey),
        body: JSON.stringify({
          mutations: pendingMutations.map((mutation) => ({
            id: mutation.id,
            note: mutation.note,
            createdAt: mutation.createdAt,
            noteId: mutation.noteId,
          })),
          since: syncCursor,
        }),
      });

      if (!response.ok) {
        throw new Error(await readResponseError(response));
      }

      return normalizeSyncResponse(await response.json() as SyncNotesResponse);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error('Notlar gonderilemedi.');
    }
  }

  throw lastError ?? new Error('PC uygulamasina ulasilamadi.');
};

export const syncDirtyNotesWithDesktop = async (
  config: MobileSyncConfig,
  currentNotes: Note[],
  pendingMutations: PendingSyncMutation[],
  syncCursor = 0,
): Promise<SyncNotesResult> => {
  const syncResult = pendingMutations.length > 0
    ? await pushDesktopNotes(config, pendingMutations, syncCursor)
    : await fetchDesktopNotes(config, syncCursor);

  return {
    notes: mergeServerNotes(currentNotes, syncResult.notes, syncResult.fullSync),
    syncCursor: Math.max(syncCursor, syncResult.syncCursor),
    fullSync: syncResult.fullSync,
    acknowledgedMutationIds: syncResult.acknowledgedMutationIds,
  };
};

export const testDesktopConnection = async (config: MobileSyncConfig) => {
  let lastError: Error | null = null;

  for (const serverUrl of getCandidateServerUrls(config)) {
    try {
      const response = await fetchWithTimeout(buildUrl(serverUrl, appendNoCacheQuery(STATUS_ENDPOINT)), {
        method: 'GET',
      });

      if (!response.ok) {
        throw new Error(await readResponseError(response));
      }

      return response.json() as Promise<{ isRunning: boolean; port: number; urls: string[] }>;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error('Baglanti testi basarisiz oldu.');
    }
  }

  throw lastError ?? new Error('PC uygulamasina ulasilamadi.');
};
