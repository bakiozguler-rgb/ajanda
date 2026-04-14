const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { app, BrowserWindow, shell, session, ipcMain, dialog, Menu, clipboard } = require('electron');
const express = require('express');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { GoogleGenAI } = require('@google/genai');

const DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL || 'http://127.0.0.1:3000';
const AUTO_BACKUP_FILENAME = 'zennotes_backup_latest.json';
const TRANSCRIPTION_MODEL = 'gemini-2.5-flash';
const MOBILE_SYNC_PORT = 47653;
const MOBILE_SYNC_PREFIX = '/api/mobile-sync';
const MOBILE_SYNC_PROCESSED_MUTATION_LIMIT = 20000;
const MOBILE_SYNC_PROCESSED_MUTATION_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

const getBackupConfigPath = () => path.join(app.getPath('userData'), 'backup-config.json');
const getNotesDataPath = () => path.join(app.getPath('userData'), 'notes-data.json');
const getSyncConfigPath = () => path.join(app.getPath('userData'), 'mobile-sync.json');
const getSyncStatePath = () => path.join(app.getPath('userData'), 'mobile-sync-state.json');

let mobileSyncStatus = {
  isRunning: false,
  port: MOBILE_SYNC_PORT,
  authKey: '',
  urls: [],
  error: 'Senkron sunucusu baslatilmadi.',
};
let mobileSyncServer;
let mobileSyncStartupPromise;

function notifyExternalNotesChange() {
  for (const browserWindow of BrowserWindow.getAllWindows()) {
    if (!browserWindow.isDestroyed()) {
      browserWindow.webContents.send('notes:external-change');
    }
  }
}

async function readNotesData() {
  try {
    const content = await fs.readFile(getNotesDataPath(), 'utf8');
    const parsed = JSON.parse(content);
    return Array.isArray(parsed) ? parsed : null;
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return [];
    }

    if (error) {
      console.error('Notes data could not be read.', error);
    }
    return null;
  }
}

async function writeJsonAtomic(filePath, value) {
  const directoryPath = path.dirname(filePath);
  const tempFilePath = path.join(
    directoryPath,
    `${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`,
  );

  await fs.mkdir(directoryPath, { recursive: true });
  await fs.writeFile(tempFilePath, JSON.stringify(value, null, 2), 'utf8');
  await fs.rename(tempFilePath, filePath);
}

async function writeNotesData(notes) {
  await writeJsonAtomic(getNotesDataPath(), notes);
}

async function readBackupConfig() {
  try {
    const content = await fs.readFile(getBackupConfigPath(), 'utf8');
    return JSON.parse(content);
  } catch (error) {
    return {};
  }
}

async function writeBackupConfig(config) {
  await fs.mkdir(app.getPath('userData'), { recursive: true });
  await fs.writeFile(getBackupConfigPath(), JSON.stringify(config, null, 2), 'utf8');
}

async function clearBackupConfig() {
  try {
    await fs.unlink(getBackupConfigPath());
  } catch (error) {
    if (error && error.code !== 'ENOENT') {
      throw error;
    }
  }
}

async function readSyncConfig() {
  try {
    const content = await fs.readFile(getSyncConfigPath(), 'utf8');
    return JSON.parse(content);
  } catch (error) {
    return {};
  }
}

async function writeSyncConfig(config) {
  await fs.mkdir(app.getPath('userData'), { recursive: true });
  await fs.writeFile(getSyncConfigPath(), JSON.stringify(config, null, 2), 'utf8');
}

function normalizeProcessedMutations(rawProcessedMutations, now = Date.now()) {
  if (!rawProcessedMutations || typeof rawProcessedMutations !== 'object') {
    return {};
  }

  const minAllowedTimestamp = now - MOBILE_SYNC_PROCESSED_MUTATION_RETENTION_MS;
  const entries = Object.entries(rawProcessedMutations).flatMap(([mutationId, timestamp]) => {
    if (typeof mutationId !== 'string' || !mutationId.trim()) {
      return [];
    }

    if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)) {
      return [];
    }

    if (timestamp < minAllowedTimestamp) {
      return [];
    }

    return [[mutationId, timestamp]];
  });

  entries.sort((left, right) => right[1] - left[1]);

  return Object.fromEntries(entries.slice(0, MOBILE_SYNC_PROCESSED_MUTATION_LIMIT));
}

