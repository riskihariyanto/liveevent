'use strict';

const http = require('http');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { WebSocketServer, WebSocket } = require('ws');

const PORT = Number(process.env.PORT) || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin';
const PUBLIC_DIR = path.join(__dirname, 'public');

const MAX_TEXT = 150;
const MAX_NICK = 20;
const MAX_WORD = 30;
const WORDS_MAX = 500;
const QUEUE_MAX = 500;
const STAGE_BUFFER_MAX = 100;
const CHAT_COOLDOWN_MS = 3000;
const EMOTE_MAX_PER_SEC = 10;
const EMOTE_FLUSH_MS = 200;
const STAGE_DRAIN_MS = 250;
const HEARTBEAT_MS = 30000;
const ONLINE_BROADCAST_MS = 3000;
const TRACKER_TTL_MS = 30 * 60 * 1000;
const MAX_AUTH_FAILURES = 5;
const DEFAULT_COLOR = '#ffffff';

const HEX_COLOR = /^#[0-9a-f]{6}$/i;
const DEVICE_ID = /^[A-Za-z0-9_-]{8,64}$/;
const ROLES = new Set(['audience', 'admin', 'stage']);
const EMOTES = new Set(['❤️', '🔥', '👏', '😂', '😮', '🎉']);
const DEFAULT_WORDS = [
  'anjing', 'bangsat', 'babi', 'kontol', 'memek', 'tolol', 'goblok',
  'fuck', 'shit', 'bitch', 'asshole'
];

const state = {
  mode: 'auto',
  banned: new Map(),
  words: [],
  pattern: null
};

const pending = new Map();
const stageBuffer = [];
const trackers = new Map();
const nicknames = new Map();
const audience = new Set();
const admins = new Set();
const stages = new Set();

let idCounter = 0;
let lastOnline = -1;
let emoteCounts = Object.create(null);
let emoteDirty = false;

function nextId() {
  idCounter += 1;
  return Date.now().toString(36) + idCounter.toString(36);
}

function digest(value) {
  return crypto.createHash('sha256').update(String(value)).digest();
}

function passwordMatches(candidate) {
  if (typeof candidate !== 'string') return false;
  return crypto.timingSafeEqual(digest(candidate), digest(ADMIN_PASSWORD));
}

function cleanText(value, limit) {
  if (typeof value !== 'string') return '';
  const flat = value
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b\u200c\u200e\u200f\u2028-\u202e\u2060-\u206f\ufeff]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return Array.from(flat).slice(0, limit).join('');
}

function setWords(list) {
  const unique = new Set();
  for (const item of Array.isArray(list) ? list : []) {
    const word = cleanText(item, MAX_WORD).toLowerCase();
    if (word) unique.add(word);
  }
  state.words = Array.from(unique)
    .slice(0, WORDS_MAX)
    .sort((a, b) => b.length - a.length);
  if (!state.words.length) {
    state.pattern = null;
    return;
  }
  const escaped = state.words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  state.pattern = new RegExp(escaped.join('|'), 'giu');
}

function censor(text) {
  return state.pattern ? text.replace(state.pattern, '***') : text;
}

function send(ws, payload) {
  if (ws.readyState === WebSocket.OPEN) ws.send(payload);
}

function sendJson(ws, data) {
  send(ws, JSON.stringify(data));
}

function broadcast(group, data) {
  if (!group.size) return;
  const payload = JSON.stringify(data);
  for (const ws of group) send(ws, payload);
}

function adminState() {
  return {
    type: 'state',
    mode: state.mode,
    banned: Array.from(state.banned, ([deviceId, nickname]) => ({ deviceId, nickname })),
    words: state.words,
    onlineCount: audience.size
  };
}

function stageState() {
  return { type: 'state', mode: state.mode, onlineCount: audience.size };
}

function broadcastState() {
  broadcast(admins, adminState());
  broadcast(stages, stageState());
}

function toStage(entry) {
  return {
    type: 'chat:new',
    id: entry.id,
    nickname: entry.nickname,
    text: entry.text,
    color: entry.color,
    ts: entry.ts
  };
}

function trackerFor(deviceId) {
  let tracker = trackers.get(deviceId);
  if (!tracker) {
    tracker = { lastChat: 0, emoteWindow: 0, emoteCount: 0, seen: 0 };
    trackers.set(deviceId, tracker);
  }
  tracker.seen = Date.now();
  return tracker;
}

function enqueueStage(entry) {
  stageBuffer.push(entry);
  while (stageBuffer.length > STAGE_BUFFER_MAX) stageBuffer.shift();
}

