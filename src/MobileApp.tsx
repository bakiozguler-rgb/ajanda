import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, Camera, FileText, Image as ImageIcon, Mic, MoreVertical, Paperclip, Plus, RefreshCw, Save, ScanLine, Search, Trash2, Wifi, WifiOff, X } from 'lucide-react';
import { App } from '@capacitor/app';
import type { PluginListenerHandle } from '@capacitor/core';
import { BarcodeFormat, BarcodeScanner } from '@capacitor-mlkit/barcode-scanning';
import { DocumentScanner } from '@capacitor-mlkit/document-scanner';
import { Capacitor } from '@capacitor/core';
import { SpeechRecognition } from '@capacitor-community/speech-recognition';
import { format } from 'date-fns';
import { tr } from 'date-fns/locale';
import type { MobileSyncConfig, Note, NoteAttachment } from './types';
import { getMobilePlainText, plainTextToHtml, formatDictationChunk } from './lib/noteContent';
import { formatAttachmentSize } from './lib/noteAttachments';
import { createPdfAttachmentFromImages, createPdfAttachmentFromUri } from './lib/mobilePhotoPdf';
import { renderAttachmentsForPdfExport, type PdfExportAttachment } from './lib/pdfAttachmentRender';
import { createEmptyNote, getMobileVisibleNotes, normalizeMobileNotes, sortNotesByUpdatedAt, upsertNote } from './lib/notes';
import { syncDirtyNotesWithDesktop, type PendingSyncMutation } from './lib/mobileSync';
import { parseSyncPairingValue } from './lib/syncPairing';

const MOBILE_NOTES_STORAGE_KEY = 'zennotes_mobile_notes';
const MOBILE_PENDING_MUTATIONS_STORAGE_KEY = 'zennotes_mobile_pending_mutations';
const LEGACY_MOBILE_DIRTY_STORAGE_KEY = 'zennotes_mobile_dirty_ids';
const MOBILE_SYNC_CONFIG_STORAGE_KEY = 'zennotes_mobile_sync_config';
const MOBILE_SYNC_CURSOR_STORAGE_KEY = 'zennotes_mobile_sync_cursor';
const MOBILE_HISTORY_VIEW_KEY = 'zennotesMobileView';

type MobileHistoryState = {
  zennotesMobileView: 'note' | 'attachmentPreview';
  noteId: string;
};

const createMutationId = () => (
  globalThis.crypto?.randomUUID?.() ??
  `mutation_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`
);

const normalizeServerUrl = (value: string) => {
  const trimmedValue = value.trim();
  if (!trimmedValue) {
    return '';
  }

  const nextValue = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmedValue)
    ? trimmedValue
    : `http://${trimmedValue}`;

  return nextValue.replace(/\/+$/, '');
};

const normalizeConnection = (config: MobileSyncConfig): MobileSyncConfig => ({
  serverUrl: normalizeServerUrl(config.serverUrl),
  authKey: config.authKey.trim(),
  fallbackServerUrls: Array.isArray(config.fallbackServerUrls)
    ? config.fallbackServerUrls
      .filter((url) => typeof url === 'string')
      .map((url) => normalizeServerUrl(url))
      .filter((url) => !!url && url !== normalizeServerUrl(config.serverUrl))
      .filter((url, index, items) => items.indexOf(url) === index)
    : undefined,
});

const readJsonStorage = <T,>(storageKey: string, fallback: T): T => {
  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
};

const writeJsonStorage = (storageKey: string, value: unknown) => {
  try {
    localStorage.setItem(storageKey, JSON.stringify(value));
    return true;
  } catch (error) {
    console.error(`Storage write failed for ${storageKey}.`, error);
    return false;
  }
};

const readStoredConfig = (): MobileSyncConfig => {
  const stored = readJsonStorage<Partial<MobileSyncConfig> | null>(MOBILE_SYNC_CONFIG_STORAGE_KEY, null);
  return {
    serverUrl: typeof stored?.serverUrl === 'string' ? stored.serverUrl : '',
    authKey: typeof stored?.authKey === 'string' ? stored.authKey : '',
    fallbackServerUrls: Array.isArray(stored?.fallbackServerUrls)
      ? stored.fallbackServerUrls.filter((url): url is string => typeof url === 'string')
      : undefined,
  };
};

const normalizePendingMutations = (value: unknown): PendingSyncMutation[] => {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') {
      return [];
    }

    const candidate = entry as Record<string, unknown>;
    const mutationId = typeof candidate.id === 'string' ? candidate.id.trim() : '';
    const noteId = typeof candidate.noteId === 'string' ? candidate.noteId.trim() : '';
    const note = normalizeMobileNotes([candidate.note])[0];
    const createdAt = typeof candidate.createdAt === 'number' && Number.isFinite(candidate.createdAt)
      ? candidate.createdAt
      : Date.now();

    if (!mutationId || !noteId || !note) {
      return [];
    }

    return [{
      id: mutationId,
      noteId,
      note,
      createdAt,
    }];
  });
};

