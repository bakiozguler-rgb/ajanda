import type { DesktopSyncStatus, Note } from './types';

export {};

declare global {
  interface Window {
    zennotesDesktop?: {
      isDesktop: boolean;
      notes: {
        load: () => Promise<Note[] | null>;
        save: (notes: Note[]) => Promise<void>;
        onExternalChange: (callback: () => void) => () => void;
      };
      backup: {
        getStoredDirectory: () => Promise<string | null>;
        storeDirectory: (directoryPath: string) => Promise<void>;
        clearStoredDirectory: () => Promise<void>;
        selectDirectory: () => Promise<string | null>;
        writeSnapshot: (directoryPath: string, notes: unknown) => Promise<void>;
      };
      sync: {
        getStatus: () => Promise<DesktopSyncStatus>;
      };
      transcribeAudio: (base64Audio: string, mimeType: string) => Promise<string>;
      showConfirmDialog: (message: string) => Promise<boolean>;
      exportNoteAsPdf: (payload: { html: string; suggestedFileName: string }) => Promise<string | null>;
    };
  }
}
