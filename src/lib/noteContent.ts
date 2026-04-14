const escapeHtml = (value: string) => (
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
);

const isHtmlLike = (value: string) => /<\/?[a-z][\s\S]*>/i.test(value);

export const getNotePlainText = (content: string) => {
  if (!content) return '';

  if (typeof DOMParser !== 'undefined') {
    const source = isHtmlLike(content) ? content : content.replace(/\n/g, '<br />');
    const doc = new DOMParser().parseFromString(source, 'text/html');
    return (doc.body.textContent ?? '')
      .replace(/\u00a0/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  return content
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
};

export const getMobilePlainText = (content: string, options?: { trim?: boolean }): string => {
  const shouldTrim = options?.trim ?? true;
  if (!content) return '';

  if (!isHtmlLike(content)) {
    const normalizedText = content.replace(/\u00a0/g, ' ');
    return shouldTrim ? normalizedText.trim() : normalizedText;
  }

  if (typeof DOMParser !== 'undefined') {
    const prepared = content
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/p>/gi, '\n')
      .replace(/<\/h[1-6]>/gi, '\n')
      .replace(/<\/li>/gi, '\n')
      .replace(/<\/tr>/gi, '\n');

    const doc = new DOMParser().parseFromString(prepared, 'text/html');
    const normalizedText = (doc.body.textContent ?? '')
      .replace(/\u00a0/g, ' ')
      .replace(/\n{3,}/g, '\n\n');

    return shouldTrim ? normalizedText.trim() : normalizedText;
  }

  const normalizedText = content
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n');

  return shouldTrim ? normalizedText.trim() : normalizedText;
};

export const plainTextToHtml = (text: string): string => {
  if (text.length === 0) return '<p></p>';

  const paragraphs = text
    .replace(/\r\n/g, '\n')
    .split(/\n{2,}/)
    .map((paragraph) => `<p>${escapeHtml(paragraph).replace(/\n/g, '<br />')}</p>`);

  return paragraphs.join('') || '<p></p>';
};

export const normalizeRichTextContent = (content: string) => {
  const trimmed = content.trim();
  if (!trimmed) return '';
  return getNotePlainText(trimmed) ? trimmed : '';
};

export const toEditorContent = (content: string) => {
  const trimmed = content.trim();
  if (!trimmed) return '<p></p>';
  if (isHtmlLike(trimmed)) return trimmed;

  const paragraphs = trimmed
    .split(/\n{2,}/)
    .map((paragraph) => `<p>${escapeHtml(paragraph).replace(/\n/g, '<br />')}</p>`)
    .join('');

  return paragraphs || '<p></p>';
};

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

export const formatDictationChunk = (value: string, previousText: string) => {
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
