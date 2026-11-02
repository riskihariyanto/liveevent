export const MAX_TEXT = 150;
export const MAX_NICK = 20;
export const COLORS = ['#ef4444', '#f97316', '#eab308', '#22c55e', '#06b6d4', '#3b82f6', '#a855f7', '#ec4899'];
export const HEX_COLOR = /^#[0-9a-f]{6}$/i;
export const EMOTES = {
  heart: '❤️',
  fire: '🔥',
  clap: '👏',
  laugh: '😂',
  wow: '😮',
  party: '🎉'
};
export const DEFAULT_WORDS = [
  'anjing', 'bangsat', 'babi', 'kontol', 'memek', 'tolol', 'goblok',
  'fuck', 'shit', 'bitch', 'asshole'
];

export function cleanText(value, max) {
  if (typeof value !== 'string') return '';
  const flat = value
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b\u200c\u200e\u200f\u2028-\u202e\u2060-\u206f\ufeff]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return Array.from(flat).slice(0, max).join('');
}

export function clip(value, max) {
  return Array.from(value).slice(0, max).join('');
}

export function textOn(hex) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return (r * 299 + g * 587 + b * 114) / 1000 > 150 ? '#0b0d12' : '#ffffff';
}

export function buildCensor(words) {
  const list = (Array.isArray(words) ? words : [])
    .map((word) => cleanText(String(word), 30).toLowerCase())
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);
  if (!list.length) return (text) => text;
  const escaped = list.map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const pattern = new RegExp(escaped.join('|'), 'giu');
  return (text) => text.replace(pattern, '***');
}
