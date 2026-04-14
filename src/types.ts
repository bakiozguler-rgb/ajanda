export interface NoteAttachment {
  id: string;
  name: string;
  type: 'image' | 'pdf';
  mimeType: string;
  size: number;
  dataUrl: string;
  createdAt: number;
}

export interface Note {
  id: string;
  title: string;
  content: string;
  attachments?: NoteAttachment[];
  tags: string[];
  isFavorite: boolean;
  isArchived?: boolean;
  isTrashed?: boolean;
  color?: string;
  createdAt: number;
  updatedAt: number;
  deletedAt?: number;
  reminderAt?: number; // timestamp
  reminderActive?: boolean;
}

export interface AppState {
  notes: Note[];
  activeNoteIds: string[]; // For multi-note editing
  searchQuery: string;
  selectedTag: string | null;
  view: 'all' | 'favorites' | 'archive' | 'trash';
}

export interface DesktopSyncStatus {
  isRunning: boolean;
  port: number;
  authKey: string;
  urls: string[];
  error?: string;
}

export interface MobileSyncConfig {
  serverUrl: string;
  authKey: string;
  fallbackServerUrls?: string[];
}