function normalizeSyncState(state) {
  const now = Date.now();
  return {
    processedMutations: normalizeProcessedMutations(state?.processedMutations, now),
  };
}

async function readSyncState() {
  try {
    const content = await fs.readFile(getSyncStatePath(), 'utf8');
    return normalizeSyncState(JSON.parse(content));
  } catch (error) {
    if (!error || error.code !== 'ENOENT') {
      console.error('Mobile sync state could not be read.', error);
    }
    return normalizeSyncState({});
  }
}

async function writeSyncState(state) {
  await writeJsonAtomic(getSyncStatePath(), normalizeSyncState(state));
}

function mergeProcessedMutationIds(existingProcessedMutations, mutationIds, now = Date.now()) {
  const nextProcessedMutations = normalizeProcessedMutations(existingProcessedMutations, now);

  for (const mutationId of mutationIds) {
    if (typeof mutationId !== 'string' || !mutationId.trim()) {
      continue;
    }
    nextProcessedMutations[mutationId] = now;
  }

  return normalizeProcessedMutations(nextProcessedMutations, now);
}

async function getOrCreateSyncConfig() {
  const currentConfig = await readSyncConfig();
  const nextConfig = {
    port: Number.isInteger(currentConfig.port) ? currentConfig.port : MOBILE_SYNC_PORT,
    authKey: typeof currentConfig.authKey === 'string' && currentConfig.authKey
      ? currentConfig.authKey
      : crypto.randomBytes(18).toString('hex'),
  };

  if (
    nextConfig.port !== currentConfig.port ||
    nextConfig.authKey !== currentConfig.authKey
  ) {
    await writeSyncConfig(nextConfig);
  }

  return nextConfig;
}

function getMobileSyncUrls(port) {
  const interfaces = os.networkInterfaces();
  const candidates = [];

  Object.entries(interfaces).forEach(([name, entries]) => {
    entries?.forEach((entry) => {
      if (!entry || entry.family !== 'IPv4' || entry.internal) return;
      if (entry.address.startsWith('169.254.')) return;

      const normalizedName = name.toLowerCase();
      const isPrivateLan = (
        entry.address.startsWith('192.168.') ||
        entry.address.startsWith('10.') ||
        /^172\.(1[6-9]|2\d|3[0-1])\./.test(entry.address)
      );
      const isPreferredAdapter = /wi-?fi|wlan|ethernet|local area|lan/i.test(normalizedName);
      const isLikelyVirtual = /vethernet|virtual|vmware|hyper-v|docker|wsl|hamachi|tailscale|zerotier/i.test(normalizedName);

      let score = 0;
      if (isPrivateLan) score += 100;
      if (isPreferredAdapter) score += 20;
      if (isLikelyVirtual) score -= 50;

      candidates.push({
        score,
        url: `http://${entry.address}:${port}`,
      });
    });
  });

  const uniqueUrls = [];
  const seen = new Set();

  candidates
    .sort((left, right) => right.score - left.score || left.url.localeCompare(right.url))
    .forEach((candidate) => {
      if (seen.has(candidate.url)) return;
      seen.add(candidate.url);
      uniqueUrls.push(candidate.url);
    });

  uniqueUrls.push(`http://127.0.0.1:${port}`);
  return uniqueUrls;
}

function normalizeSyncAttachments(attachments) {
  if (!Array.isArray(attachments)) {
    return [];
  }

  return attachments.flatMap((attachment) => {
    if (!attachment || typeof attachment !== 'object') {
      return [];
    }

    const type = attachment.type === 'image' || attachment.type === 'pdf'
      ? attachment.type
      : null;

    if (!type || typeof attachment.dataUrl !== 'string' || !attachment.dataUrl.startsWith('data:')) {
      return [];
    }

    return [{
      id: typeof attachment.id === 'string' && attachment.id.trim()
        ? attachment.id
        : crypto.randomUUID(),
      name: typeof attachment.name === 'string' && attachment.name.trim()
        ? attachment.name
        : 'Ek',
      type,
      mimeType: typeof attachment.mimeType === 'string' && attachment.mimeType.trim()
        ? attachment.mimeType
        : type === 'pdf'
          ? 'application/pdf'
          : 'image/*',
      size: typeof attachment.size === 'number' && Number.isFinite(attachment.size)
        ? attachment.size
        : 0,
      dataUrl: attachment.dataUrl,
      createdAt: typeof attachment.createdAt === 'number' && Number.isFinite(attachment.createdAt)
        ? attachment.createdAt
        : Date.now(),
    }];
  });
}

