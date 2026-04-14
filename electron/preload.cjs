const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('zennotesDesktop', {
  isDesktop: true,
  notes: {
    load: () => ipcRenderer.invoke('notes:load'),
    save: (notes) => ipcRenderer.invoke('notes:save', notes),
    onExternalChange: (callback) => {
      const listener = () => callback();
      ipcRenderer.on('notes:external-change', listener);
      return () => {
        ipcRenderer.removeListener('notes:external-change', listener);
      };
    },
  },
  backup: {
    getStoredDirectory: () => ipcRenderer.invoke('backup:get-stored-directory'),
    storeDirectory: (directoryPath) => ipcRenderer.invoke('backup:store-directory', directoryPath),
    clearStoredDirectory: () => ipcRenderer.invoke('backup:clear-stored-directory'),
    selectDirectory: () => ipcRenderer.invoke('backup:select-directory'),
    writeSnapshot: (directoryPath, notes) => ipcRenderer.invoke('backup:write-snapshot', directoryPath, notes),
  },
  sync: {
    getStatus: () => ipcRenderer.invoke('sync:get-status'),
  },
  transcribeAudio: (base64Audio, mimeType) => ipcRenderer.invoke('transcribe-audio', base64Audio, mimeType),
  showConfirmDialog: (message) => ipcRenderer.invoke('show-confirm-dialog', message),
  exportNoteAsPdf: (payload) => ipcRenderer.invoke('note:export-pdf', payload),
});