function enqueuePending(entry) {
  pending.set(entry.id, entry);
  if (pending.size > QUEUE_MAX) {
    const oldest = pending.keys().next().value;
    pending.delete(oldest);
    broadcast(admins, { type: 'queue:remove', id: oldest });
  }
  broadcast(admins, { type: 'queue:add', ...entry });
}

function drainStage() {
  if (!stages.size || !stageBuffer.length) return;
  const count = Math.min(stageBuffer.length, 1 + Math.floor(stageBuffer.length / 25));
  for (let i = 0; i < count; i += 1) {
    broadcast(stages, toStage(stageBuffer.shift()));
  }
}

function flushEmotes() {
  if (!emoteDirty) return;
  const counts = emoteCounts;
  emoteCounts = Object.create(null);
  emoteDirty = false;
  if (stages.size) broadcast(stages, { type: 'emote:batch', counts });
}

function handleJoin(ws, msg) {
  if (ws.role !== 'audience') return;
  const deviceId = typeof msg.deviceId === 'string' && DEVICE_ID.test(msg.deviceId) ? msg.deviceId : null;
  const nickname = censor(cleanText(msg.nickname, MAX_NICK));
  if (!deviceId || !nickname) {
    sendJson(ws, { type: 'error', code: 'invalid_join', message: 'Nickname tidak valid.' });
    return;
  }
  ws.deviceId = deviceId;
  ws.nickname = nickname;
  nicknames.set(deviceId, nickname);
  audience.add(ws);
  sendJson(ws, {
    type: 'joined',
    ok: true,
    banned: state.banned.has(deviceId),
    mode: state.mode
  });
}

function handleChat(ws, msg) {
  if (ws.role !== 'audience' || !ws.deviceId) return;
  if (state.banned.has(ws.deviceId)) return;

  const now = Date.now();
  const tracker = trackerFor(ws.deviceId);
  const wait = CHAT_COOLDOWN_MS - (now - tracker.lastChat);
  if (wait > 0) {
    sendJson(ws, {
      type: 'error',
      code: 'rate_limited',
      message: 'Tunggu sebentar sebelum mengirim pesan lagi.',
      retryMs: wait
    });
    return;
  }

  const text = cleanText(msg.text, MAX_TEXT);
  if (!text) return;
  tracker.lastChat = now;

  const color = typeof msg.color === 'string' && HEX_COLOR.test(msg.color)
    ? msg.color.toLowerCase()
    : DEFAULT_COLOR;

  const entry = {
    id: nextId(),
    deviceId: ws.deviceId,
    nickname: ws.nickname,
    text: censor(text),
    color,
    ts: now
  };

  if (state.mode === 'auto') enqueueStage(entry);
  else enqueuePending(entry);

  sendJson(ws, { type: 'chat:ack', id: entry.id, mode: state.mode });
}

function handleEmote(ws, msg) {
  if (ws.role !== 'audience' || !ws.deviceId) return;
  if (state.banned.has(ws.deviceId)) return;
  if (typeof msg.emoji !== 'string' || !EMOTES.has(msg.emoji)) return;

  const now = Date.now();
  const tracker = trackerFor(ws.deviceId);
  if (now - tracker.emoteWindow >= 1000) {
    tracker.emoteWindow = now;
    tracker.emoteCount = 0;
  }
  tracker.emoteCount += 1;
  if (tracker.emoteCount > EMOTE_MAX_PER_SEC) return;

  emoteCounts[msg.emoji] = (emoteCounts[msg.emoji] || 0) + 1;
  emoteDirty = true;
}

function authenticateAdmin(ws, msg) {
  if (ws.authed) return;
  if (!passwordMatches(msg.password)) {
    ws.authFailures += 1;
    sendJson(ws, { type: 'admin:auth', ok: false });
    if (ws.authFailures >= MAX_AUTH_FAILURES) ws.close(1008, 'too many attempts');
    return;
  }
  ws.authed = true;
  admins.add(ws);
  sendJson(ws, { type: 'admin:auth', ok: true });
  sendJson(ws, adminState());
  sendJson(ws, { type: 'queue:snapshot', items: Array.from(pending.values()) });
}

function approveEntry(id) {
  const entry = pending.get(id);
  if (!entry) return;
  pending.delete(id);
  broadcast(stages, toStage(entry));
  broadcast(admins, { type: 'queue:remove', id });
}

function rejectEntry(id) {
  if (!pending.delete(id)) return;
  broadcast(admins, { type: 'queue:remove', id });
}