function normalizeSyncNotes(notes) {
  if (!Array.isArray(notes)) {
    return [];
  }

  return notes.flatMap((note) => {
    if (!note || typeof note !== 'object') {
      return [];
    }

    if (typeof note.id !== 'string' || !note.id.trim()) {
      return [];
    }

    const nextNote = {
      id: note.id,
      title: typeof note.title === 'string' ? note.title : '',
      content: typeof note.content === 'string' ? note.content : '',
      attachments: normalizeSyncAttachments(note.attachments),
      tags: Array.isArray(note.tags) ? note.tags.filter((tag) => typeof tag === 'string') : [],
      isFavorite: !!note.isFavorite,
      isArchived: !!note.isArchived,
      isTrashed: !!note.isTrashed,
      color: typeof note.color === 'string' ? note.color : undefined,
      createdAt: typeof note.createdAt === 'number' ? note.createdAt : Date.now(),
      updatedAt: typeof note.updatedAt === 'number' ? note.updatedAt : Date.now(),
      deletedAt: typeof note.deletedAt === 'number' ? note.deletedAt : undefined,
      reminderAt: typeof note.reminderAt === 'number' ? note.reminderAt : undefined,
      reminderActive: !!note.reminderActive,
    };

    return [nextNote];
  });
}

function getNoteSyncTimestamp(note) {
  if (!note || typeof note !== 'object') {
    return 0;
  }

  return Math.max(
    typeof note.updatedAt === 'number' && Number.isFinite(note.updatedAt) ? note.updatedAt : 0,
    typeof note.deletedAt === 'number' && Number.isFinite(note.deletedAt) ? note.deletedAt : 0,
    typeof note.createdAt === 'number' && Number.isFinite(note.createdAt) ? note.createdAt : 0,
  );
}

function parseSyncCursor(value) {
  const parsedValue = typeof value === 'string' ? Number(value) : value;
  return typeof parsedValue === 'number' && Number.isFinite(parsedValue) && parsedValue > 0
    ? parsedValue
    : 0;
}

function toMobileSyncNote(note) {
  if (!note || typeof note !== 'object' || typeof note.id !== 'string' || !note.id.trim()) {
    return null;
  }

  return {
    id: note.id,
    title: typeof note.title === 'string' ? note.title : '',
    content: typeof note.content === 'string' ? note.content : '',
    attachments: normalizeSyncAttachments(note.attachments),
    tags: [],
    isFavorite: false,
    isArchived: !!note.isArchived,
    isTrashed: !!note.isTrashed,
    createdAt: typeof note.createdAt === 'number' ? note.createdAt : Date.now(),
    updatedAt: typeof note.updatedAt === 'number' ? note.updatedAt : Date.now(),
    deletedAt: typeof note.deletedAt === 'number' ? note.deletedAt : undefined,
    reminderAt: undefined,
    reminderActive: false,
  };
}

function buildMobileSyncPayload(notes, since = 0, forceIncludeNoteIds = [], acknowledgedMutationIds = []) {
  const normalizedNotes = Array.isArray(notes)
    ? notes.map((note) => toMobileSyncNote(note)).filter(Boolean)
    : [];
  const forcedNoteIdSet = new Set(
    Array.isArray(forceIncludeNoteIds)
      ? forceIncludeNoteIds.filter((noteId) => typeof noteId === 'string' && noteId.trim())
      : [],
  );
  const syncCursor = normalizedNotes.reduce(
    (maxCursor, note) => Math.max(maxCursor, getNoteSyncTimestamp(note)),
    0,
  );

  const payload = {
    notes: since > 0
      ? normalizedNotes.filter((note) => (
        forcedNoteIdSet.has(note.id) || getNoteSyncTimestamp(note) > since
      ))
      : normalizedNotes,
    syncCursor,
    fullSync: since <= 0,
  };

  if (acknowledgedMutationIds.length > 0) {
    payload.acknowledgedMutationIds = acknowledgedMutationIds;
  }

  return payload;
}

