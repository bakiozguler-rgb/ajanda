import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import QRCode from 'qrcode';
import { EditorContent, useEditor, type Editor as TiptapEditor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Link from '@tiptap/extension-link';
import { Table, TableRow, TableHeader, TableCell } from '@tiptap/extension-table';
import { 
  Search, Star, Archive, Trash2, Tag, Plus, Bell, 
  Mic, MicOff, Download, Upload, X, Maximize2,
  Minimize2, Save, Clock, ChevronDown, Bold, Italic, Strikethrough, Link2, Table2,
  Paperclip, Share2, Image as ImageIcon, FileText
} from 'lucide-react';
import { format } from 'date-fns';
import { tr } from 'date-fns/locale';
import { Note, AppState, type DesktopSyncStatus, type NoteAttachment } from './types';
import { cn } from './lib/utils';
import { getNotePlainText, normalizeRichTextContent, toEditorContent } from './lib/noteContent';
import { printHtmlAsPdf } from './lib/browserPdf';
import {
  createNoteAttachmentFromFile,
  formatAttachmentSize,
  getAttachmentPreviewSrc,
  getAttachmentSignature,
  getNormalizedAttachments,
  isSupportedAttachmentFile,
} from './lib/noteAttachments';
import { buildNotePdfHtml } from './lib/notePdf';
import { renderAttachmentsForPdfExport } from './lib/pdfAttachmentRender';
import {
  AUTO_BACKUP_FILENAME,
  type BackupDirectoryHandle,
  clearStoredBackupDirectory,
  getBackupDirectoryPermission,
  getStoredBackupDirectory,
  isBackupDirectorySupported,
  selectBackupDirectory,
  storeBackupDirectory,
  writeBackupSnapshot,
} from './lib/backupDirectory';
import MobileApp from './MobileApp';
import { shouldUseMobileApp } from './lib/mobileMode';
import { buildSyncPairingValue } from './lib/syncPairing';

// --- Components ---

const QUESTION_WORD_REGEX = /\b(?:ne|nasıl|neden|niçin|niye|kim|kimin|kimi|kime|kimden|hangi|hangisi|hangileri|kaç|kaçta|kaça|kaçıncı|nerede|nereden|nereye|ne zaman|ne kadar|neye|neyi|mümkün mü|olur mu|tamam mı|değil mi|var mı|yok mu)\b/i;
const QUESTION_PARTICLE_REGEX = /\b(?:mi|mı|mu|mü)\b/i;
const QUESTION_SUFFIX_REGEX = /\b[^\s]+(?:mı|mi|mu|mü)(?:y?(?:ım|im|um|üm|sın|sin|sun|sün|sınız|siniz|sunuz|sünüz|yım|yim|yum|yüm|yız|yiz|yuz|yüz|lar|ler))\b/i;

const capitalizeSentence = (value: string) => (
  value.replace(/^([\s"'“”‘’(\[]*)([a-zçğıöşü])/iu, (_, prefix: string, letter: string) => (
    `${prefix}${letter.toLocaleUpperCase('tr-TR')}`
  ))
);

const isLikelyQuestion = (value: string) => (
  QUESTION_WORD_REGEX.test(value) ||
  QUESTION_PARTICLE_REGEX.test(value) ||
  QUESTION_SUFFIX_REGEX.test(value)
);

const formatDictationSentence = (value: string) => {
  const cleaned = value.replace(/\s+/g, ' ').trim();
  if (!cleaned) return '';

  const capitalized = capitalizeSentence(cleaned);
  if (/[.!?]$/.test(capitalized)) {
    return capitalized;
  }

  return `${capitalized}${isLikelyQuestion(capitalized) ? '?' : '.'}`;
};

const formatDictationChunk = (value: string, previousText: string) => {
  const cleaned = value.replace(/\s+/g, ' ').trim();
  if (!cleaned) return '';

  const formatted = cleaned
    .split(/(?<=[.!?])\s+/)
    .map(formatDictationSentence)
    .filter(Boolean)
    .join(' ');

  if (!formatted) return '';

  const needsSeparator = previousText.trim().length > 0 && !/\s$/.test(previousText);
  return `${needsSeparator ? ' ' : ''}${formatted}`;
};

const Sidebar = ({ 
  view, 
  setView, 
  onCreateNote,
  tags, 
  selectedTag, 
  setSelectedTag 
}: { 
  view: string, 
  setView: (v: any) => void, 
  onCreateNote: () => void,
  tags: string[], 
  selectedTag: string | null, 
  setSelectedTag: (t: string | null) => void 
}) => {
  const [isTagsOpen, setIsTagsOpen] = useState(false);
  const [tagsDropdownStyle, setTagsDropdownStyle] = useState<React.CSSProperties>({});
  const tagsButtonRef = React.useRef<HTMLButtonElement | null>(null);
  const tagsPanelRef = React.useRef<HTMLDivElement | null>(null);

  const updateTagsDropdownPosition = useCallback(() => {
    const trigger = tagsButtonRef.current;
    if (!trigger) return;

    const rect = trigger.getBoundingClientRect();
    const viewportPadding = 16;
    const preferredMaxHeight = 320;
    const availableBelow = Math.max(0, window.innerHeight - rect.bottom - viewportPadding);
    const availableAbove = Math.max(0, rect.top - viewportPadding);
    const openUpward = availableBelow < 220 && availableAbove > availableBelow;
    const availableSpace = openUpward ? availableAbove : availableBelow;

    setTagsDropdownStyle({
      left: rect.left,
      width: rect.width,
      maxHeight: Math.min(preferredMaxHeight, availableSpace),
      ...(openUpward
        ? { bottom: window.innerHeight - rect.top + 8 }
        : { top: rect.bottom + 8 }),
    });
  }, []);

  useEffect(() => {
    if (!isTagsOpen) return;

    updateTagsDropdownPosition();

    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as Node;
      if (
        tagsButtonRef.current?.contains(target) ||
        tagsPanelRef.current?.contains(target)
      ) {
        return;
      }

      setIsTagsOpen(false);
    };

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setIsTagsOpen(false);
      }
    };

    const syncDropdown = () => updateTagsDropdownPosition();

    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleEscape);
    window.addEventListener('resize', syncDropdown);
    window.addEventListener('scroll', syncDropdown, true);

    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleEscape);
      window.removeEventListener('resize', syncDropdown);
      window.removeEventListener('scroll', syncDropdown, true);
    };
  }, [isTagsOpen, updateTagsDropdownPosition]);

  return (
    <>
      <aside className="w-64 bg-sidebar-bg p-10 flex flex-col border-r border-border h-screen sticky top-0">
    <div className="font-serif text-3xl mb-12 pl-3">ZenNotes</div>
    
    <div className="mb-8">
      <div className="text-[11px] font-bold uppercase text-text-muted tracking-wider mb-4 pl-3">Menü</div>
      {[
        { id: 'all', label: 'Tüm Notlar', icon: Archive },
        { id: 'favorites', label: 'Yıldızlılar', icon: Star },
        { id: 'archive', label: 'Arşiv', icon: Archive },
        { id: 'trash', label: 'Çöp Kutusu', icon: Trash2 },
      ].map((item) => (
        <React.Fragment key={item.id}>
          <div 
            onClick={() => { setView(item.id); setSelectedTag(null); }}
            className={cn(
              "flex items-center gap-3 px-4 py-3 rounded-xl cursor-pointer font-medium transition-all mb-1",
              view === item.id && !selectedTag ? "bg-[#F1F3F5] text-text-dark shadow-sm animate-pulse-glow" : "text-text-muted hover:bg-[#F8F9FA] hover:text-text-dark"
            )}
          >
            <item.icon size={18} />
            {item.label}
          </div>
          {item.id === 'all' && (
            <div
              onClick={() => {
                setView('all');
                setSelectedTag(null);
                onCreateNote();
              }}
              className="flex items-center gap-3 px-4 py-3 rounded-xl cursor-pointer font-medium transition-all mb-1 text-text-muted hover:bg-[#F8F9FA] hover:text-text-dark"
            >
              <Plus size={18} />
              Yeni Not
            </div>
          )}
        </React.Fragment>
      ))}
    </div>

    <div className="relative">
      <button
        ref={tagsButtonRef}
        type="button"
        onClick={() => setIsTagsOpen(prev => !prev)}
        className="w-full flex items-center justify-between gap-3 px-3 py-2 rounded-xl text-[11px] font-bold uppercase text-text-muted tracking-wider hover:bg-[#F8F9FA] transition-all"
      >
        <span>ETİKETLER</span>
        <ChevronDown
          size={16}
          className={cn("transition-transform duration-200", isTagsOpen && "rotate-180")}
        />
      </button>
    </div>
      </aside>

      <AnimatePresence>
        {isTagsOpen && (
          <motion.div
            ref={tagsPanelRef}
            initial={{ opacity: 0, y: -6, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -4, scale: 0.98 }}
            transition={{ duration: 0.16, ease: 'easeOut' }}
            style={tagsDropdownStyle}
            className="fixed z-30 overflow-y-auto rounded-2xl border border-border bg-white p-2 shadow-[0_18px_50px_rgba(0,0,0,0.12)]"
          >
            {tags.length > 0 ? (
              tags.map(tag => (
                <button
                  key={tag}
                  type="button"
                  onClick={() => {
                    setSelectedTag(tag);
                    setIsTagsOpen(false);
                  }}
                  className={cn(
                    "w-full flex items-center gap-3 px-4 py-3 rounded-xl cursor-pointer font-medium transition-all mb-1 text-left",
                    selectedTag === tag ? "bg-[#F1F3F5] text-text-dark shadow-sm" : "text-text-muted hover:bg-[#F8F9FA] hover:text-text-dark"
                  )}
                >
                  <div className="w-2 h-2 rounded-full bg-current shrink-0" />
                  <span className="truncate">{tag}</span>
                </button>
              ))
            ) : (
              <div className="px-4 py-3 text-sm text-text-muted">
                Henüz etiket yok
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
};

const NoteCard = ({ 
  note, 
  onClick, 
  onToggleFavorite,
  onDelete,
  locationLabel
}: { 
  note: Note, 
  onClick: () => void, 
  onToggleFavorite: (e: React.MouseEvent) => void,
  onDelete: (e: React.MouseEvent) => void,
  locationLabel?: string
}) => (
  <motion.div 
    layout
    initial={{ opacity: 0, y: 20 }}
    animate={{ opacity: 1, y: 0 }}
    whileHover={{ y: -8, boxShadow: '0 12px 30px rgba(0,0,0,0.08)' }}
    onClick={onClick}
    className={cn(
      "bg-card-bg rounded-2xl p-6 border border-border cursor-pointer transition-all relative group",
      note.color === 'dark' && "bg-[#1A1A1B] text-white border-none"
    )}
  >
    <div className="flex justify-between items-start mb-4">
      <div className="flex flex-wrap gap-2">
        {note.tags.map(tag => (
          <span key={tag} className={cn(
            "text-[10px] font-bold uppercase px-2.5 py-1 rounded-full bg-[#F1F3F5] text-text-dark",
            note.color === 'dark' && "bg-[#333] text-white"
          )}>
            {tag}
          </span>
        ))}
      </div>
      <div className="flex items-center gap-1">
        <button 
          onClick={onDelete}
          className="p-1 rounded-full text-text-muted opacity-0 group-hover:opacity-100 hover:bg-red-50 hover:text-red-500 transition-all"
          title={note.isTrashed ? "Kalıcı sil" : "Çöp kutusuna taşı"}
        >
          <Trash2 size={16} />
        </button>
        <button 
          onClick={onToggleFavorite}
          className={cn(
            "p-1 rounded-full transition-colors",
            note.isFavorite ? "text-yellow-500" : "text-text-muted opacity-0 group-hover:opacity-100"
          )}
          title="Yıldızla"
        >
          <Star size={16} fill={note.isFavorite ? "currentColor" : "none"} />
        </button>
      </div>
    </div>
    <h3 className="text-lg font-semibold mb-3 line-clamp-2">{note.title || 'Başlıksız Not'}</h3>
    <p className={cn(
      "text-sm leading-relaxed text-text-muted line-clamp-4",
      note.color === 'dark' && "text-[#BBB]"
    )}>
      {getNotePlainText(note.content) || 'İçerik yok...'}
    </p>
    <div className="mt-6 flex justify-between items-center text-xs text-text-muted">
      <div className="flex items-center gap-2 flex-wrap">
        <span>{format(note.updatedAt, 'd MMM yyyy', { locale: tr })}</span>
        {(note.attachments?.length ?? 0) > 0 && (
          <span className="inline-flex items-center gap-1 rounded-full bg-[#F1F3F5] px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-text-dark">
            <Paperclip size={11} />
            {note.attachments?.length} ek
          </span>
        )}
        {locationLabel && (
          <span className="px-2 py-1 rounded-full bg-[#F1F3F5] text-[10px] font-semibold uppercase tracking-wide text-text-dark">
            {locationLabel}
          </span>
        )}
      </div>
      {note.reminderAt && (
        <div className="flex items-center gap-1 text-accent">
          <Bell size={12} />
          {format(note.reminderAt, 'HH:mm')}
        </div>
      )}
    </div>
  </motion.div>
);

const ToolbarButton = ({
  onClick,
  active = false,
  title,
  children,
}: {
  onClick: () => void,
  active?: boolean,
  title: string,
  children: React.ReactNode,
}) => (
  <button
    type="button"
    onClick={onClick}
    title={title}
    className={cn(
      "h-10 w-10 rounded-xl border transition-all flex items-center justify-center",
      active
        ? "border-text-dark bg-text-dark text-white"
        : "border-border bg-white text-text-muted hover:border-text-muted hover:text-text-dark"
    )}
  >
    {children}
  </button>
);

const RichTextToolbar = ({ editor }: { editor: TiptapEditor | null }) => {
  if (!editor) return null;

  const blockType = editor.isActive('heading', { level: 1 })
    ? 'h1'
    : editor.isActive('heading', { level: 2 })
      ? 'h2'
      : 'paragraph';

  const listType = editor.isActive('bulletList')
    ? 'bullet'
    : editor.isActive('orderedList')
      ? 'ordered'
      : 'none';

  const handleLink = () => {
    const previous = editor.getAttributes('link').href as string | undefined;
    const input = window.prompt('Bağlantı adresi', previous || 'https://');
    if (input === null) return;

    const url = input.trim();
    if (!url) {
      editor.chain().focus().extendMarkRange('link').unsetLink().run();
      return;
    }

    const href = /^https?:\/\//i.test(url) ? url : `https://${url}`;
    editor.chain().focus().extendMarkRange('link').setLink({ href }).run();
  };

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-2xl border border-border bg-[#F8F9FA] px-4 py-3">
      <select
        value={blockType}
        onChange={(e) => {
          const value = e.target.value;
          const chain = editor.chain().focus();
          if (value === 'h1') chain.toggleHeading({ level: 1 }).run();
          else if (value === 'h2') chain.toggleHeading({ level: 2 }).run();
          else chain.setParagraph().run();
        }}
        className="h-10 rounded-xl border border-border bg-white px-3 text-sm font-medium text-text-dark outline-none"
      >
        <option value="paragraph">Paragraf</option>
        <option value="h1">H1</option>
        <option value="h2">H2</option>
      </select>

      <select
        value={listType}
        onChange={(e) => {
          const value = e.target.value;
          const chain = editor.chain().focus();
          if (value === 'bullet') chain.toggleBulletList().run();
          else if (value === 'ordered') chain.toggleOrderedList().run();
          else {
            chain.liftListItem('listItem').run();
            editor.chain().focus().clearNodes().run();
          }
        }}
        className="h-10 rounded-xl border border-border bg-white px-3 text-sm font-medium text-text-dark outline-none"
      >
        <option value="none">Liste yok</option>
        <option value="bullet">Madde işaretli</option>
        <option value="ordered">Numaralı</option>
      </select>

      <ToolbarButton
        onClick={() => editor.chain().focus().toggleBold().run()}
        active={editor.isActive('bold')}
        title="Kalın"
      >
        <Bold size={18} />
      </ToolbarButton>

      <ToolbarButton
        onClick={() => editor.chain().focus().toggleItalic().run()}
        active={editor.isActive('italic')}
        title="İtalik"
      >
        <Italic size={18} />
      </ToolbarButton>

      <ToolbarButton
        onClick={() => editor.chain().focus().toggleStrike().run()}
        active={editor.isActive('strike')}
        title="Üstü çizili"
      >
        <Strikethrough size={18} />
      </ToolbarButton>

      <ToolbarButton
        onClick={handleLink}
        active={editor.isActive('link')}
        title="Bağlantı"
      >
        <Link2 size={18} />
      </ToolbarButton>

      <ToolbarButton
        onClick={() => {
          if (editor.isActive('table')) {
            editor.chain().focus().deleteTable().run();
          } else {
            editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run();
          }
        }}
        active={editor.isActive('table')}
        title={editor.isActive('table') ? 'Tabloyu kaldır' : 'Tablo ekle'}
      >
        <Table2 size={18} />
      </ToolbarButton>
    </div>
  );
};

const AttachmentPreviewCard = ({
  attachment,
  onRemove,
}: {
  attachment: NoteAttachment;
  onRemove: (id: string) => void;
}) => (
  <div className="overflow-hidden rounded-2xl border border-border bg-white shadow-sm">
    <div className="flex items-center justify-between gap-3 border-b border-border bg-[#F8F9FA] px-4 py-3">
      <div className="min-w-0">
        <div className="flex items-center gap-2 text-sm font-semibold text-text-dark">
          {attachment.type === 'image' ? <ImageIcon size={16} /> : <FileText size={16} />}
          <span className="truncate">{attachment.name}</span>
        </div>
        <div className="mt-1 text-xs text-text-muted">
          {attachment.type === 'image' ? 'Resim' : 'PDF'} · {formatAttachmentSize(attachment.size)}
        </div>
      </div>
      <button
        type="button"
        onClick={() => onRemove(attachment.id)}
        className="rounded-xl p-2 text-text-muted transition-colors hover:bg-white hover:text-red-500"
        title="Eki kaldir"
      >
        <X size={16} />
      </button>
    </div>

    {attachment.type === 'image' ? (
      <div className="bg-[#F8F9FA] p-4">
        <img
          src={attachment.dataUrl}
          alt={attachment.name}
          className="max-h-[28rem] w-full rounded-2xl object-contain"
        />
      </div>
    ) : (
      <div className="bg-[#F8F9FA] p-4">
        <object
          data={getAttachmentPreviewSrc(attachment)}
          type={attachment.mimeType}
          className="h-[32rem] w-full rounded-2xl border border-border bg-white"
        >
          <div className="flex h-[12rem] items-center justify-center rounded-2xl border border-dashed border-border bg-white px-6 text-center text-sm text-text-muted">
            PDF onizlemesi burada gosterilemedi.
          </div>
        </object>
      </div>
    )}
  </div>
);

const Editor = ({
  note,
  availableTags,
  onClose,
  onSave,
  onDelete,
  onExportPdf,
  isFullscreen,
  focusRequestNonce = -1,
  onMaximize,
  onMinimize
}: {
  note: Note,
  availableTags: string[],
  onClose: () => void,
  onSave: (n: Note) => void,
  onDelete: (id: string) => void,
  onExportPdf: (note: Note) => Promise<void>,
  isFullscreen: boolean,
  focusRequestNonce?: number,
  onMaximize: () => void,
  onMinimize: () => void
}) => {
  const [title, setTitle] = useState(note.title);
  const [content, setContent] = useState(() => normalizeRichTextContent(note.content));
  const [attachments, setAttachments] = useState<NoteAttachment[]>(() => getNormalizedAttachments(note.attachments));
  const [tags, setTags] = useState(note.tags.join(', '));
  const [isListening, setIsListening] = useState(false);
  const [isExportingPdf, setIsExportingPdf] = useState(false);
  const [isTagSuggestionsOpen, setIsTagSuggestionsOpen] = useState(false);
  const [reminderDate, setReminderDate] = useState(note.reminderAt ? format(note.reminderAt, "yyyy-MM-dd'T'HH:mm") : '');
  const noteReminderDate = note.reminderAt ? format(note.reminderAt, "yyyy-MM-dd'T'HH:mm") : '';
  const normalizedStoredContent = normalizeRichTextContent(note.content);
  const storedAttachments = useMemo(() => getNormalizedAttachments(note.attachments), [note.attachments]);
  const draftAttachmentSignature = useMemo(() => getAttachmentSignature(attachments), [attachments]);
  const storedAttachmentSignature = useMemo(() => getAttachmentSignature(storedAttachments), [storedAttachments]);
  const tagSegments = useMemo(() => tags.split(','), [tags]);
  const currentTagIndex = tagSegments.length - 1;
  const currentTagQuery = (tagSegments[currentTagIndex] ?? '').trim();
  const draftTags = useMemo(() => {
    const seen = new Set<string>();
    return tagSegments
      .map(segment => segment.trim())
      .filter(tag => {
        if (!tag) return false;
        const normalizedTag = tag.toLocaleLowerCase('tr-TR');
        if (seen.has(normalizedTag)) return false;
        seen.add(normalizedTag);
        return true;
      });
  }, [tagSegments]);
  const selectedTagsExceptCurrent = useMemo(() => (
    tagSegments
      .map(segment => segment.trim())
      .filter((tag, index) => index !== currentTagIndex && !!tag)
  ), [tagSegments, currentTagIndex]);
  const tagSuggestions = useMemo(() => {
    const excluded = new Set(selectedTagsExceptCurrent.map(tag => tag.toLocaleLowerCase('tr-TR')));
    const normalizedQuery = currentTagQuery.toLocaleLowerCase('tr-TR');

    return availableTags
      .filter(tag => !excluded.has(tag.toLocaleLowerCase('tr-TR')))
      .filter(tag => (
        normalizedQuery.length === 0 ||
        tag.toLocaleLowerCase('tr-TR').includes(normalizedQuery)
      ))
      .slice(0, 8);
  }, [availableTags, currentTagQuery, selectedTagsExceptCurrent]);
  const recognitionRef = useRef<any>(null);
  const editorRef = useRef<TiptapEditor | null>(null);
  const attachmentInputRef = useRef<HTMLInputElement | null>(null);
  const tagInputWrapperRef = useRef<HTMLDivElement | null>(null);
  const hasPendingChanges = title !== note.title ||
    content !== normalizedStoredContent ||
    reminderDate !== noteReminderDate ||
    draftAttachmentSignature !== storedAttachmentSignature ||
    draftTags.join('||') !== note.tags.join('||');

  const editor = useEditor({
    immediatelyRender: false,
    extensions: [
      StarterKit.configure({
        heading: {
          levels: [1, 2],
        },
      }),
      Link.configure({
        openOnClick: false,
        autolink: true,
        defaultProtocol: 'https',
      }),
      Table.configure({
        resizable: true,
      }),
      TableRow,
      TableHeader,
      TableCell,
    ],
    content: toEditorContent(note.content),
    editorProps: {
      attributes: {
        class: 'prose prose-lg max-w-none min-h-[24rem] rounded-2xl border border-border bg-white px-6 py-5 text-text-dark outline-none',
      },
    },
    onUpdate: ({ editor: currentEditor }) => {
      setContent(normalizeRichTextContent(currentEditor.getHTML()));
    },
  });

  const focusEditorAtEnd = useCallback(() => {
    if (!editor) return;

    window.focus();
    (editor.view.dom as HTMLElement | null)?.focus({ preventScroll: true });
    editor.commands.focus('end');
  }, [editor]);

  const scheduleEditorFocus = useCallback((delays: number[]) => {
    const timeoutIds = delays.map(delay => window.setTimeout(() => {
      focusEditorAtEnd();
    }, delay));

    return () => {
      timeoutIds.forEach(timeoutId => window.clearTimeout(timeoutId));
    };
  }, [focusEditorAtEnd]);

  useEffect(() => {
    editorRef.current = editor;
  }, [editor]);

  useEffect(() => {
    if (!editor) return undefined;

    return scheduleEditorFocus([0, 160]);
  }, [editor, note.id, isFullscreen, scheduleEditorFocus]);

  useEffect(() => {
    if (!editor || focusRequestNonce < 0) return undefined;

    const clearScheduledFocus = scheduleEditorFocus([0, 40, 120, 260, 520]);
    const refocusEditor = () => focusEditorAtEnd();
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        focusEditorAtEnd();
      }
    };

    window.addEventListener('focus', refocusEditor);
    window.addEventListener('resize', refocusEditor);
    document.addEventListener('visibilitychange', handleVisibilityChange);

    const listenerTimeoutId = window.setTimeout(() => {
      window.removeEventListener('focus', refocusEditor);
      window.removeEventListener('resize', refocusEditor);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    }, 1500);

    return () => {
      clearScheduledFocus();
      window.clearTimeout(listenerTimeoutId);
      window.removeEventListener('focus', refocusEditor);
      window.removeEventListener('resize', refocusEditor);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [editor, focusEditorAtEnd, focusRequestNonce, scheduleEditorFocus]);

  useEffect(() => {
    setReminderDate(noteReminderDate);
  }, [noteReminderDate, note.id]);

  useEffect(() => {
    setAttachments(getNormalizedAttachments(note.attachments));
  }, [note.id, note.attachments]);

  useEffect(() => {
    setTags(note.tags.join(', '));
    setIsTagSuggestionsOpen(false);
  }, [note.id, note.tags]);

  useEffect(() => {
    const handlePointerDown = (event: MouseEvent) => {
      if (!tagInputWrapperRef.current?.contains(event.target as Node)) {
        setIsTagSuggestionsOpen(false);
      }
    };

    document.addEventListener('mousedown', handlePointerDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
    };
  }, []);

  useEffect(() => () => {
    recognitionRef.current?.stop?.();
    recognitionRef.current = null;
  }, []);

  const handleVoiceDictation = () => {
    const currentEditor = editorRef.current;
    if (!currentEditor) return;

    // Electron için Gemini entegrasyonu
    if ((window as any).zennotesDesktop) {
      if (isListening) {
        recognitionRef.current?.stop?.();
        recognitionRef.current = null;
        setIsListening(false);
        return;
      }

      const startGeminiDictation = async () => {
        try {
          const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
          const mediaRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm' });
          const audioChunks: BlobPart[] = [];
          
          mediaRecorder.ondataavailable = (e) => {
            if (e.data.size > 0) audioChunks.push(e.data);
          };

          mediaRecorder.onstop = async () => {
            stream.getTracks().forEach(track => track.stop());
            const audioBlob = new Blob(audioChunks, { type: 'audio/webm' });
            
            const reader = new FileReader();
            reader.readAsDataURL(audioBlob);
            reader.onloadend = async () => {
              const base64data = (reader.result as string).split(',')[1];
              const loadingText = '... (Ses İşleniyor) ...';
              
              try {
                currentEditor.chain().focus().insertContent(loadingText).run();
                
                const result = await (window as any).zennotesDesktop.transcribeAudio(base64data, 'audio/webm');
                
                let content = currentEditor.getHTML();
                if (content.includes(loadingText)) {
                   content = content.replace(loadingText, result + ' ');
                   currentEditor.commands.setContent(content);
                   currentEditor.commands.focus('end');
                } else {
                   currentEditor.chain().focus().insertContent(result + ' ').run();
                }
              } catch (e: any) {
                alert("Ses işlenirken hata oluştu. Lütfen .env dosyanızda GEMINI_API_KEY olduğundan emin olun.\nDetay: " + e.message);
                let content = currentEditor.getHTML();
                if (content.includes(loadingText)) {
                   content = content.replace(loadingText, '');
                   currentEditor.commands.setContent(content);
                   currentEditor.commands.focus('end');
                }
              }
            };
          };

          mediaRecorder.start();
          setIsListening(true);
          
          recognitionRef.current = {
            stop: () => mediaRecorder.stop()
          };
        } catch (error) {
          setIsListening(false);
          alert('Mikrofon erişimi sağlanamadı.');
        }
      };

      void startGeminiDictation();
      return;
    }

    const SpeechRecognitionCtor = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;

    if (!SpeechRecognitionCtor) {
      alert("Tarayiciniz sesli dikte ozelligini desteklemiyor.");
      return;
    }

    if (isListening) {
      recognitionRef.current?.stop?.();
      recognitionRef.current = null;
      setIsListening(false);
      return;
    }

    const recognition = new SpeechRecognitionCtor();
    recognition.lang = 'tr-TR';
    recognition.continuous = true;
    recognition.interimResults = false;
    recognition.maxAlternatives = 1;

    recognition.onstart = () => {
      recognitionRef.current = recognition;
      setIsListening(true);
    };

    recognition.onend = () => {
      recognitionRef.current = null;
      setIsListening(false);
    };

    recognition.onerror = (event: any) => {
      recognitionRef.current = null;
      setIsListening(false);
      console.error('Speech recognition error:', event?.error ?? event);

      if (event?.error === 'not-allowed' || event?.error === 'service-not-allowed') {
        alert('Mikrofon izni verilmedigi icin sesli dikte baslatilamadi.');
      }

      if (event?.error === 'audio-capture') {
        alert('Mikrofon bulunamadi veya kullanilamiyor.');
      }
    };

    recognition.onresult = (event: any) => {
      const activeEditor = editorRef.current;
      if (!activeEditor) return;

      let finalTranscript = '';
      let previousText = activeEditor.state.doc.textBetween(
        Math.max(0, activeEditor.state.selection.from - 40),
        activeEditor.state.selection.from,
        ' ',
        ' '
      );

      for (let i = event.resultIndex; i < event.results.length; ++i) {
        if (event.results[i].isFinal) {
          const text = event.results[i][0].transcript;
          const formatted = formatDictationChunk(text, previousText);
          if (formatted) {
            finalTranscript += formatted;
            previousText += formatted;
          }
        }
      }

      if (finalTranscript) {
        activeEditor.chain().focus().insertContent(finalTranscript).run();
      }
    };

    const startRecognition = async () => {
      try {
        if (navigator.mediaDevices?.getUserMedia) {
          const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
          stream.getTracks().forEach(track => track.stop());
        }

        currentEditor.commands.focus();
        recognition.start();
      } catch (error) {
        recognitionRef.current = null;
        setIsListening(false);
        if (!(error instanceof DOMException && error.name === 'InvalidStateError')) {
          console.error('Speech recognition failed to start:', error);
        }
      }
    };

    void startRecognition();
  };

  const buildUpdatedNote = useCallback((overrides: Partial<Note> = {}): Note => ({
    ...note,
    title,
    content,
    attachments,
    tags: draftTags,
    reminderAt: reminderDate ? new Date(reminderDate).getTime() : undefined,
    reminderActive: !!reminderDate,
    updatedAt: Date.now(),
    ...overrides,
  }), [note, title, content, attachments, draftTags, reminderDate]);

  useEffect(() => {
    if (!hasPendingChanges) return;

    const timeout = setTimeout(() => {
      onSave(buildUpdatedNote());
    }, 500);

    return () => clearTimeout(timeout);
  }, [title, content, reminderDate, draftTags, draftAttachmentSignature, hasPendingChanges, onSave, note, buildUpdatedNote]);

  const handleSave = () => {
    if (hasPendingChanges) {
      onSave(buildUpdatedNote());
    }
    onClose();
  };

  const handleClose = () => {
    recognitionRef.current?.stop?.();
    recognitionRef.current = null;
    if (hasPendingChanges) {
      onSave(buildUpdatedNote());
    }
    onClose();
  };

  const handleToggleArchive = () => {
    onSave(buildUpdatedNote({ isArchived: !note.isArchived }));
    onClose();
  };

  const applyTagSuggestion = (tag: string) => {
    const nextTags = [...selectedTagsExceptCurrent, tag];
    setTags(nextTags.join(', ') + ', ');
    setIsTagSuggestionsOpen(false);
  };

  const handleTagKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if ((event.key === 'Enter' || event.key === 'Tab') && tagSuggestions.length > 0) {
      event.preventDefault();
      applyTagSuggestion(tagSuggestions[0]);
      return;
    }

    if (event.key === 'Escape') {
      setIsTagSuggestionsOpen(false);
    }
  };

  const handleAttachmentSelection = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const selectedFiles = Array.from(event.target.files ?? []);
    event.target.value = '';

    if (selectedFiles.length === 0) return;

    const supportedFiles = selectedFiles.filter(isSupportedAttachmentFile);
    const unsupportedFiles = selectedFiles.filter(file => !isSupportedAttachmentFile(file));

    if (unsupportedFiles.length > 0) {
      alert(`Desteklenmeyen dosyalar atlandi: ${unsupportedFiles.map(file => file.name).join(', ')}`);
    }

    if (supportedFiles.length === 0) return;

    try {
      const nextAttachments = await Promise.all(
        supportedFiles.map(file => createNoteAttachmentFromFile(file))
      );
      setAttachments(prev => [...prev, ...nextAttachments]);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Ek dosya okunurken bir sorun olustu.';
      alert(message);
    }
  };

  const handleRemoveAttachment = (attachmentId: string) => {
    setAttachments(prev => prev.filter(attachment => attachment.id !== attachmentId));
  };

  const handleExportPdf = async () => {
    const nextNote = buildUpdatedNote();

    if (hasPendingChanges) {
      onSave(nextNote);
    }

    try {
      setIsExportingPdf(true);
      await onExportPdf(nextNote);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'PDF paylasimi basarisiz oldu.';
      alert(message);
    } finally {
      setIsExportingPdf(false);
    }
  };

  return (
    <motion.div
      initial={{ scale: 0.9, y: 20, opacity: 0 }}
      animate={{ scale: 1, y: 0, opacity: 1 }}
      className="bg-white w-full h-full rounded-3xl shadow-2xl overflow-hidden flex flex-col border border-border"
    >
      <div className="p-6 border-b border-border flex justify-between items-center bg-gray-50">
        <div className="flex gap-2">
          <input
            ref={attachmentInputRef}
            type="file"
            accept="image/*,application/pdf,.pdf"
            multiple
            className="hidden"
            onChange={handleAttachmentSelection}
          />
          <button onClick={handleSave} className="p-2 hover:bg-white rounded-xl transition-colors text-green-600" title="Kaydet ve kapat">
            <Save size={20} />
          </button>
          <button
            type="button"
            onClick={() => attachmentInputRef.current?.click()}
            className="p-2 rounded-xl transition-colors text-text-muted hover:bg-white hover:text-text-dark"
            title="PDF veya resim ekle"
          >
            <Paperclip size={20} />
          </button>
          <button onClick={handleVoiceDictation} className={cn("p-2 rounded-xl transition-colors", isListening ? "bg-red-100 text-red-600 animate-pulse" : "hover:bg-white text-text-muted")} title="Sesli Dikte">
            {isListening ? <MicOff size={20} /> : <Mic size={20} />}
          </button>
          <button
            type="button"
            onClick={() => { void handleExportPdf(); }}
            disabled={isExportingPdf}
            className={cn(
              "p-2 rounded-xl transition-colors",
              isExportingPdf
                ? "cursor-wait text-text-muted/60"
                : "text-text-muted hover:bg-white hover:text-text-dark"
            )}
            title="Notu PDF olarak kaydet"
          >
            <Share2 size={20} />
          </button>
        </div>
        <div className="flex gap-2">
          <button
            onClick={onMinimize}
            disabled={!isFullscreen}
            className={cn(
              "p-2 rounded-xl transition-colors",
              isFullscreen
                ? "text-text-dark hover:bg-white"
                : "text-text-muted/50 cursor-not-allowed"
            )}
            title="Standart boyuta don"
          >
            <Minimize2 size={18} />
          </button>
          <button
            onClick={onMaximize}
            disabled={isFullscreen}
            className={cn(
              "p-2 rounded-xl transition-colors",
              isFullscreen
                ? "text-text-dark/50 cursor-not-allowed"
                : "text-text-dark hover:bg-white"
            )}
            title="Tam ekran"
          >
            <Maximize2 size={18} />
          </button>
          {!note.isTrashed && <button
            onClick={handleToggleArchive}
            className={cn(
              "px-3 py-2 rounded-xl transition-colors flex items-center gap-2 font-medium",
              note.isArchived
                ? "bg-[#F1F3F5] text-text-dark hover:bg-[#E9ECEF]"
                : "hover:bg-[#F1F3F5] text-text-muted hover:text-text-dark"
            )}
            title={note.isArchived ? "Arsivden Cikar" : "Arsive Ekle"}
          >
            <Archive size={18} />
            <span className="text-sm">{note.isArchived ? 'Arsivden Cikar' : 'Arsive Ekle'}</span>
          </button>}
          <button onClick={() => onDelete(note.id)} className="p-2 hover:bg-red-50 rounded-xl transition-colors text-red-500" title={note.isTrashed ? "Kalici Sil" : "Cop Kutusuna Tasi"}>
            <Trash2 size={20} />
          </button>
          <button onClick={handleClose} className="p-2 hover:bg-white rounded-xl transition-colors text-text-muted">
            <X size={20} />
          </button>
        </div>
      </div>

      <div className="p-8 flex-1 overflow-y-auto space-y-6">
        <input
          value={title}
          onChange={e => setTitle(e.target.value)}
          placeholder="Baslik..."
          className="w-full text-4xl font-serif outline-none placeholder:text-gray-300"
        />

        <div className="flex flex-wrap items-center gap-4 text-sm text-text-muted">
          <div ref={tagInputWrapperRef} className="relative">
            <div className="flex items-center gap-2 rounded-lg bg-gray-100 px-3 py-1.5">
              <Tag size={14} />
              <input
                value={tags}
                onChange={e => {
                  setTags(e.target.value);
                  setIsTagSuggestionsOpen(true);
                }}
                onFocus={() => setIsTagSuggestionsOpen(true)}
                onKeyDown={handleTagKeyDown}
                placeholder="Etiketler (virgulle ayir)..."
                className="w-56 bg-transparent outline-none"
              />
            </div>

            {isTagSuggestionsOpen && tagSuggestions.length > 0 && (
              <div className="absolute left-0 top-[calc(100%+0.5rem)] z-20 w-full overflow-hidden rounded-2xl border border-border bg-white shadow-[0_18px_40px_rgba(0,0,0,0.12)]">
                {tagSuggestions.map(tag => (
                  <button
                    key={tag}
                    type="button"
                    onMouseDown={(event) => {
                      event.preventDefault();
                      applyTagSuggestion(tag);
                    }}
                    className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left text-sm text-text-dark transition-colors hover:bg-[#F8F9FA]"
                  >
                    <span className="truncate">{tag}</span>
                    <span className="text-xs uppercase tracking-wide text-text-muted">Sec</span>
                  </button>
                ))}
              </div>
            )}
          </div>
          <div className="flex items-center gap-2 bg-gray-100 px-3 py-1.5 rounded-lg">
            <Clock size={14} />
            <input
              type="datetime-local"
              value={reminderDate}
              onChange={e => setReminderDate(e.target.value)}
              className="bg-transparent outline-none"
            />
          </div>
        </div>

        <RichTextToolbar editor={editor} />

        <div className="relative">
          <EditorContent editor={editor} />
          {editor?.isEmpty && (
            <div className="pointer-events-none absolute left-6 top-5 text-lg text-gray-300">
              Notunuzu yazin veya sesli dikteyi baslatin...
            </div>
          )}
        </div>

        <section className="space-y-4">
            <div className="flex items-center justify-between gap-3">
              <div>
                <h3 className="text-lg font-semibold text-text-dark">Ekler</h3>
                <p className="text-sm text-text-muted">
                  PDF ve resimler not icinde onizlenir, ayri pencere acmaniz gerekmez.
                </p>
              </div>
              {attachments.length > 0 && (
                <span className="rounded-full bg-[#F1F3F5] px-3 py-1 text-xs font-semibold uppercase tracking-wide text-text-dark">
                  {attachments.length} ek
                </span>
              )}
            </div>

            {attachments.length > 0 ? (
              <div className="grid gap-4 xl:grid-cols-2">
                {attachments.map(attachment => (
                  <AttachmentPreviewCard
                    key={attachment.id}
                    attachment={attachment}
                    onRemove={handleRemoveAttachment}
                  />
                ))}
              </div>
            ) : (
              <button
                type="button"
                onClick={() => attachmentInputRef.current?.click()}
                className="flex min-h-32 w-full flex-col items-center justify-center gap-3 rounded-2xl border-2 border-dashed border-border bg-[#F8F9FA] px-6 text-center text-text-muted transition-colors hover:border-text-muted hover:text-text-dark"
              >
                <Paperclip size={24} />
                <span className="text-sm font-medium">PDF veya resim ekleyin</span>
              </button>
            )}
          </section>
      </div>
    </motion.div>
  );
};

const ReminderAlert = ({ note, onDismiss }: { note: Note, onDismiss: () => void }) => (
  <motion.div 
    initial={{ x: 400, opacity: 0 }}
    animate={{ x: 0, opacity: 1 }}
    exit={{ x: 400, opacity: 0 }}
    className="fixed bottom-10 right-10 w-96 max-w-[calc(100vw-2rem)] bg-white rounded-2xl shadow-2xl border-l-4 border-accent p-6 z-[100]"
  >
    <div className="flex justify-between items-start mb-4">
      <div className="bg-accent text-white p-2 rounded-lg">
        <Bell size={20} />
      </div>
      <button onClick={onDismiss} className="text-text-muted hover:text-text-dark">
        <X size={18} />
      </button>
    </div>
    <h4 className="font-bold text-lg mb-1">Hatırlatıcı!</h4>
    <p className="text-sm font-semibold text-text-dark mb-2">{note.title || 'Basliksiz Not'}</p>
    <p className="text-sm leading-relaxed text-text-muted mb-4 whitespace-pre-wrap break-words max-h-40 overflow-y-auto">
      {getNotePlainText(note.content).trim() || 'Icerik yok.'}
    </p>
    <button 
      onClick={onDismiss}
      className="w-full py-2 bg-accent text-white rounded-xl font-semibold hover:opacity-90 transition-opacity"
    >
      Anladım
    </button>
  </motion.div>
);

// --- Main App ---

const TRASH_RETENTION_MS = 10 * 24 * 60 * 60 * 1000;

const purgeExpiredTrash = (items: Note[], now = Date.now()): Note[] => {
  let changed = false;

  const filtered = items.filter(note => {
    const isExpired = !!note.isTrashed && !!note.deletedAt && now - note.deletedAt >= TRASH_RETENTION_MS;
    if (isExpired) changed = true;
    return !isExpired;
  });

  return changed ? filtered : items;
};

const normalizeNotes = (items: Note[]): Note[] => (
  purgeExpiredTrash(
    items.map(note => ({
      ...note,
      attachments: getNormalizedAttachments(note.attachments),
      isArchived: !!note.isArchived,
      isTrashed: !!note.isTrashed,
      deletedAt: note.deletedAt,
    }))
  )
);

function DesktopApp() {
  const [notes, setNotes] = useState<Note[]>([]);
  const [isNotesHydrated, setIsNotesHydrated] = useState(false);
  const [didLoadFromDesktopStorage, setDidLoadFromDesktopStorage] = useState(false);
  const [view, setView] = useState<AppState['view']>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedTag, setSelectedTag] = useState<string | null>(null);
  const [activeNoteIds, setActiveNoteIds] = useState<string[]>([]);
  const [fullscreenNoteId, setFullscreenNoteId] = useState<string | null>(null);
  const [activeReminders, setActiveReminders] = useState<string[]>([]);
  const [backupDirectoryHandle, setBackupDirectoryHandle] = useState<BackupDirectoryHandle | null>(null);
  const [editorFocusRequest, setEditorFocusRequest] = useState<{ noteId: string; nonce: number } | null>(null);
  const [desktopSyncStatus, setDesktopSyncStatus] = useState<DesktopSyncStatus | null>(null);
  const [isSyncPanelOpen, setIsSyncPanelOpen] = useState(false);
  const [desktopSyncQrDataUrl, setDesktopSyncQrDataUrl] = useState<string | null>(null);
  const notesRef = React.useRef(notes);

  useEffect(() => {
    let cancelled = false;

    const hydrateNotes = async () => {
      const hasDesktopLoad = !!window.zennotesDesktop?.notes.load;

      if (hasDesktopLoad) {
        try {
          const desktopNotes = await window.zennotesDesktop?.notes.load?.();
          if (cancelled) return;

          if (Array.isArray(desktopNotes)) {
            setDidLoadFromDesktopStorage(true);
            setNotes(normalizeNotes(desktopNotes));
            setIsNotesHydrated(true);
            return;
          }

          throw new Error('Desktop notes returned invalid data.');
        } catch (error) {
          console.error('Desktop note storage could not be loaded.', error);
        }
      }

      try {
        const saved = localStorage.getItem('zennotes_data');
        const fallbackNotes = saved ? normalizeNotes(JSON.parse(saved)) : [];
        if (cancelled) return;

        setDidLoadFromDesktopStorage(false);
        setNotes(fallbackNotes);
        setIsNotesHydrated(true);

        if (!hasDesktopLoad && window.zennotesDesktop?.notes.save) {
          await window.zennotesDesktop.notes.save(fallbackNotes).catch((error) => {
            console.error('Desktop note storage could not be initialized.', error);
          });
        }
      } catch (error) {
        console.error('Local note storage could not be loaded.', error);
        if (!cancelled) {
          setDidLoadFromDesktopStorage(false);
          setNotes([]);
          setIsNotesHydrated(true);
        }
      }
    };

    void hydrateNotes();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!isNotesHydrated) return;

    localStorage.setItem('zennotes_data', JSON.stringify(notes));
    if (didLoadFromDesktopStorage && window.zennotesDesktop?.notes.save) {
      void window.zennotesDesktop.notes.save(notes).catch((error) => {
        console.error('Desktop note storage could not be updated.', error);
      });
    }
  }, [notes, isNotesHydrated, didLoadFromDesktopStorage]);

  useEffect(() => {
    notesRef.current = notes;
  }, [notes]);

  useEffect(() => {
    if (
      !isNotesHydrated ||
      !didLoadFromDesktopStorage ||
      !window.zennotesDesktop?.notes.onExternalChange ||
      !window.zennotesDesktop?.notes.load
    ) {
      return undefined;
    }

    const unsubscribe = window.zennotesDesktop.notes.onExternalChange(() => {
      void window.zennotesDesktop.notes.load().then((desktopNotes) => {
        if (!desktopNotes) {
          return;
        }

        setNotes(normalizeNotes(desktopNotes));
      }).catch((error) => {
        console.error('External desktop notes update could not be loaded.', error);
      });
    });

    return unsubscribe;
  }, [isNotesHydrated, didLoadFromDesktopStorage]);

  useEffect(() => {
    if (!window.zennotesDesktop?.sync?.getStatus) return;

    let cancelled = false;

    const loadSyncStatus = async () => {
      try {
        const nextStatus = await window.zennotesDesktop.sync.getStatus();
        if (!cancelled) {
          setDesktopSyncStatus(nextStatus);
        }
      } catch (error) {
        console.error('Desktop sync status could not be loaded.', error);
      }
    };

    void loadSyncStatus();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!desktopSyncStatus?.authKey || desktopSyncStatus.urls.length === 0) {
      setDesktopSyncQrDataUrl(null);
      return;
    }

    let cancelled = false;

    const preferredUrl = desktopSyncStatus.urls.find((url) => !url.includes('127.0.0.1'))
      ?? desktopSyncStatus.urls[0];

    const pairingValue = buildSyncPairingValue({
      serverUrl: preferredUrl,
      authKey: desktopSyncStatus.authKey,
      fallbackServerUrls: desktopSyncStatus.urls.filter((url) => url !== preferredUrl),
    });

    void QRCode.toDataURL(pairingValue, {
      errorCorrectionLevel: 'M',
      margin: 1,
      width: 220,
    }).then((dataUrl) => {
      if (!cancelled) {
        setDesktopSyncQrDataUrl(dataUrl);
      }
    }).catch((error) => {
      console.error('Desktop sync QR code could not be created.', error);
      if (!cancelled) {
        setDesktopSyncQrDataUrl(null);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [desktopSyncStatus]);

  const preferredDesktopSyncUrl = useMemo(() => (
    desktopSyncStatus?.urls.find((url) => !url.includes('127.0.0.1'))
    ?? desktopSyncStatus?.urls[0]
    ?? null
  ), [desktopSyncStatus]);

  useEffect(() => {
    let cancelled = false;

    if (!isBackupDirectorySupported()) {
      return undefined;
    }

    const restoreBackupDirectory = async () => {
      try {
        const storedHandle = await getStoredBackupDirectory();
        if (!storedHandle || cancelled) return;

        const permission = await getBackupDirectoryPermission(storedHandle, false);
        if (cancelled) return;

        if (permission === 'denied') {
          await clearStoredBackupDirectory().catch(() => {});
          setBackupDirectoryHandle(null);
          return;
        }

        setBackupDirectoryHandle(storedHandle);
      } catch (error) {
        await clearStoredBackupDirectory().catch(() => {});
      }
    };

    void restoreBackupDirectory();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const interval = setInterval(() => {
      setNotes(prev => purgeExpiredTrash(prev));
    }, 60_000);

    return () => clearInterval(interval);
  }, []);

  // Reminder Checker
  useEffect(() => {
    const interval = setInterval(() => {
      const now = Date.now();
      notes.forEach(note => {
        if (note.reminderAt && note.reminderActive && note.reminderAt <= now) {
          if (!activeReminders.includes(note.id)) {
            setActiveReminders(prev => [...prev, note.id]);
            // Play sound
            const audio = new Audio('https://assets.mixkit.co/active_storage/sfx/2869/2869-preview.mp3');
            audio.play().catch(() => {});
          }
        }
      });
    }, 10000);
    return () => clearInterval(interval);
  }, [notes, activeReminders]);

  const tags = useMemo(() => {
    const allTags = new Set<string>();
    notes.forEach(n => n.tags.forEach(t => allTags.add(t)));
    return Array.from(allTags);
  }, [notes]);

  const hasSearchQuery = searchQuery.trim().length > 0;
  const isTagResultsMode = !!selectedTag;
  const isCrossLocationResultsMode = hasSearchQuery || isTagResultsMode;

  const filteredNotes = useMemo(() => {
    return notes.filter(n => {
      const noteText = getNotePlainText(n.content).toLowerCase();
      const attachmentText = (n.attachments ?? []).map(attachment => attachment.name.toLowerCase()).join(' ');
      const normalizedQuery = searchQuery.toLowerCase();
      const matchesSearch = n.title.toLowerCase().includes(normalizedQuery) ||
                           noteText.includes(normalizedQuery) ||
                           attachmentText.includes(normalizedQuery);
      const matchesTag = !selectedTag || n.tags.includes(selectedTag);
      const matchesView = view === 'all'
        ? !n.isArchived && !n.isTrashed
        : view === 'favorites'
          ? n.isFavorite && !n.isArchived && !n.isTrashed
          : view === 'archive'
            ? !!n.isArchived && !n.isTrashed
            : view === 'trash'
              ? !!n.isTrashed
              : false;
      const matchesSearchScope = isTagResultsMode
        ? true
        : hasSearchQuery
        ? view === 'favorites'
          ? n.isFavorite
          : true
        : matchesView;
      return matchesSearch && matchesTag && matchesSearchScope;
    });
  }, [notes, searchQuery, selectedTag, view, hasSearchQuery, isTagResultsMode]);

  const trashedNotesCount = useMemo(
    () => notes.filter(note => note.isTrashed).length,
    [notes]
  );

  const currentViewTitle = hasSearchQuery
    ? 'Arama Sonuçları'
    : selectedTag
    ? `#${selectedTag}`
    : view === 'favorites'
      ? 'Yıldızlı Notlar'
      : view === 'archive'
        ? 'Arşiv Klasörü'
        : view === 'trash'
          ? 'Çöp Kutusu'
          : 'Not Defteri';

  const getNoteLocationLabel = (note: Note) => {
    if (note.isTrashed) return 'Çöp';
    if (note.isArchived) return 'Arşiv';
    return 'Ana Ekran';
  };

  const visibleActiveNoteIds = fullscreenNoteId
    ? activeNoteIds.filter(id => id === fullscreenNoteId)
    : activeNoteIds;

  const requestEditorFocus = useCallback((noteIds: string[]) => {
    const nextFocusNoteId = fullscreenNoteId && noteIds.includes(fullscreenNoteId)
      ? fullscreenNoteId
      : noteIds[noteIds.length - 1];

    if (!nextFocusNoteId) return;

    setEditorFocusRequest(prev => ({
      noteId: nextFocusNoteId,
      nonce: (prev?.nonce ?? 0) + 1,
    }));
  }, [fullscreenNoteId]);

  const downloadBackupFile = useCallback(() => {
    const data = JSON.stringify(notesRef.current, null, 2);
    const blob = new Blob([data], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `zennotes_backup_${format(new Date(), 'yyyyMMdd')}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  }, []);

  const persistAutoBackup = useCallback(async (
    directoryHandle: BackupDirectoryHandle,
    requestWritePermission = false,
  ) => {
    try {
      const permission = await getBackupDirectoryPermission(directoryHandle, requestWritePermission);

      if (permission !== 'granted') {
        if (permission === 'denied') {
          await clearStoredBackupDirectory().catch(() => {});
          setBackupDirectoryHandle(null);
        }
        return false;
      }

      await writeBackupSnapshot(directoryHandle, notesRef.current);
      return true;
    } catch (error) {
      if (error instanceof DOMException && (
        error.name === 'NotFoundError' ||
        error.name === 'InvalidStateError' ||
        error.name === 'SecurityError'
      )) {
        await clearStoredBackupDirectory().catch(() => {});
        setBackupDirectoryHandle(null);
        return false;
      }

      console.error('Automatic backup failed.', error);
      return false;
    }
  }, []);

  useEffect(() => {
    if (!backupDirectoryHandle || !isBackupDirectorySupported()) {
      return undefined;
    }

    const timeoutId = window.setTimeout(() => {
      void persistAutoBackup(backupDirectoryHandle, false);
    }, 800);

    return () => window.clearTimeout(timeoutId);
  }, [notes, backupDirectoryHandle, persistAutoBackup]);

  useEffect(() => {
    if (!backupDirectoryHandle || !isBackupDirectorySupported()) {
      return undefined;
    }

    const flushBackup = () => {
      void persistAutoBackup(backupDirectoryHandle, false);
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        flushBackup();
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('pagehide', flushBackup);

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('pagehide', flushBackup);
    };
  }, [backupDirectoryHandle, persistAutoBackup]);

  const handleCreateNote = () => {
    const newNote: Note = {
      id: Math.random().toString(36).substr(2, 9),
      title: '',
      content: '',
      attachments: [],
      tags: [],
      isFavorite: false,
      isArchived: false,
      isTrashed: false,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    setNotes([newNote, ...notes]);
    setActiveNoteIds(prev => [...prev, newNote.id]);
  };

  const handleSaveNote = useCallback((updatedNote: Note) => {
    setNotes(prev => prev.map(n => n.id === updatedNote.id ? updatedNote : n));
  }, []);

  const handleRemoveNote = async (id: string) => {
    const note = notes.find(n => n.id === id);
    if (!note) return;

    const shouldDeletePermanently = !!note.isTrashed;
    const confirmationMessage = shouldDeletePermanently
      ? 'Bu notu kalıcı olarak silmek istediğinize emin misiniz?'
      : 'Bu not çöp kutusuna gönderilsin mi?';

    let confirmed = false;
    try {
      if ((window as any).zennotesDesktop?.showConfirmDialog) {
        confirmed = await (window as any).zennotesDesktop.showConfirmDialog(confirmationMessage);
      } else {
        confirmed = confirm(confirmationMessage);
      }
    } catch (e) {
      console.error('IPC Dialog failed, falling back to confirm', e);
      confirmed = confirm(confirmationMessage);
    }

    if (!confirmed) {
      setTimeout(() => window.focus(), 10);
      return;
    }
    setTimeout(() => window.focus(), 10);

    const remainingActiveNoteIds = activeNoteIds.filter(aid => aid !== id);

    if (shouldDeletePermanently) {
      setNotes(prev => prev.filter(n => n.id !== id));
    } else {
      setNotes(prev => prev.map(n => (
        n.id === id
          ? {
              ...n,
              isTrashed: true,
              deletedAt: Date.now(),
              reminderActive: false,
            }
          : n
      )));
    }

    setActiveNoteIds(remainingActiveNoteIds);
    setFullscreenNoteId(prev => prev === id ? null : prev);
    setActiveReminders(prev => prev.filter(rid => rid !== id));
    requestEditorFocus(remainingActiveNoteIds);
  };

  const handleEmptyTrash = async () => {
    if (trashedNotesCount === 0) return;
    
    let confirmed = false;
    const message = 'Çöp kutusundaki tüm notlar kalıcı olarak silinsin mi?';
    try {
      if ((window as any).zennotesDesktop?.showConfirmDialog) {
        confirmed = await (window as any).zennotesDesktop.showConfirmDialog(message);
      } else {
        confirmed = confirm(message);
      }
    } catch (e) {
      console.error('IPC Dialog failed, falling back to confirm', e);
      confirmed = confirm(message);
    }

    if (!confirmed) {
      setTimeout(() => window.focus(), 10);
      return;
    }
    setTimeout(() => window.focus(), 10);

    const trashedIds = new Set(notes.filter(note => note.isTrashed).map(note => note.id));
    const remainingActiveNoteIds = activeNoteIds.filter(id => !trashedIds.has(id));
    setNotes(prev => prev.filter(note => !note.isTrashed));
    setActiveNoteIds(remainingActiveNoteIds);
    setFullscreenNoteId(prev => (prev && trashedIds.has(prev) ? null : prev));
    setActiveReminders(prev => prev.filter(id => !trashedIds.has(id)));
    requestEditorFocus(remainingActiveNoteIds);
  };

  const handleToggleFavorite = (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    setNotes(prev => prev.map(n => n.id === id ? { ...n, isFavorite: !n.isFavorite } : n));
  };

  const handleDismissReminder = useCallback((id: string) => {
    setActiveReminders(prev => prev.filter(rid => rid !== id));
    setNotes(prev => prev.map(n => (
      n.id === id
        ? {
            ...n,
            reminderAt: undefined,
            reminderActive: false,
          }
        : n
    )));
  }, []);

  const handleBackup = async () => {
    if (!isBackupDirectorySupported()) {
      downloadBackupFile();
      return;
    }

    try {
      const isFirstSetup = !backupDirectoryHandle;
      let directoryHandle = backupDirectoryHandle;

      if (!directoryHandle) {
        directoryHandle = await selectBackupDirectory();
        if (!directoryHandle) return;

        await storeBackupDirectory(directoryHandle);
        setBackupDirectoryHandle(directoryHandle);
      }

      const didWriteBackup = await persistAutoBackup(directoryHandle, true);
      if (!didWriteBackup) {
        alert('Secilen klasore yazma izni verilmedi veya klasore erisilemiyor.');
        return;
      }

      alert(
        isFirstSetup
          ? `Yedek klasoru secildi. Yedek ${AUTO_BACKUP_FILENAME} dosyasina ayni dosyanin uzerine yazilarak kaydedilecek. Uygulama kapanirken son bir yazma denemesi daha yapilacak.`
          : `Yedek ${AUTO_BACKUP_FILENAME} dosyasina guncellendi.`,
      );
    } catch (error) {
      console.error('Backup setup failed.', error);
      alert('Yedek klasoru secilirken bir sorun olustu.');
    }
  };

  const handleExportNoteAsPdf = useCallback(async (note: Note) => {
    const preparedAttachments = await renderAttachmentsForPdfExport(note.attachments ?? []);
    const suggestedFileName = (note.title || 'Basliksiz Not')
      .trim()
      .replace(/\s+/g, '_')
      .slice(0, 80) || 'Basliksiz_Not';
    const html = buildNotePdfHtml(note, { preparedAttachments });

    if (window.zennotesDesktop?.exportNoteAsPdf) {
      const filePath = await window.zennotesDesktop.exportNoteAsPdf({
        html,
        suggestedFileName,
      });

      if (filePath) {
        alert(`PDF kaydedildi:\n${filePath}`);
      }
      return;
    }

    await printHtmlAsPdf(html);
  }, []);

  const handleRestore = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (event) => {
      try {
        const data = JSON.parse(event.target?.result as string);
        if (Array.isArray(data)) {
          setNotes(normalizeNotes(data));
          alert('Yedek başarıyla yüklendi!');
        }
      } catch (err) {
        alert('Geçersiz yedek dosyası.');
      }
    };
    reader.readAsText(file);
  };

  if (!isNotesHydrated) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-bg-main px-6 text-center text-text-muted">
        Notlar yukleniyor...
      </div>
    );
  }

  return (
    <div className="flex min-h-screen bg-bg-main text-text-dark font-sans">
      <Sidebar 
        view={view} 
        setView={setView} 
        onCreateNote={handleCreateNote}
        tags={tags} 
        selectedTag={selectedTag} 
        setSelectedTag={setSelectedTag} 
      />

      <main className="flex-1 p-10 lg:p-16 overflow-y-auto">
        <header className="flex justify-between items-center mb-12">
          <div className="relative w-[400px]">
            <Search className="absolute left-6 top-1/2 -translate-y-1/2 text-text-muted" size={18} />
            <input 
              type="text" 
              placeholder="Notlarda ara..."
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              className="w-full bg-[#F1F3F5] pl-14 pr-6 py-3 rounded-full outline-none text-sm focus:ring-2 ring-accent/5 transition-all"
            />
          </div>
          <div className="flex items-center gap-4">
            {desktopSyncStatus && (
              <div className="relative">
                <button
                  type="button"
                  onClick={() => setIsSyncPanelOpen(prev => !prev)}
                  className="rounded-xl border border-border bg-white px-4 py-2 text-sm font-medium text-text-dark transition hover:bg-[#F8F9FA]"
                >
                  Telefon Senk.
                </button>

                {isSyncPanelOpen && (
                  <div className="absolute right-0 top-full z-20 mt-3 w-[24rem] rounded-3xl border border-border bg-white p-5 shadow-[0_18px_50px_rgba(0,0,0,0.12)]">
                    <div className="flex items-center justify-between gap-3">
                      <p className="text-sm font-semibold text-text-dark">Android bağlantısı</p>
                      <button
                        type="button"
                        onClick={() => setIsSyncPanelOpen(false)}
                        className="inline-flex items-center gap-2 rounded-xl border border-border bg-[#F8F9FA] px-3 py-2 text-xs font-semibold text-text-dark transition hover:bg-white"
                      >
                        <X size={14} />
                        Kapat
                      </button>
                    </div>
                    <p className="mt-2 text-xs leading-5 text-text-muted">
                      Telefonda QR tara veya alttaki adres ve anahtarı gir. Masaüstü uygulaması açık kalmalı ve iki cihaz aynı ağda olmalı.
                    </p>

                    <div className="mt-4 flex justify-center">
                      {desktopSyncQrDataUrl ? (
                        <div className="rounded-[2rem] border border-border bg-[#F8F9FA] p-3">
                          <img
                            src={desktopSyncQrDataUrl}
                            alt="ZenNotes Android eşleştirme QR kodu"
                            className="h-[220px] w-[220px] rounded-[1.25rem]"
                          />
                        </div>
                      ) : (
                        <div className="flex h-[220px] w-[220px] items-center justify-center rounded-[2rem] border border-dashed border-border bg-[#F8F9FA] px-6 text-center text-xs text-text-muted">
                          QR hazırlanıyor...
                        </div>
                      )}
                    </div>

                    <div className="mt-4 space-y-3 text-sm">
                      <div className="rounded-2xl bg-[#F8F9FA] px-4 py-3">
                        <div className="text-[11px] font-bold uppercase tracking-wide text-text-muted">PC Adresi</div>
                        <div className="mt-1 break-all font-medium text-text-dark">
                          {preferredDesktopSyncUrl ?? `http://PC_IP:${desktopSyncStatus.port}`}
                        </div>
                      </div>
                      <div className="rounded-2xl bg-[#F8F9FA] px-4 py-3">
                        <div className="text-[11px] font-bold uppercase tracking-wide text-text-muted">Anahtar</div>
                        <div className="mt-1 break-all font-medium text-text-dark">{desktopSyncStatus.authKey}</div>
                      </div>
                    </div>

                    {desktopSyncStatus.error && (
                      <p className="mt-3 text-xs text-red-600">{desktopSyncStatus.error}</p>
                    )}
                  </div>
                )}
              </div>
            )}
            <label className="p-2 hover:bg-white rounded-xl transition-all cursor-pointer text-text-muted" title="Yedekten Geri Yükle">
              <Upload size={20} />
              <input type="file" className="hidden" onChange={handleRestore} accept=".json" />
            </label>
            <button
              onClick={() => { void handleBackup(); }}
              className={cn(
                "p-2 hover:bg-white rounded-xl transition-all",
                backupDirectoryHandle ? "text-accent" : "text-text-muted"
              )}
              title={isBackupDirectorySupported() ? 'Yedek Klasoru Sec / Simdi Yedekle' : 'Yedekle'}
            >
              <Download size={20} />
            </button>
            {view === 'trash' && !hasSearchQuery && (
              <button
                onClick={handleEmptyTrash}
                disabled={trashedNotesCount === 0}
                className={cn(
                  "px-4 py-2 rounded-xl font-medium transition-all",
                  trashedNotesCount === 0
                    ? "bg-[#F1F3F5] text-text-muted cursor-not-allowed"
                    : "bg-red-500 text-white hover:bg-red-600"
                )}
              >
                Çöp Kutusunu Boşalt
              </button>
            )}
          </div>
        </header>

        <section className="mb-10">
          <h1 className="font-serif text-5xl mb-2">
            {currentViewTitle}
          </h1>
          <p className="text-text-muted">
            {hasSearchQuery
              ? `Arama sonuçları ana ekran, arşiv ve çöp klasörlerinden gösteriliyor. ${filteredNotes.length} not bulundu.`
              : isTagResultsMode
              ? `Bu etiketle eşleşen notlar ana ekran, arşiv ve çöp klasörlerinden birlikte gösteriliyor. ${filteredNotes.length} not bulundu.`
              : view === 'trash'
              ? `Toplam ${filteredNotes.length} not çöp kutusunda. Notlar 10 gün sonra otomatik silinir.`
              : `Toplam ${filteredNotes.length} notunuz var.`}
          </p>
        </section>

        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6">
          {filteredNotes.map(note => (
            <NoteCard 
              key={note.id} 
              note={note} 
              onClick={() => setActiveNoteIds(prev => prev.includes(note.id) ? prev : [...prev, note.id])}
              onToggleFavorite={(e) => handleToggleFavorite(e, note.id)}
              onDelete={(e) => {
                e.stopPropagation();
                handleRemoveNote(note.id);
              }}
              locationLabel={isCrossLocationResultsMode ? getNoteLocationLabel(note) : undefined}
            />
          ))}
          {view !== 'archive' && view !== 'trash' && <motion.div 
            whileHover={{ scale: 1.02 }}
            onClick={handleCreateNote}
            className="border-2 border-dashed border-border rounded-2xl p-6 flex flex-col items-center justify-center text-text-muted hover:text-text-dark hover:border-text-muted transition-all cursor-pointer min-h-[200px]"
          >
            <Plus size={32} className="mb-2" />
            <span className="text-sm font-medium">Yeni bir not oluştur</span>
          </motion.div>}
        </div>
      </main>

      <div
        className={cn(
          "fixed inset-0 pointer-events-none z-50 flex items-center justify-center overflow-x-auto",
          fullscreenNoteId ? "p-4" : "gap-4 p-10"
        )}
      >
        <AnimatePresence>
          {visibleActiveNoteIds.map((id) => {
            const note = notes.find(n => n.id === id);
            if (!note) return null;
            const isFullscreen = fullscreenNoteId === id;
            return (
              <div
                key={id}
                className={cn(
                  "pointer-events-auto shrink-0 transition-all duration-200",
                  isFullscreen
                    ? "w-[calc(100vw-2rem)] max-w-none h-[calc(100vh-2rem)]"
                    : "w-full max-w-2xl h-[80vh]"
                )}
              >
                <Editor 
                  note={note} 
                  availableTags={tags}
                  onClose={() => {
                    setActiveNoteIds(prev => prev.filter(aid => aid !== id));
                    setFullscreenNoteId(prev => prev === id ? null : prev);
                  }} 
                  onSave={handleSaveNote}
                  onDelete={handleRemoveNote}
                  onExportPdf={handleExportNoteAsPdf}
                  isFullscreen={isFullscreen}
                  focusRequestNonce={editorFocusRequest?.noteId === id ? editorFocusRequest.nonce : -1}
                  onMaximize={() => setFullscreenNoteId(id)}
                  onMinimize={() => setFullscreenNoteId(null)}
                />
              </div>
            );
          })}
        </AnimatePresence>
      </div>

      <AnimatePresence>
        {activeReminders.map(id => {
          const note = notes.find(n => n.id === id);
          if (!note) return null;
          return (
            <ReminderAlert 
              key={id} 
              note={note} 
              onDismiss={() => handleDismissReminder(id)} 
            />
          );
        })}
      </AnimatePresence>
    </div>
  );
}

export default function App() {
  return shouldUseMobileApp() ? <MobileApp /> : <DesktopApp />;
}