function banDevice(deviceId) {
  if (typeof deviceId !== 'string' || !DEVICE_ID.test(deviceId)) return;
  state.banned.set(deviceId, nicknames.get(deviceId) || '');

  for (const [id, entry] of pending) {
    if (entry.deviceId !== deviceId) continue;
    pending.delete(id);
    broadcast(admins, { type: 'queue:remove', id });
  }
  for (let i = stageBuffer.length - 1; i >= 0; i -= 1) {
    if (stageBuffer[i].deviceId === deviceId) stageBuffer.splice(i, 1);
  }
  for (const ws of audience) {
    if (ws.deviceId === deviceId) sendJson(ws, { type: 'banned' });
  }
  broadcastState();
}

function unbanDevice(deviceId) {
  if (typeof deviceId !== 'string' || !state.banned.delete(deviceId)) return;
  broadcastState();
}

function handleAdmin(ws, msg) {
  if (msg.type === 'admin:auth') {
    authenticateAdmin(ws, msg);
    return;
  }
  if (!ws.authed) {
    sendJson(ws, { type: 'error', code: 'unauthorized', message: 'Belum login.' });
    return;
  }
  switch (msg.type) {
    case 'admin:mode':
      if (msg.mode !== 'auto' && msg.mode !== 'manual') return;
      state.mode = msg.mode;
      broadcastState();
      break;
    case 'admin:approve':
      if (typeof msg.id === 'string') approveEntry(msg.id);
      break;
    case 'admin:reject':
      if (typeof msg.id === 'string') rejectEntry(msg.id);
      break;
    case 'admin:ban':
      banDevice(msg.deviceId);
      break;
    case 'admin:unban':
      unbanDevice(msg.deviceId);
      break;
    case 'admin:words':
      setWords(msg.list);
      broadcast(admins, adminState());
      break;
    default:
      break;
  }
}

function route(ws, msg) {
  switch (msg.type) {
    case 'join':
      handleJoin(ws, msg);
      break;
    case 'chat':
      handleChat(ws, msg);
      break;
    case 'emote':
      handleEmote(ws, msg);
      break;
    default:
      if (ws.role === 'admin' && msg.type.startsWith('admin:')) handleAdmin(ws, msg);
      break;
  }
}

setWords(DEFAULT_WORDS);

if (!process.env.ADMIN_PASSWORD) {
  console.warn('ADMIN_PASSWORD belum diatur, memakai nilai bawaan "admin".');
}

const app = express();
app.disable('x-powered-by');
app.get('/healthz', (req, res) => {
  res.json({ ok: true, online: audience.size, mode: state.mode });
});
app.use(express.static(PUBLIC_DIR, { extensions: ['html'], maxAge: 0 }));

const server = http.createServer(app);
const wss = new WebSocketServer({
  server,
  path: '/ws',
  maxPayload: 4096,
  perMessageDeflate: false
});

wss.on('connection', (ws, req) => {
  const role = new URL(req.url, 'http://localhost').searchParams.get('role');
  if (!ROLES.has(role)) {
    ws.close(1008, 'invalid role');
    return;
  }

  ws.role = role;
  ws.alive = true;
  ws.deviceId = null;
  ws.nickname = '';
  ws.authed = false;
  ws.authFailures = 0;

  if (role === 'stage') {
    stages.add(ws);
    sendJson(ws, stageState());
  }

  ws.on('pong', () => {
    ws.alive = true;
  });

  ws.on('message', (data, isBinary) => {
    if (isBinary) return;
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch (err) {
      return;
    }
    if (!msg || typeof msg.type !== 'string') return;
    try {
      route(ws, msg);
    } catch (err) {
      console.error('handler error:', err);
    }
  });

  ws.on('close', () => {
    audience.delete(ws);
    admins.delete(ws);
    stages.delete(ws);
  });

  ws.on('error', () => {});
});

const timers = [
  setInterval(drainStage, STAGE_DRAIN_MS),
  setInterval(flushEmotes, EMOTE_FLUSH_MS),
  setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.alive) {
        ws.terminate();
        continue;
      }
      ws.alive = false;
      ws.ping();
    }
  }, HEARTBEAT_MS),
  setInterval(() => {
    if (audience.size === lastOnline) return;
    lastOnline = audience.size;
    broadcastState();
  }, ONLINE_BROADCAST_MS),
  setInterval(() => {
    const cutoff = Date.now() - TRACKER_TTL_MS;
    for (const [id, tracker] of trackers) {
      if (tracker.seen < cutoff) trackers.delete(id);
    }
  }, 5 * 60 * 1000)
];

function shutdown() {
  for (const timer of timers) clearInterval(timer);
  for (const ws of wss.clients) ws.close(1001, 'server shutdown');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

server.listen(PORT, '0.0.0.0', () => {
  console.log('LiveEvent server listening on port ' + PORT);
});