function mergeMobileSyncNote(existingNote, incomingNote) {
  if (!existingNote) {
    return incomingNote;
  }

  if (getNoteSyncTimestamp(incomingNote) < getNoteSyncTimestamp(existingNote)) {
    return existingNote;
  }

  return {
    ...existingNote,
    title: incomingNote.title,
    content: incomingNote.content,
    attachments: incomingNote.attachments,
    isArchived: incomingNote.isArchived,
    isTrashed: incomingNote.isTrashed,
    createdAt: typeof existingNote.createdAt === 'number' ? existingNote.createdAt : incomingNote.createdAt,
    updatedAt: incomingNote.updatedAt,
    deletedAt: incomingNote.deletedAt,
  };
}

function normalizeIncomingMutations(rawMutations) {
  if (!Array.isArray(rawMutations)) {
    return [];
  }

  return rawMutations.flatMap((rawMutation) => {
    if (!rawMutation || typeof rawMutation !== 'object') {
      return [];
    }

    const mutationId = typeof rawMutation.id === 'string' ? rawMutation.id.trim() : '';
    const incomingNote = normalizeSyncNotes([rawMutation.note])[0];
    if (!mutationId || !incomingNote) {
      return [];
    }

    return [{
      id: mutationId,
      note: incomingNote,
    }];
  });
}

function getIncomingMutationsFromRequestBody(requestBody) {
  const normalizedMutations = normalizeIncomingMutations(requestBody?.mutations);
  if (normalizedMutations.length > 0) {
    return normalizedMutations;
  }

  const legacyNotes = normalizeSyncNotes(requestBody?.notes);
  return legacyNotes.map((note) => ({
    id: `legacy:${note.id}:${getNoteSyncTimestamp(note)}`,
    note,
  }));
}

function applyIncomingMutations(existingNotes, processedMutations, incomingMutations) {
  const existingList = Array.isArray(existingNotes) ? existingNotes : [];
  const existingById = new Map(
    existingList
      .filter((note) => note && typeof note === 'object' && typeof note.id === 'string' && note.id)
      .map((note) => [note.id, note]),
  );
  const baseProcessedMutations = normalizeProcessedMutations(processedMutations);
  const nextProcessedMutations = { ...baseProcessedMutations };
  const acknowledgedMutationIds = [];
  const forceIncludeNoteIds = new Set();
  let didChange = false;
  let didRecordNewMutation = false;
  const processedAt = Date.now();

  for (const mutation of incomingMutations) {
    const mutationId = typeof mutation.id === 'string' ? mutation.id.trim() : '';
    const incomingNote = mutation.note;
    if (!mutationId || !incomingNote?.id) {
      continue;
    }

    acknowledgedMutationIds.push(mutationId);
    forceIncludeNoteIds.add(incomingNote.id);

    if (nextProcessedMutations[mutationId]) {
      continue;
    }

    nextProcessedMutations[mutationId] = processedAt;
    didRecordNewMutation = true;

    const existingNote = existingById.get(incomingNote.id);
    const mergedNote = mergeMobileSyncNote(existingNote, incomingNote);
    if (!existingNote || JSON.stringify(existingNote) !== JSON.stringify(mergedNote)) {
      didChange = true;
    }

    existingById.set(incomingNote.id, mergedNote);
  }

  return {
    notes: Array.from(existingById.values()),
    processedMutations: didRecordNewMutation
      ? normalizeProcessedMutations(nextProcessedMutations, processedAt)
      : baseProcessedMutations,
    acknowledgedMutationIds,
    forceIncludeNoteIds: Array.from(forceIncludeNoteIds),
    didChange,
    didRecordNewMutation,
  };
}