const readLegacyPendingMutations = () => {
  const legacyDirtyIds = readJsonStorage<unknown>(LEGACY_MOBILE_DIRTY_STORAGE_KEY, []);
  if (!Array.isArray(legacyDirtyIds) || legacyDirtyIds.length === 0) {
    return [];
  }

  const storedNotes = normalizeMobileNotes(readJsonStorage<unknown>(MOBILE_NOTES_STORAGE_KEY, []));
  const notesById = new Map(storedNotes.map((note) => [note.id, note]));

  return legacyDirtyIds.flatMap((rawId) => {
    if (typeof rawId !== 'string' || !rawId.trim()) {
      return [];
    }

    const note = notesById.get(rawId);
    if (!note) {
      return [];
    }

    return [{
      id: `legacy_${rawId}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      noteId: note.id,
      note,
      createdAt: Date.now(),
    }];
  });
};

const mergeNotesWithPendingMutations = (sourceNotes: Note[], pendingMutations: PendingSyncMutation[]) => {
  let nextNotes = sortNotesByUpdatedAt(normalizeMobileNotes(sourceNotes));

  for (const mutation of pendingMutations) {
    nextNotes = upsertNote(nextNotes, createEmptyNote(mutation.note));
  }

  return sortNotesByUpdatedAt(nextNotes);
};

const formatSyncTime = (timestamp: number | null) => (
  timestamp ? format(timestamp, "d MMM HH:mm", { locale: tr }) : 'Henüz senkron olmadı'
);

const openAttachmentInBrowser = (attachment: NoteAttachment) => {
  const link = document.createElement('a');
  link.href = attachment.dataUrl;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  link.download = attachment.name;
  link.click();
};

const getMobileHistoryState = (value: unknown): MobileHistoryState | null => {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const candidate = value as Record<string, unknown>;
  const view = candidate[MOBILE_HISTORY_VIEW_KEY];
  const noteId = candidate.noteId;

  if (
    (view === 'note' || view === 'attachmentPreview') &&
    typeof noteId === 'string' &&
    noteId.trim()
  ) {
    return {
      zennotesMobileView: view,
      noteId,
    };
  }

  return null;
};

const createMobileHistoryState = (
  view: MobileHistoryState['zennotesMobileView'],
  noteId: string,
): MobileHistoryState => ({
  zennotesMobileView: view,
  noteId,
});

const getDisplayNoteTitle = (note: Note) => (
  note.title.trim() || 'Basliksiz Not'
);

const getDisplayNotePreview = (note: Note) => {
  const previewText = getMobilePlainText(note.content).trim();
  if (previewText) {
    return previewText;
  }

  if ((note.attachments?.length ?? 0) > 0) {
    return 'Bu notta ekli dosyalar bulunuyor.';
  }

  return 'Yeni not icin dokunun ve yazmaya baslayin.';
};

export default function MobileApp() {
  const [notes, setNotes] = useState<Note[]>(() => normalizeMobileNotes(readJsonStorage<unknown>(MOBILE_NOTES_STORAGE_KEY, [])));
  const [pendingMutations, setPendingMutations] = useState<PendingSyncMutation[]>(() => {
    const storedMutations = normalizePendingMutations(
      readJsonStorage<unknown>(MOBILE_PENDING_MUTATIONS_STORAGE_KEY, []),
    );
    if (storedMutations.length > 0) {
      return storedMutations;
    }

    return readLegacyPendingMutations();
  });
  const [connection, setConnection] = useState<MobileSyncConfig>(() => readStoredConfig());
  const [draftConnection, setDraftConnection] = useState<MobileSyncConfig>(() => readStoredConfig());
  const [lastSyncCursor, setLastSyncCursor] = useState<number>(() => {
    const stored = readJsonStorage<unknown>(MOBILE_SYNC_CURSOR_STORAGE_KEY, 0);
    return typeof stored === 'number' && Number.isFinite(stored) && stored > 0 ? stored : 0;
  });
  const [selectedNoteId, setSelectedNoteId] = useState<string | null>(null);
  const [isSyncing, setIsSyncing] = useState(false);
  const [isScanningQr, setIsScanningQr] = useState(false);
  const [isBuildingPhotoPdf, setIsBuildingPhotoPdf] = useState(false);
  const [isConnectionPanelOpen, setIsConnectionPanelOpen] = useState(() => {
    const stored = readStoredConfig();
    return !stored.serverUrl || !stored.authKey;
  });
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [statusMessage, setStatusMessage] = useState('Telefon modu aktif. Notlar yalnızca başlık ve düz metin olarak düzenlenir.');
  const [lastSyncedAt, setLastSyncedAt] = useState<number | null>(null);
  const notesRef = useRef(notes);
  const pendingMutationsRef = useRef(pendingMutations);
  const lastSyncCursorRef = useRef(lastSyncCursor);
  const isSyncingRef = useRef(false);
  const scannerListenerRef = useRef<PluginListenerHandle | null>(null);
  const photoInputRef = useRef<HTMLInputElement | null>(null);
  const [draftContent, setDraftContent] = useState('');
  const lastNoteIdRef = useRef<string | null>(null);
  const selectedNoteIdRef = useRef<string | null>(selectedNoteId);
  const isConnectionPanelOpenRef = useRef(isConnectionPanelOpen);
  const isSearchOpenRef = useRef(isSearchOpen);
  const searchQueryRef = useRef(searchQuery);
  const isScanningQrRef = useRef(isScanningQr);
  const [previewAttachment, setPreviewAttachment] = useState<PdfExportAttachment | null>(null);
  const [isPreviewLoading, setIsPreviewLoading] = useState(false);
  const previewAttachmentRef = useRef<PdfExportAttachment | null>(previewAttachment);
  const [isListening, setIsListening] = useState(false);
  const isListeningRef = useRef(isListening);
  const draftContentRef = useRef(draftContent);

  const visibleNotes = useMemo(() => getMobileVisibleNotes(notes), [notes]);
  const selectedNote = useMemo(
    () => (selectedNoteId ? visibleNotes.find((note) => note.id === selectedNoteId) ?? null : null),
    [selectedNoteId, visibleNotes],
  );
  const pendingNoteIds = useMemo(
    () => new Set(pendingMutations.map((mutation) => mutation.noteId)),
    [pendingMutations],
  );
  const filteredNotes = useMemo(() => {
    const normalizedQuery = searchQuery.trim().toLocaleLowerCase('tr-TR');
    if (!normalizedQuery) {
      return visibleNotes;
    }

    return visibleNotes.filter((note) => (
      `${note.title} ${getMobilePlainText(note.content)}`
        .toLocaleLowerCase('tr-TR')
        .includes(normalizedQuery)
    ));
  }, [searchQuery, visibleNotes]);

  useEffect(() => {
    writeJsonStorage(MOBILE_NOTES_STORAGE_KEY, notes);
  }, [notes]);

  useEffect(() => {
    notesRef.current = notes;
  }, [notes]);

  useEffect(() => {
    writeJsonStorage(MOBILE_PENDING_MUTATIONS_STORAGE_KEY, pendingMutations);
    localStorage.removeItem(LEGACY_MOBILE_DIRTY_STORAGE_KEY);
  }, [pendingMutations]);

  useEffect(() => {
    pendingMutationsRef.current = pendingMutations;
  }, [pendingMutations]);

  useEffect(() => {
    writeJsonStorage(MOBILE_SYNC_CONFIG_STORAGE_KEY, connection);
  }, [connection]);

  useEffect(() => {
    writeJsonStorage(MOBILE_SYNC_CURSOR_STORAGE_KEY, lastSyncCursor);
  }, [lastSyncCursor]);

  useEffect(() => {
    lastSyncCursorRef.current = lastSyncCursor;
  }, [lastSyncCursor]);

  useEffect(() => {
    selectedNoteIdRef.current = selectedNoteId;
  }, [selectedNoteId]);

  useEffect(() => {
    isConnectionPanelOpenRef.current = isConnectionPanelOpen;
  }, [isConnectionPanelOpen]);

  useEffect(() => {
    isListeningRef.current = isListening;
  }, [isListening]);

  useEffect(() => {
    draftContentRef.current = draftContent;
  }, [draftContent]);

  useEffect(() => {
    isSearchOpenRef.current = isSearchOpen;
  }, [isSearchOpen]);

  useEffect(() => {
    searchQueryRef.current = searchQuery;
  }, [searchQuery]);

  useEffect(() => {
    isScanningQrRef.current = isScanningQr;
  }, [isScanningQr]);

  useEffect(() => {
    previewAttachmentRef.current = previewAttachment;
  }, [previewAttachment]);

  useEffect(() => {
    if (selectedNoteId && !visibleNotes.some((note) => note.id === selectedNoteId)) {
      setSelectedNoteId(null);
    }
  }, [selectedNoteId, visibleNotes]);

  const syncVisibleViewWithHistory = useCallback((historyStateValue: unknown) => {
    const historyState = getMobileHistoryState(historyStateValue);
    const noteId = historyState?.noteId;
    const noteExists = noteId
      ? notesRef.current.some((note) => !note.isTrashed && note.id === noteId)
      : false;

    if (!historyState || !noteExists) {
      setPreviewAttachment(null);
      setSelectedNoteId(null);
      return;
    }

    setSelectedNoteId(noteId);

    if (historyState.zennotesMobileView !== 'attachmentPreview') {
      setPreviewAttachment(null);
    }
  }, []);

  const enqueuePendingMutation = useCallback((note: Note) => {
    const normalizedNote = createEmptyNote(note);
    const nextMutation: PendingSyncMutation = {
      id: createMutationId(),
      noteId: normalizedNote.id,
      note: normalizedNote,
      createdAt: Date.now(),
    };

    setPendingMutations((previousMutations) => ([
      ...previousMutations.filter((mutation) => mutation.noteId !== nextMutation.noteId),
      nextMutation,
    ]));
  }, []);

  useEffect(() => {
    if (!selectedNoteId || !selectedNote) {
      setDraftContent('');
      lastNoteIdRef.current = null;
      return;
    }

    const selectedPlainText = getMobilePlainText(selectedNote.content, { trim: false });
    const hasPendingLocalChange = pendingNoteIds.has(selectedNote.id);

    if (selectedNoteId !== lastNoteIdRef.current) {
      lastNoteIdRef.current = selectedNoteId;
      setDraftContent(selectedPlainText);
      return;
    }

    if (!hasPendingLocalChange) {
      setDraftContent(selectedPlainText);
    }
  }, [pendingNoteIds, selectedNote, selectedNoteId]);

  const applyConnection = useCallback((nextConfig: MobileSyncConfig, message: string) => {
    const normalizedConfig = normalizeConnection(nextConfig);
    setDraftConnection(normalizedConfig);
    setConnection(normalizedConfig);
    lastSyncCursorRef.current = 0;
    setLastSyncCursor(0);
    setIsConnectionPanelOpen(false);
    setStatusMessage(message);
  }, []);

  const stopQrScanner = useCallback(async () => {
    document.body.classList.remove('barcode-scanner-active');
    setIsScanningQr(false);

    const listener = scannerListenerRef.current;
    scannerListenerRef.current = null;

    if (listener) {
      await listener.remove().catch(() => {});
    }

    await BarcodeScanner.removeAllListeners().catch(() => {});
    await BarcodeScanner.stopScan().catch(() => {});
  }, []);

  const runSync = useCallback(async (nextConfig?: MobileSyncConfig) => {
    const activeConfig = normalizeConnection(nextConfig ?? connection);

    if (!activeConfig.serverUrl || !activeConfig.authKey) {
      setStatusMessage('Önce PC adresi ve eşleştirme anahtarını kaydedin.');
      return false;
    }

    // Eş zamanlı birden fazla senkron isteğini engelle
    if (isSyncingRef.current) {
      return false;
    }

    isSyncingRef.current = true;
    setIsSyncing(true);
    setStatusMessage('PC ile senkron başlatıldı...');

    try {
      const pendingSnapshot = pendingMutationsRef.current;
      const syncResult = await syncDirtyNotesWithDesktop(
        activeConfig,
        notesRef.current,
        pendingSnapshot,
        lastSyncCursorRef.current,
      );
      const acknowledgedMutationIds = new Set(syncResult.acknowledgedMutationIds);
      const remainingMutations = pendingMutationsRef.current.filter((mutation) => (
        !acknowledgedMutationIds.has(mutation.id)
      ));
      const mergedNotes = mergeNotesWithPendingMutations(syncResult.notes, remainingMutations);

      setNotes(mergedNotes);
      setPendingMutations(remainingMutations);
      setLastSyncCursor(syncResult.syncCursor);
      setLastSyncedAt(Date.now());
      setStatusMessage('Notlar PC ile eşitlendi.');

      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Senkron başarısız oldu.';
      setStatusMessage(message);
      return false;
    } finally {
      isSyncingRef.current = false;
      setIsSyncing(false);
    }
  }, [connection]);

  const handleSaveConnection = useCallback(() => {
    const normalizedConfig = normalizeConnection(draftConnection);

    if (!normalizedConfig.serverUrl || !normalizedConfig.authKey) {
      setStatusMessage('PC adresi ve anahtar alanlarının ikisi de gerekli.');
      return;
    }

    applyConnection(normalizedConfig, 'Bağlantı bilgileri kaydedildi. Şimdi senkron başlatabilirsiniz.');
  }, [applyConnection, draftConnection]);

  const startQrScanner = useCallback(async () => {
    if (isScanningQr) {
      return;
    }

    setStatusMessage('QR tarayici aciliyor...');

    try {
      const { supported } = await BarcodeScanner.isSupported();
      if (!supported) {
        setStatusMessage('Bu cihazda QR tarama desteklenmiyor. Adres ve anahtari elle girin.');
        return;
      }

      const currentPermission = await BarcodeScanner.checkPermissions();
      const cameraPermission = (
        currentPermission.camera === 'granted' || currentPermission.camera === 'limited'
      )
        ? currentPermission.camera
        : (await BarcodeScanner.requestPermissions()).camera;

      if (cameraPermission !== 'granted' && cameraPermission !== 'limited') {
        setStatusMessage('QR tarama icin kamera izni gerekli.');
        return;
      }

      document.body.classList.add('barcode-scanner-active');
      setIsScanningQr(true);

      scannerListenerRef.current = await BarcodeScanner.addListener('barcodesScanned', async ({ barcodes }) => {
        const rawValue = barcodes[0]?.rawValue ?? barcodes[0]?.displayValue ?? '';
        const parsedConfig = rawValue ? parseSyncPairingValue(rawValue) : null;

        await stopQrScanner();

        if (!parsedConfig) {
          setStatusMessage('Gecerli bir ZenNotes eslestirme QR kodu okunamadi.');
          return;
        }

        applyConnection(parsedConfig, 'QR ile baglanti bilgileri alindi. Senkron butonuna basabilirsiniz.');
      });

      await BarcodeScanner.startScan({
        formats: [BarcodeFormat.QrCode],
      });
    } catch (error) {
      await stopQrScanner();
      const message = error instanceof Error ? error.message : 'QR tarama basarisiz oldu.';
      setStatusMessage(message || 'QR tarama basarisiz oldu.');
    }
  }, [applyConnection, isScanningQr, stopQrScanner]);

  const closeQrScanner = useCallback(async () => {
    await stopQrScanner();
    setStatusMessage('QR tarama kapatildi.');
  }, [stopQrScanner]);

  const openNote = useCallback((noteId: string) => {
    const nextHistoryState = createMobileHistoryState('note', noteId);
    const currentHistoryState = getMobileHistoryState(window.history.state);

    setPreviewAttachment(null);
    setSelectedNoteId(noteId);
    setIsConnectionPanelOpen(false);

    if (currentHistoryState) {
      window.history.replaceState(nextHistoryState, '');
    } else {
      window.history.pushState(nextHistoryState, '');
    }
  }, []);

  const closeSelectedNoteView = useCallback(() => {
    setPreviewAttachment(null);

    if (getMobileHistoryState(window.history.state)) {
      window.history.back();
    } else {
      setSelectedNoteId(null);
    }
  }, []);

  const handleTrashNote = useCallback((noteId: string) => {
    let updatedNoteForSync: Note | null = null;

    setNotes((previousNotes) => {
      const targetNote = previousNotes.find((note) => note.id === noteId);
      if (!targetNote || targetNote.isTrashed) {
        return previousNotes;
      }

      updatedNoteForSync = {
        ...targetNote,
        isTrashed: true,
        deletedAt: Date.now(),
        reminderActive: false,
        updatedAt: Date.now(),
      };

      return upsertNote(previousNotes, updatedNoteForSync);
    });

    if (!updatedNoteForSync) {
      return;
    }

    enqueuePendingMutation(updatedNoteForSync);
    if (selectedNoteIdRef.current === noteId) {
      closeSelectedNoteView();
    }
    setStatusMessage('Not çöp kutusuna gönderildi. Sonraki senkronda PC tarafına da işlenecek.');
  }, [closeSelectedNoteView, enqueuePendingMutation]);

  const handleCloseSelectedNote = useCallback(() => {
    closeSelectedNoteView();
    setStatusMessage('Acik not kapatildi.');
  }, [closeSelectedNoteView]);

  const handleSync = useCallback(async () => {
    await runSync();
  }, [runSync]);

  useEffect(() => {
    syncVisibleViewWithHistory(window.history.state);

    const handlePopState = (event: PopStateEvent) => {
      syncVisibleViewWithHistory(event.state);
    };

    window.addEventListener('popstate', handlePopState);

    return () => {
      window.removeEventListener('popstate', handlePopState);
      void stopQrScanner();
    };
  }, [stopQrScanner, syncVisibleViewWithHistory]);

  const handleCreateNote = () => {
    const newNote = createEmptyNote({
      title: 'Yeni Not',
      content: '',
    });

    setNotes((prev) => [newNote, ...prev.filter((note) => note.id !== newNote.id)]);
    enqueuePendingMutation(newNote);
    openNote(newNote.id);
    setStatusMessage('Yeni not olusturuldu. PC tarafina gondermek icin senkron bekleniyor.');
  };

  const handleFieldChange = (field: 'title' | 'content', value: string) => {
    if (!selectedNote) return;

    if (field === 'content') {
      setDraftContent(value);
    }

    const storedValue = field === 'content' ? plainTextToHtml(value) : value;

    const updatedNote: Note = {
      ...selectedNote,
      [field]: storedValue,
      updatedAt: Date.now(),
    };

    setNotes((prev) => upsertNote(prev, updatedNote));
    enqueuePendingMutation(updatedNote);
  };

  const handleOpenAttachment = useCallback(async (attachment: NoteAttachment) => {
    setIsPreviewLoading(true);
    setStatusMessage('Ek hazirlaniyor...');
    try {
      const results = await renderAttachmentsForPdfExport([attachment]);
      if (results.length > 0) {
        setPreviewAttachment(results[0]);
        if (selectedNoteIdRef.current) {
          window.history.pushState(
            createMobileHistoryState('attachmentPreview', selectedNoteIdRef.current),
            '',
          );
        }
        setStatusMessage('Ek basariyla acildi.');
      } else {
        setStatusMessage('Goruntulenecek icerik bulunamadi.');
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Bilinmeyen hata';
      setStatusMessage(`Ek acilamadi: ${errorMsg}`);
    } finally {
      setIsPreviewLoading(false);
    }
  }, []);

  const handleRemoveAttachment = useCallback((attachmentId: string) => {
    if (!selectedNote) return;

    let updatedNoteForSync: Note | null = null;

    setNotes((previousNotes) => {
      const targetNote = previousNotes.find((note) => note.id === selectedNote.id);
      if (!targetNote) {
        return previousNotes;
      }

      const nextAttachments = (targetNote.attachments ?? []).filter((attachment) => attachment.id !== attachmentId);
      if (nextAttachments.length === (targetNote.attachments ?? []).length) {
        return previousNotes;
      }

      updatedNoteForSync = {
        ...targetNote,
        attachments: nextAttachments,
        updatedAt: Date.now(),
      };

      return upsertNote(previousNotes, updatedNoteForSync);
    });

    if (!updatedNoteForSync) {
      return;
    }

    enqueuePendingMutation(updatedNoteForSync);
    setStatusMessage('Ek nottan kaldirildi. Sonraki senkronda PC tarafina da yansitilacak.');
  }, [enqueuePendingMutation, selectedNote]);

  const triggerPhotoToPdf = useCallback(async () => {
    if (!selectedNote || isBuildingPhotoPdf) {
      return;
    }

    const selectedNoteSnapshot = {
      id: selectedNote.id,
      title: selectedNote.title,
    };

    const isNativeAndroid = Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android';
    const canUseDocumentScanner = isNativeAndroid && Capacitor.isPluginAvailable('DocumentScanner');

    try {
      if (!canUseDocumentScanner) {
        photoInputRef.current?.click();
        return;
      }

      const moduleStatus = await DocumentScanner.isGoogleDocumentScannerModuleAvailable();
      if (!moduleStatus.available) {
        setStatusMessage('Belge tarayici modulu indiriliyor. Tamamlandiginda tekrar deneyin.');
        await DocumentScanner.installGoogleDocumentScannerModule();
        return;
      }

      setIsBuildingPhotoPdf(true);
      setStatusMessage('Belge tarayici aciliyor...');
      const result = await DocumentScanner.scanDocument({
        galleryImportAllowed: true,
        pageLimit: 5,
        resultFormats: 'PDF',
        scannerMode: 'FULL',
      });

      if (result.pdf?.uri) {
        const pdfAttachment = await createPdfAttachmentFromUri(
          result.pdf.uri,
          `${selectedNoteSnapshot.title || 'Yeni_Not'}_tarama`,
        );
        let updatedNoteForSync: Note | null = null;

        setNotes((previousNotes) => {
          const targetNote = previousNotes.find((note) => note.id === selectedNoteSnapshot.id);
          if (!targetNote) return previousNotes;

          updatedNoteForSync = {
            ...targetNote,
            attachments: [...(targetNote.attachments ?? []), pdfAttachment],
            updatedAt: Date.now(),
          };

          return upsertNote(previousNotes, updatedNoteForSync);
        });

        if (updatedNoteForSync) {
          enqueuePendingMutation(updatedNoteForSync);
        }
        setStatusMessage('Belge tarama tamamlandi ve PDF olarak nota eklendi.');
        return;
      }

      if (!result.scannedImages || result.scannedImages.length === 0) {
        setStatusMessage('Tarama iptal edildi.');
        return;
      }

      const files: File[] = [];
      for (let index = 0; index < result.scannedImages.length; index += 1) {
        const imagePath = result.scannedImages[index];
        const candidatePaths = [
          Capacitor.convertFileSrc(imagePath),
          imagePath,
        ].filter((path, i, items) => !!path && items.indexOf(path) === i);
        let blob: Blob | null = null;

        for (const path of candidatePaths) {
          try {
            const response = await fetch(path);
            if (response.ok) {
              blob = await response.blob();
              break;
            }
          } catch {
            // Try the next candidate path.
          }
        }

        if (!blob) {
          throw new Error('Taranan goruntu dosyasina ulasilamadi.');
        }

        files.push(new File([blob], `scan_${Date.now()}_${index}.jpg`, { type: 'image/jpeg' }));
      }

      const pdfAttachment = await createPdfAttachmentFromImages(
        files,
        `${selectedNoteSnapshot.title || 'Yeni_Not'}_tarama`,
      );
      let updatedNoteForSync: Note | null = null;

      setNotes((previousNotes) => {
        const targetNote = previousNotes.find((note) => note.id === selectedNoteSnapshot.id);
        if (!targetNote) return previousNotes;

        updatedNoteForSync = {
          ...targetNote,
          attachments: [...(targetNote.attachments ?? []), pdfAttachment],
          updatedAt: Date.now(),
        };

        return upsertNote(previousNotes, updatedNoteForSync);
      });

      if (updatedNoteForSync) {
        enqueuePendingMutation(updatedNoteForSync);
      }
      setStatusMessage('Tarama PDF olarak nota eklendi.');
    } catch (error) {
      if ((error as Error)?.message?.toLowerCase().includes('cancel')) {
        setStatusMessage('Tarama iptal edildi.');
      } else {
        const message = error instanceof Error ? error.message : 'Tarama basarisiz oldu.';
        setStatusMessage(`Tarama basarisiz oldu: ${message}`);
      }
    } finally {
      setIsBuildingPhotoPdf(false);
    }
  }, [enqueuePendingMutation, isBuildingPhotoPdf, selectedNote]);

  const handlePhotoSelection = useCallback(async (event: React.ChangeEvent<HTMLInputElement>) => {
    const imageFiles = Array.from(event.target.files ?? []);
    event.target.value = '';

    if (!selectedNote || imageFiles.length === 0) {
      return;
    }

    setIsBuildingPhotoPdf(true);
    setStatusMessage('Fotograflar PDF olarak hazirlaniyor...');

    try {
      const pdfAttachment = await createPdfAttachmentFromImages(
        imageFiles,
        `${selectedNote.title || 'Yeni_Not'}_foto`,
      );
      let updatedNoteForSync: Note | null = null;

      setNotes((previousNotes) => {
        const targetNote = previousNotes.find((note) => note.id === selectedNote.id);
        if (!targetNote) {
          return previousNotes;
        }

        updatedNoteForSync = {
          ...targetNote,
          attachments: [...(targetNote.attachments ?? []), pdfAttachment],
          updatedAt: Date.now(),
        };

        return upsertNote(previousNotes, updatedNoteForSync);
      });

      if (updatedNoteForSync) {
        enqueuePendingMutation(updatedNoteForSync);
      }
      setStatusMessage('Fotograf PDF olarak nota eklendi. Sonraki senkronda PC tarafina gonderilecek.');
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Fotograf PDF olarak eklenemedi.';
      setStatusMessage(message);
    } finally {
      setIsBuildingPhotoPdf(false);
    }
  }, [enqueuePendingMutation, selectedNote]);

  const handleVoiceDictation = useCallback(async () => {
    if (!selectedNoteIdRef.current) return;
    
    if (isListeningRef.current) {
      setIsListening(false);
      try { await SpeechRecognition.stop(); } catch (e) {}
      setStatusMessage('Sesli dikte durduruldu.');
      return;
    }

    try {
      const { available } = await SpeechRecognition.available();
      if (!available) {
        setStatusMessage('Sesli dikte bu cihazda desteklenmiyor.');
        return;
      }

      let { speechRecognition } = await SpeechRecognition.checkPermissions();
      if (speechRecognition !== 'granted') {
        const req = await SpeechRecognition.requestPermissions();
        if (req.speechRecognition !== 'granted') {
          setStatusMessage('Mikrofon izni verilmediği için sesli dikte başlatılamadı.');
          return;
        }
      }

      setIsListening(true);
      setStatusMessage('Kesintisiz dinleme aktif. (Durdurmak için tıklayın)');
      
      const doDictate = async () => {
        while (isListeningRef.current) {
          try {
            const result = await SpeechRecognition.start({
              language: 'tr-TR',
              maxResults: 1,
              prompt: 'Dinleniyor...',
              popup: false,
              partialResults: false,
            });

            if (!isListeningRef.current) break;

            if (result.matches && result.matches.length > 0) {
              const text = result.matches[0];
              const formatted = formatDictationChunk(text, draftContentRef.current);
              
              if (formatted) {
                const newContent = draftContentRef.current + formatted;
                
                setDraftContent(newContent);
                draftContentRef.current = newContent;
                
                setNotes((previousNotes) => {
                  const targetNote = previousNotes.find(n => n.id === selectedNoteIdRef.current);
                  if (!targetNote) return previousNotes;
                  const updatedNoteForSync = {
                    ...targetNote,
                    content: plainTextToHtml(newContent),
                    updatedAt: Date.now(),
                  };
                  enqueuePendingMutation(updatedNoteForSync);
                  return upsertNote(previousNotes, updatedNoteForSync);
                });
              }
            }
          } catch (error: any) {
            const msg = error.message || String(error);
            if (msg.includes('No speech input') || msg.includes('7') || msg.includes('NO_MATCH')) {
                // Ignore silence timeouts and keep listening
            } else if (msg.includes('Canceled') || msg.toLowerCase().includes('canc')) {
                break;
            } else {
                setStatusMessage('Sistem Hatası: ' + msg);
                await new Promise(resolve => setTimeout(resolve, 2000));
            }
          }
        }
        setIsListening(false);
      };

      void doDictate();

    } catch (error: any) {
      console.error(error);
      setStatusMessage('Ses başlatılamadı: ' + (error.message || String(error)));
      setIsListening(false);
    }
  }, [enqueuePendingMutation]);

  const handleCloseAttachmentPreview = useCallback(() => {
    const historyState = getMobileHistoryState(window.history.state);

    if (historyState?.zennotesMobileView === 'attachmentPreview') {
      window.history.back();
      return;
    }

    setPreviewAttachment(null);
  }, []);

  useEffect(() => {
    if (!Capacitor.isNativePlatform()) {
      return;
    }

    let backButtonListener: PluginListenerHandle | null = null;
    let isDisposed = false;

    const handleNativeBack = async (canGoBack: boolean) => {
      if (isScanningQrRef.current) {
        await closeQrScanner();
        return;
      }

      if (previewAttachmentRef.current) {
        handleCloseAttachmentPreview();
        return;
      }

      if (selectedNoteIdRef.current) {
        closeSelectedNoteView();
        return;
      }

      if (isConnectionPanelOpenRef.current) {
        setIsConnectionPanelOpen(false);
        return;
      }

      if (isSearchOpenRef.current) {
        setIsSearchOpen(false);
        return;
      }

      if (canGoBack) {
        window.history.back();
        return;
      }

      await App.exitApp();
    };

    void App.addListener('backButton', ({ canGoBack }) => {
      void handleNativeBack(canGoBack);
    }).then((listener) => {
      if (isDisposed) {
        void listener.remove();
        return;
      }

      backButtonListener = listener;
    });

    return () => {
      isDisposed = true;

      if (backButtonListener) {
        void backButtonListener.remove();
      }
    };
  }, [closeQrScanner, closeSelectedNoteView, handleCloseAttachmentPreview]);

  return (
    <div className="min-h-screen bg-[#f4efe8] text-[#201a16]">
      <input
        ref={photoInputRef}
        type="file"
        accept="image/*"
        capture="environment"
        multiple
        className="hidden"
        onChange={(event) => { void handlePhotoSelection(event); }}
      />

      <div className="mx-auto min-h-screen max-w-5xl px-4 pb-28 pt-5 sm:px-5">
        <aside className="w-full">
          <header className="sticky top-0 z-20 -mx-4 mb-6 bg-[#f4efe8]/95 px-4 pb-4 pt-2 backdrop-blur sm:-mx-5 sm:px-5">
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <h1 className="truncate text-[2rem] font-semibold tracking-[-0.04em] text-[#18110d]">
                  Klasorler
                </h1>
                <p className="text-sm text-[#8f8378]">
                  {searchQuery.trim()
                    ? `${filteredNotes.length} arama sonucu`
                    : `${visibleNotes.length} not`}
                </p>
              </div>

              <div className="flex shrink-0 items-center gap-2">
                <button
                  type="button"
                  onClick={handleSync}
                  disabled={isSyncing}
                  className="inline-flex h-11 w-11 items-center justify-center rounded-full bg-white text-[#30261d] shadow-[0_10px_24px_rgba(72,51,30,0.12)] transition hover:bg-[#faf7f3] disabled:opacity-60"
                  title="Senkron"
                >
                  <RefreshCw size={19} className={isSyncing ? 'animate-spin' : ''} />
                </button>
                <button
                  type="button"
                  onClick={() => setIsSearchOpen((currentValue) => !currentValue)}
                  className="inline-flex h-11 w-11 items-center justify-center rounded-full bg-white text-[#30261d] shadow-[0_10px_24px_rgba(72,51,30,0.12)] transition hover:bg-[#faf7f3]"
                  title="Ara"
                >
                  <Search size={19} />
                </button>
                <button
                  type="button"
                  onClick={() => setIsConnectionPanelOpen((currentValue) => !currentValue)}
                  className="inline-flex h-11 w-11 items-center justify-center rounded-full bg-white text-[#30261d] shadow-[0_10px_24px_rgba(72,51,30,0.12)] transition hover:bg-[#faf7f3]"
                  title="Daha fazla"
                >
                  <MoreVertical size={19} />
                </button>
              </div>
            </div>

            {(isSearchOpen || searchQuery.trim()) && (
              <div className="mt-4">
                <label className="flex items-center gap-3 rounded-[1.35rem] bg-white px-4 py-3 shadow-[0_12px_34px_rgba(79,58,36,0.12)]">
                  <Search size={18} className="text-[#8f8378]" />
                  <input
                    type="text"
                    value={searchQuery}
                    onChange={(event) => setSearchQuery(event.target.value)}
                    placeholder="Not ara"
                    className="w-full bg-transparent text-sm outline-none placeholder:text-[#a89d93]"
                  />
                </label>
              </div>
            )}

            <div className="mt-4 flex items-center justify-between gap-3 rounded-[1.35rem] bg-white/85 px-4 py-3 text-sm text-[#665a50] shadow-[0_12px_34px_rgba(79,58,36,0.09)]">
              <span className="line-clamp-2">{statusMessage}</span>
              <span className="shrink-0 text-xs font-medium text-[#8e8277]">
                {formatSyncTime(lastSyncedAt)}
              </span>
            </div>
          </header>

          <section className="grid grid-cols-2 gap-x-4 gap-y-9">
            {filteredNotes.length === 0 ? (
              <div className="col-span-2 rounded-[2rem] border border-dashed border-[#d8cfc6] bg-white/70 px-6 py-14 text-center text-sm text-[#85786d] shadow-[0_16px_40px_rgba(83,60,39,0.08)]">
                {searchQuery.trim()
                  ? 'Aramaniza uyan not bulunamadi.'
                  : 'Notlar burada kart olarak listelenecek. Yeni not olusturmak icin sag alttaki dugmeyi kullanin.'}
              </div>
            ) : (
              filteredNotes.map((note) => {
                const noteDate = format(note.updatedAt, 'd MMM', { locale: tr });
                const leadAttachment = note.attachments?.[0];

                return (
                  <article key={note.id} className="min-w-0">
                    <div className="mb-3 text-center text-sm font-medium text-[#93877c]">
                      {noteDate}
                    </div>

                    <button
                      type="button"
                      onClick={() => openNote(note.id)}
                      className="block w-full text-left"
                    >
                      <div className="relative min-h-[15.75rem] overflow-hidden rounded-[1.9rem] border border-[#e7ddd3] bg-white p-4 shadow-[0_18px_42px_rgba(88,62,38,0.14)] transition active:scale-[0.985]">
                        {pendingNoteIds.has(note.id) && (
                          <span className="absolute right-3 top-3 rounded-full bg-[#1e1712] px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-white">
                            Bekliyor
                          </span>
                        )}

                        {leadAttachment?.type === 'image' && (
                          <img
                            src={leadAttachment.dataUrl}
                            alt={leadAttachment.name}
                            className="mb-4 h-24 w-full rounded-[1.25rem] object-cover"
                          />
                        )}

                        {leadAttachment?.type === 'pdf' && (
                          <div className="mb-4 flex h-24 w-24 items-center justify-center rounded-[1.35rem] bg-[#d82e2f] text-white shadow-[0_14px_24px_rgba(216,46,47,0.22)]">
                            <div className="text-center text-[11px] font-semibold uppercase tracking-[0.16em]">
                              <FileText size={18} className="mx-auto mb-1" />
                              PDF
                            </div>
                          </div>
                        )}

                        <p className="whitespace-pre-line text-[0.95rem] leading-7 text-[#3e372f] line-clamp-6">
                          {getDisplayNotePreview(note)}
                        </p>

                        {(note.attachments?.length ?? 0) > 1 && (
                          <div className="mt-4 inline-flex items-center gap-1 rounded-full bg-[#f4efe8] px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-[#54483d]">
                            <Paperclip size={12} />
                            {note.attachments?.length} ek
                          </div>
                        )}
                      </div>
                    </button>

                    <div className="px-2 pt-4 text-center">
                      <h2 className="truncate text-[1.25rem] font-semibold tracking-[-0.03em] text-[#231b16]">
                        {getDisplayNoteTitle(note)}
                      </h2>
                      <p className="mt-1 text-sm text-[#8f8378]">{noteDate}</p>
                    </div>
                  </article>
                );
              })
            )}
          </section>
        </aside>
      </div>

      {isConnectionPanelOpen && (
        <div
          className="fixed inset-0 z-[40] bg-black/18 px-4 py-6 backdrop-blur-[1px]"
          onClick={() => setIsConnectionPanelOpen(false)}
        >
          <div
            className="mx-auto mt-14 max-w-lg rounded-[2rem] border border-[#e6dbcf] bg-white p-5 shadow-[0_28px_80px_rgba(55,36,19,0.22)]"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="text-lg font-semibold text-[#221a15]">Baglanti ve Senkron</p>
                <p className="mt-1 text-sm leading-6 text-[#7b6f63]">
                  PC adresini kaydedin, QR ile eslestirin ve senkronu buradan yonetin.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setIsConnectionPanelOpen(false)}
                className="inline-flex h-10 w-10 items-center justify-center rounded-full bg-[#f6f1ea] text-[#43362c]"
              >
                <X size={18} />
              </button>
            </div>

            <div className="mt-5 rounded-[1.6rem] bg-[#f6f1ea] p-4">
              <div className="flex items-center gap-2 text-sm font-semibold text-[#2e241b]">
                {connection.serverUrl && connection.authKey ? <Wifi size={16} /> : <WifiOff size={16} />}
                {connection.serverUrl && connection.authKey ? 'Baglanti hazir' : 'Baglanti eksik'}
              </div>
              <p className="mt-2 text-xs leading-5 text-[#7d7165]">{statusMessage}</p>
              <p className="mt-3 text-xs font-medium uppercase tracking-[0.14em] text-[#8f8276]">
                Son senkron: {formatSyncTime(lastSyncedAt)}
              </p>
            </div>

            <label className="mt-5 block">
              <span className="mb-2 block text-xs font-semibold uppercase tracking-[0.14em] text-[#8f8276]">
                PC Adresi
              </span>
              <input
                type="text"
                value={draftConnection.serverUrl}
                onChange={(event) => setDraftConnection((prev) => ({ ...prev, serverUrl: event.target.value }))}
                placeholder="http://192.168.1.20:47653"
                className="w-full rounded-[1.4rem] border border-[#e0d6cc] bg-[#fbf8f4] px-4 py-3 text-sm outline-none transition focus:border-[#1f1813] focus:bg-white"
              />
            </label>

            <label className="mt-4 block">
              <span className="mb-2 block text-xs font-semibold uppercase tracking-[0.14em] text-[#8f8276]">
                Eslestirme Anahtari
              </span>
              <input
                type="text"
                value={draftConnection.authKey}
                onChange={(event) => setDraftConnection((prev) => ({ ...prev, authKey: event.target.value }))}
                placeholder="Masaustundeki anahtari girin"
                className="w-full rounded-[1.4rem] border border-[#e0d6cc] bg-[#fbf8f4] px-4 py-3 text-sm outline-none transition focus:border-[#1f1813] focus:bg-white"
              />
            </label>

            <div className="mt-5 grid gap-3 sm:grid-cols-3">
              <button
                type="button"
                onClick={handleSaveConnection}
                className="inline-flex items-center justify-center gap-2 rounded-[1.3rem] bg-[#201813] px-4 py-3 text-sm font-semibold text-white transition hover:opacity-92"
              >
                <Save size={16} />
                Kaydet
              </button>
              <button
                type="button"
                onClick={() => { void startQrScanner(); }}
                disabled={isScanningQr}
                className="inline-flex items-center justify-center gap-2 rounded-[1.3rem] border border-[#e0d6cc] bg-white px-4 py-3 text-sm font-semibold text-[#231b16] transition hover:bg-[#faf6f1] disabled:opacity-60"
              >
                <ScanLine size={16} />
                QR Tara
              </button>
              <button
                type="button"
                onClick={handleSync}
                disabled={isSyncing}
                className="inline-flex items-center justify-center gap-2 rounded-[1.3rem] border border-[#e0d6cc] bg-white px-4 py-3 text-sm font-semibold text-[#231b16] transition hover:bg-[#faf6f1] disabled:opacity-60"
              >
                <RefreshCw size={16} className={isSyncing ? 'animate-spin' : ''} />
                Senkron
              </button>
            </div>

            <p className="mt-4 text-xs leading-5 text-[#887c70]">
              PC uygulamasi acik kalmali ve telefon ayni agda olmali. Mobil taraf baslik, duz metin ve ekler ile calisir.
            </p>
          </div>
        </div>
      )}

      {selectedNote && (
        <div className="fixed inset-0 z-[70] flex flex-col bg-[#f4efe8] text-[#201a16]">
          <div className="flex items-center justify-between gap-3 border-b border-[#e2d7cc] bg-[#f4efe8]/95 px-4 py-4 backdrop-blur">
            <button
              type="button"
              onClick={handleCloseSelectedNote}
              className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-white text-[#231b16] shadow-[0_10px_24px_rgba(72,51,30,0.12)]"
              title="Listeye don"
            >
              <ArrowLeft size={20} />
            </button>

            <div className="min-w-0 flex-1 text-center">
              <p className="truncate text-base font-semibold text-[#221a15]">
                {getDisplayNoteTitle(selectedNote)}
              </p>
              <p className="mt-0.5 text-xs text-[#8d8276]">
                Son degisiklik {format(selectedNote.updatedAt, 'd MMM yyyy HH:mm', { locale: tr })}
              </p>
            </div>

            <div className="flex shrink-0 items-center gap-2">
              <button
                type="button"
                onClick={triggerPhotoToPdf}
                disabled={isBuildingPhotoPdf}
                className="inline-flex h-11 w-11 items-center justify-center rounded-full bg-white text-[#231b16] shadow-[0_10px_24px_rgba(72,51,30,0.12)] disabled:opacity-60"
                title="Foto -> PDF"
              >
                {isBuildingPhotoPdf ? <RefreshCw size={18} className="animate-spin" /> : <Camera size={18} />}
              </button>
              <button
                type="button"
                onClick={() => handleTrashNote(selectedNote.id)}
                className="inline-flex h-11 w-11 items-center justify-center rounded-full bg-[#fce9e7] text-[#c6453b] shadow-[0_10px_24px_rgba(190,78,67,0.15)]"
                title="Sil"
              >
                <Trash2 size={18} />
              </button>
            </div>
          </div>

          <div className="flex-1 overflow-y-auto px-4 pb-8 pt-5">
            <div className="mx-auto max-w-3xl space-y-4">
              {pendingNoteIds.has(selectedNote.id) && (
                <div className="inline-flex items-center gap-2 rounded-full bg-[#1e1712] px-4 py-2 text-xs font-semibold uppercase tracking-[0.16em] text-white">
                  <RefreshCw size={13} className="animate-spin" />
                  Senkron Bekliyor
                </div>
              )}

              <label className="block rounded-[2rem] border border-[#e6dbcf] bg-white p-5 shadow-[0_16px_40px_rgba(83,60,39,0.1)]">
                <span className="mb-3 block text-xs font-semibold uppercase tracking-[0.16em] text-[#8d8276]">
                  Baslik
                </span>
                <input
                  type="text"
                  value={selectedNote.title}
                  onChange={(event) => handleFieldChange('title', event.target.value)}
                  className="w-full rounded-[1.4rem] bg-[#f8f4ef] px-4 py-4 text-xl font-semibold tracking-[-0.03em] outline-none transition focus:bg-[#f3ede7]"
                />
              </label>

              <label className="block rounded-[2rem] border border-[#e6dbcf] bg-white p-5 shadow-[0_16px_40px_rgba(83,60,39,0.1)]">
                <div className="mb-3 flex items-center gap-2 justify-between">
                  <span className="block text-xs font-semibold uppercase tracking-[0.16em] text-[#8d8276]">
                    Icerik
                  </span>
                  <button
                    type="button"
                    onClick={handleVoiceDictation}
                    className="inline-flex items-center gap-1.5 rounded-[1.2rem] border border-[#e0d6cc] bg-[#faf6f1] px-3 py-1.5 text-xs font-semibold text-[#231b16] transition hover:bg-white"
                  >
                    <Mic size={14} className={isListening ? "animate-pulse text-red-500" : ""} />
                    {isListening ? 'Dinleniyor' : 'Sesli Kayit'}
                  </button>
                </div>
                <textarea
                  value={draftContent}
                  onChange={(event) => handleFieldChange('content', event.target.value)}
                  className="min-h-[45vh] w-full resize-none rounded-[1.65rem] bg-[#f8f4ef] px-4 py-4 text-base leading-8 outline-none transition focus:bg-[#f3ede7]"
                  placeholder="Duz metin notunuzu buraya yazin..."
                />
              </label>

              <div className="rounded-[2rem] border border-[#e6dbcf] bg-white p-5 shadow-[0_16px_40px_rgba(83,60,39,0.1)]">
                <div className="mb-4 flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2 text-sm font-semibold text-[#231b16]">
                    <Paperclip size={16} />
                    Ekler
                  </div>
                  <button
                    type="button"
                    onClick={triggerPhotoToPdf}
                    disabled={isBuildingPhotoPdf}
                    className="inline-flex items-center gap-2 rounded-[1.2rem] border border-[#e0d6cc] bg-[#faf6f1] px-3 py-2 text-xs font-semibold text-[#231b16] transition hover:bg-white disabled:opacity-60"
                  >
                    {isBuildingPhotoPdf ? <RefreshCw size={14} className="animate-spin" /> : <Camera size={14} />}
                    {isBuildingPhotoPdf ? 'Hazirlaniyor' : 'Foto -> PDF'}
                  </button>
                </div>

                {(selectedNote.attachments?.length ?? 0) === 0 ? (
                  <div className="rounded-[1.4rem] border border-dashed border-[#ddd2c7] bg-[#fbf8f4] px-4 py-7 text-center text-sm text-[#877b70]">
                    Henuz ek yok. Kameradan cekilen fotograflari PDF olarak bu nota ekleyebilirsiniz.
                  </div>
                ) : (
                  <div className="space-y-3">
                    {(selectedNote.attachments ?? []).map((attachment) => (
                      <div
                        key={attachment.id}
                        className="rounded-[1.4rem] border border-[#e7ddd2] bg-[#fbf8f4] px-4 py-4"
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <div className="flex items-center gap-2 text-sm font-semibold text-[#231b16]">
                              {attachment.type === 'pdf' ? <FileText size={16} /> : <ImageIcon size={16} />}
                              <span className="truncate">{attachment.name}</span>
                            </div>
                            <div className="mt-1 text-xs text-[#877b70]">
                              {attachment.type === 'pdf' ? 'PDF' : 'Gorsel'} · {formatAttachmentSize(attachment.size)}
                            </div>
                          </div>
                          <div className="flex shrink-0 flex-wrap gap-2">
                            <button
                              type="button"
                              disabled={isPreviewLoading}
                              onClick={() => void handleOpenAttachment(attachment)}
                              className="rounded-[1rem] border border-[#e0d6cc] bg-white px-3 py-2 text-xs font-semibold text-[#231b16] transition hover:bg-[#f6f1ea] disabled:opacity-50"
                            >
                              Ac
                            </button>
                            <button
                              type="button"
                              onClick={() => handleRemoveAttachment(attachment.id)}
                              className="inline-flex items-center gap-2 rounded-[1rem] bg-[#fce9e7] px-3 py-2 text-xs font-semibold text-[#c6453b] transition hover:bg-[#f9ddd8]"
                            >
                              <Trash2 size={13} />
                              Sil
                            </button>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div className="rounded-[1.5rem] bg-white/85 px-4 py-3 text-sm text-[#665a50] shadow-[0_12px_34px_rgba(79,58,36,0.09)]">
                {statusMessage}
              </div>
            </div>
          </div>
        </div>
      )}

      {isScanningQr && (
        <div className="barcode-scanner-modal fixed inset-0 z-[120] flex flex-col justify-between p-5 text-white">
          <div className="flex justify-end">
            <button
              type="button"
              onClick={() => { void closeQrScanner(); }}
              className="inline-flex items-center gap-2 rounded-2xl border border-white/25 bg-black/60 px-4 py-3 text-sm font-semibold text-white backdrop-blur"
            >
              <X size={16} />
              Kapat
            </button>
          </div>

          <div className="mx-auto w-full max-w-sm rounded-[2rem] border border-white/20 bg-black/60 p-5 backdrop-blur-md">
            <p className="text-sm font-semibold">QR Tarayici</p>
            <p className="mt-2 text-sm leading-6 text-white/80">
              PC tarafindaki ZenNotes eslestirme QR kodunu kameraya hizalayin. Kod okununca senkron otomatik baslayacak.
            </p>
            <div className="mt-4 rounded-[1.5rem] border border-dashed border-white/25 px-4 py-8 text-center text-sm text-white/75">
              Kapat dugmesiyle taramayi istediginiz an bitirebilirsiniz.
            </div>
          </div>
        </div>
      )}

      {previewAttachment && (
        <div className="fixed inset-0 z-[150] flex flex-col overflow-hidden bg-white text-text-dark">
          <div className="z-10 flex shrink-0 items-center justify-between border-b border-border bg-[#F8F9FA] px-5 py-4 shadow-sm">
            <div className="min-w-0 pr-4">
              <h2 className="truncate text-base font-semibold">{previewAttachment.name}</h2>
              <p className="mt-0.5 text-xs text-text-muted">
                {previewAttachment.type === 'pdf' ? `PDF Belgesi · ${previewAttachment.pageCount} sayfa` : 'Gorsel'}
              </p>
            </div>
            <button
              type="button"
              onClick={handleCloseAttachmentPreview}
              className="inline-flex shrink-0 items-center gap-2 rounded-xl bg-white px-4 py-2.5 text-sm font-semibold shadow-sm ring-1 ring-border transition hover:bg-[#F1F3F5]"
            >
              <X size={16} />
              Kapat
            </button>
          </div>
          <div className="flex-1 overflow-y-auto bg-gray-100 p-4 pb-20">
            <div className="mx-auto max-w-3xl space-y-4">
              {previewAttachment.renderedImages.map((dataUrl, index) => (
                <div key={`${previewAttachment.id}-page-${index}`} className="overflow-hidden rounded-xl bg-white shadow-sm">
                  <img
                    src={dataUrl}
                    alt={`Sayfa ${index + 1}`}
                    className="w-full object-contain"
                  />
                  {previewAttachment.pageCount > 1 && (
                    <div className="border-t border-border bg-white py-2 text-center text-xs font-semibold text-text-muted">
                      Sayfa {index + 1} / {previewAttachment.pageCount}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      <button
        type="button"
        onClick={handleCreateNote}
        className="fixed bottom-6 right-6 z-[30] inline-flex h-16 w-16 items-center justify-center rounded-full bg-[#ffffff] text-[#d8494a] shadow-[0_18px_45px_rgba(90,64,39,0.22)] transition active:scale-95"
        title="Yeni not"
      >
        <Plus size={28} />
      </button>
    </div>
  );
}