async function startMobileSyncServer() {
  if (mobileSyncServer) {
    return mobileSyncStatus;
  }

  if (mobileSyncStartupPromise) {
    return mobileSyncStartupPromise;
  }

  mobileSyncStartupPromise = (async () => {
    const syncConfig = await getOrCreateSyncConfig();
    const syncApp = express();

    syncApp.use((request, response, next) => {
      response.setHeader('Access-Control-Allow-Origin', '*');
      response.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-zennotes-key');
      response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      response.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
      response.setHeader('Pragma', 'no-cache');
      response.setHeader('Expires', '0');
      response.setHeader('Surrogate-Control', 'no-store');

      if (request.method === 'OPTIONS') {
        response.sendStatus(204);
        return;
      }

      next();
    });

    syncApp.use(express.json({ limit: '50mb' }));

    syncApp.get(`${MOBILE_SYNC_PREFIX}/status`, (_request, response) => {
      response.json({
        isRunning: mobileSyncStatus.isRunning,
        port: mobileSyncStatus.port,
        urls: mobileSyncStatus.urls,
      });
    });

    syncApp.use(MOBILE_SYNC_PREFIX, (request, response, next) => {
      if (request.path === '/status') {
        next();
        return;
      }

      if (request.get('x-zennotes-key') !== syncConfig.authKey) {
        response.status(401).json({ error: 'Yetkisiz erisim.' });
        return;
      }

      next();
    });

    syncApp.get(`${MOBILE_SYNC_PREFIX}/notes`, async (request, response) => {
      const notes = await readNotesData();
      if (!notes) {
        response.status(500).json({
          error: 'Not deposu okunamadi. Senkron gecici olarak durduruldu.',
        });
        return;
      }

      response.json(buildMobileSyncPayload(notes, parseSyncCursor(request.query?.since)));
    });

    syncApp.post(`${MOBILE_SYNC_PREFIX}/notes`, async (request, response) => {
      const since = parseSyncCursor(request.body?.since);
      const existingNotes = await readNotesData();
      if (!existingNotes) {
        response.status(500).json({
          error: 'Not deposu okunamadi. Senkron gecici olarak durduruldu.',
        });
        return;
      }

      const syncState = await readSyncState();
      const incomingMutations = getIncomingMutationsFromRequestBody(request.body);
      const applyResult = applyIncomingMutations(
        existingNotes,
        syncState.processedMutations,
        incomingMutations,
      );

      if (applyResult.didChange) {
        await writeNotesData(applyResult.notes);
      }

      if (applyResult.didRecordNewMutation) {
        await writeSyncState({
          processedMutations: applyResult.processedMutations,
        });
      }

      if (applyResult.didChange) {
        notifyExternalNotesChange();
      }

      response.json(buildMobileSyncPayload(
        applyResult.notes,
        since,
        applyResult.forceIncludeNoteIds,
        applyResult.acknowledgedMutationIds,
      ));
    });

    await new Promise((resolve, reject) => {
      const server = syncApp.listen(syncConfig.port, '0.0.0.0', () => {
        mobileSyncServer = server;
        mobileSyncStatus = {
          isRunning: true,
          port: syncConfig.port,
          authKey: syncConfig.authKey,
          urls: getMobileSyncUrls(syncConfig.port),
          error: '',
        };
        resolve();
      });

      server.on('error', reject);
    });

    return mobileSyncStatus;
  })();

  try {
    return await mobileSyncStartupPromise;
  } finally {
    mobileSyncStartupPromise = undefined;
  }
}

function createMainWindow() {
  const mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1120,
    minHeight: 720,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#F3EFEA',
    icon: path.join(__dirname, '..', 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.webContents.on('will-navigate', (event, url) => {
    const currentUrl = mainWindow.webContents.getURL();
    if (url !== currentUrl) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });

  mainWindow.webContents.on('context-menu', (_event, params) => {
    const template = [];

    if (params.isEditable) {
      template.push(
        { role: 'undo', label: 'Geri Al' },
        { role: 'redo', label: 'Yinele' },
        { type: 'separator' },
        { role: 'cut', label: 'Kes' },
        { role: 'copy', label: 'Kopyala' },
        { role: 'paste', label: 'Yapistir' },
        { role: 'selectAll', label: 'Tumunu Sec' },
      );
    } else {
      if (params.selectionText?.trim()) {
        template.push({ role: 'copy', label: 'Kopyala' });
      }
      template.push({ role: 'selectAll', label: 'Tumunu Sec' });
    }

    if (params.selectionText?.trim()) {
      const handleTranslate = async (targetLang) => {
        const textToTranslate = params.selectionText.trim();
        const targetLangName = targetLang === 'en' ? 'İngilizce' : 'Türkçe';

        try {
          const apiKey = process.env.GEMINI_API_KEY;
          if (!apiKey) {
            dialog.showMessageBox(mainWindow, { type: 'error', message: 'API Anahtarı bulunamadı.', detail: 'Lütfen .env dosyasında GEMINI_API_KEY değerini ayarlayın.' });
            return;
          }

          const ai = new GoogleGenAI({ apiKey });
          const prompt = `Aşağıdaki metni ${targetLangName} diline çevir. Asla açıklama ekleme, sadece çeviriyi ver:\n\n${textToTranslate}`;

          const response = await ai.models.generateContent({
            model: TRANSCRIPTION_MODEL,
            contents: [{ role: 'user', parts: [{ text: prompt }] }],
            config: {
              temperature: 0.1,
            }
          });

          const translation = response.text?.trim() || 'Çeviri alınamadı.';

          const { response: action } = await dialog.showMessageBox(mainWindow, {
            type: 'info',
            title: `Çeviri (${targetLangName})`,
            message: translation,
            buttons: params.isEditable ? ['Tamam', 'Kopyala', 'Metni Değiştir'] : ['Tamam', 'Kopyala']
          });

          if (action === 1) {
            clipboard.writeText(translation);
          } else if (action === 2 && params.isEditable) {
            mainWindow.webContents.insertText(translation);
          }
        } catch (error) {
          console.error('Translation error:', error);
          dialog.showMessageBox(mainWindow, { type: 'error', message: 'Çeviri Hatası', detail: error.message });
        }
      };

      template.push(
        { type: 'separator' },
        {
          label: 'Çevir',
          submenu: [
            {
              label: 'İngilizce (TR ➤ EN)',
              click: () => handleTranslate('en')
            },
            {
              label: 'Türkçe (EN ➤ TR)',
              click: () => handleTranslate('tr')
            }
          ]
        }
      );
    }

    if (params.linkURL) {
      template.push(
        { type: 'separator' },
        {
          label: 'Baglantiyi Ac',
          click: () => shell.openExternal(params.linkURL),
        },
        {
          label: 'Baglantiyi Kopyala',
          click: () => clipboard.writeText(params.linkURL),
        },
      );
    }

    if (template.length > 0) {
      Menu.buildFromTemplate(template).popup({ window: mainWindow });
    }
  });

  if (app.isPackaged) {
    mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
    return;
  }

  mainWindow.loadURL(DEV_SERVER_URL);
  mainWindow.webContents.openDevTools({ mode: 'detach' });
}

app.setAppUserModelId('com.bakio.zennotes');
app.disableHardwareAcceleration();

app.whenReady().then(() => {
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(permission === 'media' || permission === 'audioCapture');
  });

  void startMobileSyncServer().catch((error) => {
    console.error('Mobile sync server could not be started.', error);
    mobileSyncStatus = {
      ...mobileSyncStatus,
      isRunning: false,
      error: error instanceof Error ? error.message : 'Senkron sunucusu baslatilamadi.',
    };
  });

  ipcMain.handle('notes:load', async () => readNotesData());

  ipcMain.handle('notes:save', async (_event, notes) => {
    if (!Array.isArray(notes)) {
      throw new Error('Kaydedilecek not verisi gecersiz.');
    }

    await writeNotesData(notes);
  });

  ipcMain.handle('backup:get-stored-directory', async () => {
    const config = await readBackupConfig();
    return config.backupDirectoryPath ?? null;
  });

  ipcMain.handle('backup:store-directory', async (_event, directoryPath) => {
    await writeBackupConfig({ backupDirectoryPath: directoryPath });
  });

  ipcMain.handle('backup:clear-stored-directory', async () => {
    await clearBackupConfig();
  });

  ipcMain.handle('backup:select-directory', async () => {
    const focusedWindow = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
    const result = await dialog.showOpenDialog(focusedWindow, {
      properties: ['openDirectory'],
      title: 'Yedek klasorunu sec',
      buttonLabel: 'Klasoru Sec',
    });

    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }

    const directoryPath = result.filePaths[0];
    await writeBackupConfig({ backupDirectoryPath: directoryPath });
    return directoryPath;
  });

  ipcMain.handle('backup:write-snapshot', async (_event, directoryPath, notes) => {
    await fs.mkdir(directoryPath, { recursive: true });
    const backupFilePath = path.join(directoryPath, AUTO_BACKUP_FILENAME);
    await fs.writeFile(backupFilePath, JSON.stringify(notes, null, 2), 'utf8');
  });

  ipcMain.handle('sync:get-status', async () => {
    if (!mobileSyncStatus.authKey) {
      try {
        await startMobileSyncServer();
      } catch (error) {
        return {
          ...mobileSyncStatus,
          error: error instanceof Error ? error.message : 'Senkron sunucusu baslatilamadi.',
        };
      }
    }

    return mobileSyncStatus;
  });

  ipcMain.handle('transcribe-audio', async (_event, base64Audio, mimeType) => {
    try {
      const apiKey = process.env.GEMINI_API_KEY;
      if (!apiKey) {
        throw new Error('GEMINI_API_KEY bulunamadi. Lutfen .env dosyanizi kontrol edin.');
      }

      const ai = new GoogleGenAI({ apiKey });
      const response = await ai.models.generateContent({
        model: TRANSCRIPTION_MODEL,
        contents: [
          {
            role: 'user',
            parts: [
              { text: 'Lütfen bu ses kaydını (Türkçe olarak) tamamen metne dök. Asla açıklama veya yorum ekleme, sadece doğrudan ne duyuyorsan yazıya çevir.' },
              { inlineData: { data: base64Audio, mimeType } }
            ]
          }
        ],
        config: {
          responseMimeType: 'text/plain',
          temperature: 0.1,
          systemInstruction: 'Sen bir sesli dikte asistanısın. Görevin, verilen sesi doğrudan Türkçe metne çevirmektir. Duyduğun sesleri sadece metne dök, giriş veya yorum ekleme.',
        },
      });
      return response.text?.trim() || '';
    } catch (error) {
      console.error('Transcription error:', error);
      throw error;
    }
  });

  ipcMain.handle('show-confirm-dialog', async (event, message) => {
    const focusedWindow = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
    const { response } = await dialog.showMessageBox(focusedWindow, {
      type: 'question',
      buttons: ['Evet', 'İptal'],
      defaultId: 0,
      cancelId: 1,
      message: message,
    });
    return response === 0;
  });

  ipcMain.handle('note:export-pdf', async (_event, payload) => {
    if (!payload || typeof payload.html !== 'string' || typeof payload.suggestedFileName !== 'string') {
      throw new Error('PDF disa aktarma istegi gecersiz.');
    }

    const focusedWindow = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
    const sanitizedFileName = payload.suggestedFileName
      .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
      .trim() || 'not';

    const { canceled, filePath } = await dialog.showSaveDialog(focusedWindow, {
      title: 'Notu PDF olarak kaydet',
      defaultPath: `${sanitizedFileName}.pdf`,
      filters: [{ name: 'PDF', extensions: ['pdf'] }],
    });

    if (canceled || !filePath) {
      return null;
    }

    const tempHtmlPath = path.join(
      app.getPath('temp'),
      `zennotes-export-${Date.now()}-${Math.random().toString(36).slice(2)}.html`,
    );

    const exportWindow = new BrowserWindow({
      show: false,
      backgroundColor: '#FFFFFF',
      webPreferences: {
        sandbox: true,
      },
    });

    try {
      await fs.writeFile(tempHtmlPath, payload.html, 'utf8');
      await exportWindow.loadFile(tempHtmlPath);

      const pdfBuffer = await exportWindow.webContents.printToPDF({
        pageSize: 'A4',
        printBackground: true,
        preferCSSPageSize: true,
        margins: {
          top: 0,
          bottom: 0,
          left: 0,
          right: 0,
        },
      });

      await fs.writeFile(filePath, pdfBuffer);
      return filePath;
    } finally {
      await fs.unlink(tempHtmlPath).catch(() => {});

      if (!exportWindow.isDestroyed()) {
        exportWindow.close();
      }
    }
  });

  createMainWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (mobileSyncServer) {
    mobileSyncServer.close();
    mobileSyncServer = undefined;
  }

  if (process.platform !== 'darwin') {
    app.quit();
  }
});
