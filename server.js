'use strict';
// House of Mercy Content Hub – shared workspace server (no external dependencies).
// Structure: User -> Workspace Membership -> Workspace -> Workspace Data.
// Every data row carries a workspace_id, and every workspace route checks membership first.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const PORT = +process.env.PORT || 8000;
const DB_FILE = process.env.HOM_DB || path.join(__dirname, 'data', 'hom.db');
const ROOT = __dirname;
const ROLES = ['Admin', 'Editor', 'Contributor'];
const COLLECTIONS = ['ideas', 'reminders', 'goals', 'analytics', 'hashtagSets', 'imports', 'calendarEvents'];
const KV_KEYS = ['settings', 'lastGeneration'];
const STAGES = ['Ideas', 'Developing', 'Review', 'Approved', 'Planned'];
const COMMENT_TARGETS = ['ideas', 'reminders', 'goals'];
const SESSION_DAYS = 30;
const DEFAULT_WORKSPACE = 'house-of-mercy';

fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
const db = new DatabaseSync(DB_FILE);
db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE COLLATE NOCASE, first_name TEXT NOT NULL, last_name TEXT NOT NULL, name TEXT NOT NULL, pw_salt TEXT NOT NULL, pw_hash TEXT NOT NULL, password_requires_change INTEGER NOT NULL DEFAULT 0, account_status TEXT NOT NULL DEFAULT 'Active', created_at TEXT NOT NULL, last_login TEXT);
CREATE TABLE IF NOT EXISTS workspaces(id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS memberships(workspace_id TEXT NOT NULL REFERENCES workspaces(id), user_id TEXT NOT NULL REFERENCES users(id), role TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(workspace_id, user_id));
CREATE TABLE IF NOT EXISTS sessions(token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), expires_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS items(workspace_id TEXT NOT NULL REFERENCES workspaces(id), collection TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, seq INTEGER NOT NULL, PRIMARY KEY(workspace_id, collection, id));
CREATE TABLE IF NOT EXISTS kv(workspace_id TEXT NOT NULL REFERENCES workspaces(id), key TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(workspace_id, key));
CREATE TABLE IF NOT EXISTS comments(id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id), target_kind TEXT NOT NULL, target_id TEXT NOT NULL, parent_id TEXT, user_id TEXT NOT NULL, user_name TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS activity(id INTEGER PRIMARY KEY AUTOINCREMENT, workspace_id TEXT NOT NULL REFERENCES workspaces(id), user_id TEXT, user_name TEXT NOT NULL, text TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_items_ws ON items(workspace_id, collection);
CREATE INDEX IF NOT EXISTS idx_comments_ws ON comments(workspace_id, target_kind, target_id);
CREATE INDEX IF NOT EXISTS idx_activity_ws ON activity(workspace_id, id);
`);
const userColumns = db.prepare('PRAGMA table_info(users)').all().map(c => c.name);
if (!userColumns.includes('username')) {
  db.exec('PRAGMA foreign_keys=OFF; CREATE TABLE users_new(id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE COLLATE NOCASE, first_name TEXT NOT NULL, last_name TEXT NOT NULL, name TEXT NOT NULL, pw_salt TEXT NOT NULL, pw_hash TEXT NOT NULL, password_requires_change INTEGER NOT NULL DEFAULT 0, account_status TEXT NOT NULL DEFAULT \'Active\', created_at TEXT NOT NULL, last_login TEXT);');
  const legacyUsers = db.prepare('SELECT id,email,name,pw_salt,pw_hash,created_at FROM users ORDER BY created_at,id').all();
  const insertLegacy = db.prepare('INSERT INTO users_new(id,username,first_name,last_name,name,pw_salt,pw_hash,created_at) VALUES(?,?,?,?,?,?,?,?)');
  const used = new Set();
  for (const user of legacyUsers) {
    const name = String(user.name || '').trim().slice(0, 80) || 'House of Mercy Member';
    const parts = name.split(/\s+/);
    const rawBase = String(user.email || '').split('@')[0].replace(/[^A-Za-z0-9_-]/g, '').slice(0, 24);
    const base = rawBase.length >= 3 ? rawBase : `${rawBase || 'New'}User`;
    let username = base, suffix = 1;
    while (used.has(username.toLowerCase())) username = `${base.slice(0, 26)}${suffix++}`;
    used.add(username.toLowerCase());
    insertLegacy.run(user.id, username, parts[0] || 'Member', parts.slice(1).join(' ') || '', name, user.pw_salt, user.pw_hash, user.created_at);
  }
  db.exec('DROP TABLE users; ALTER TABLE users_new RENAME TO users; PRAGMA foreign_keys=ON;');
  db.exec('DROP TABLE IF EXISTS invitations');
}
const now = () => new Date().toISOString();
const uid = () => crypto.randomUUID();
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
db.prepare('INSERT OR IGNORE INTO workspaces(id,name,created_at) VALUES(?,?,?)').run(DEFAULT_WORKSPACE, 'House of Mercy', now());

class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
const tx = fn => { db.exec('BEGIN'); try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; } };

// ---------- accounts ----------
const hashPassword = (pw, salt = crypto.randomBytes(16).toString('hex')) => ({ salt, hash: crypto.scryptSync(pw, salt, 64).toString('hex') });
function verifyPassword(pw, user) {
  const a = Buffer.from(hashPassword(pw, user.pw_salt).hash, 'hex'), b = Buffer.from(user.pw_hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
const cleanText = (s, max) => String(s || '').trim().slice(0, max);
const cleanUsername = u => String(u || '').trim().toLowerCase();
const validUsername = u => /^[A-Za-z0-9_-]{3,30}$/.test(String(u || ''));
const validPassword = p => typeof p === 'string' && p.length >= 8 && p.length <= 200;

let authConfigured = true;
if (!db.prepare('SELECT 1 FROM users LIMIT 1').get()) {
  const password = process.env.HOM_ADMIN_INITIAL_PASSWORD;
  if (!password || !validPassword(password)) {
    // Do not crash: the API reports a safe "not configured" error instead of the browser seeing a dead server.
    authConfigured = false;
    console.error('Authentication is not configured: set HOM_ADMIN_INITIAL_PASSWORD (8-200 characters) to provision the initial HOMMediaAdmin account.');
  } else {
    const { salt, hash } = hashPassword(password);
    const id = uid(), created = now();
    db.prepare('INSERT INTO users(id,username,first_name,last_name,name,pw_salt,pw_hash,password_requires_change,account_status,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
      .run(id, 'HOMMediaAdmin', 'House of Mercy', 'Admin', 'House of Mercy Admin', salt, hash, 1, 'Pending Password Setup', created);
    db.prepare('INSERT INTO memberships(workspace_id,user_id,role,created_at) VALUES(?,?,?,?)').run(DEFAULT_WORKSPACE, id, 'Admin', created);
  }
}

const publicUser = user => ({
  id: user.id, username: user.username, firstName: user.firstName || user.first_name,
  lastName: user.lastName || user.last_name, name: user.name,
  passwordRequiresChange: !!(user.passwordRequiresChange ?? user.password_requires_change),
  accountStatus: user.accountStatus || user.account_status || 'Active'
});

function createSession(res, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const exp = new Date(Date.now() + SESSION_DAYS * 864e5).toISOString();
  db.prepare('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)').run(sha(token), userId, exp);
  res.setHeader('Set-Cookie', `hom_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_DAYS * 86400}${process.env.HOM_SECURE_COOKIE ? '; Secure' : ''}`);
}
function sessionUser(req) {
  const m = /(?:^|;\s*)hom_session=([a-f0-9]{64})/.exec(req.headers.cookie || '');
  if (!m) return null;
  const row = db.prepare('SELECT u.id,u.username,u.first_name firstName,u.last_name lastName,u.name,u.password_requires_change passwordRequiresChange,u.account_status accountStatus,s.expires_at FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=?').get(sha(m[1]));
  if (!row) return null;
  if (row.expires_at < now()) { db.prepare('DELETE FROM sessions WHERE token_hash=?').run(sha(m[1])); return null; }
  if (row.accountStatus === 'Suspended') return null;
  return { ...row, tokenHash: sha(m[1]) };
}
const attempts = new Map();
function throttle(key) {
  const t = Date.now(), list = (attempts.get(key) || []).filter(x => t - x < 15 * 60e3);
  if (list.length >= 10) throw new HttpError(429, 'Too many attempts. Please try again in a few minutes.');
  list.push(t); attempts.set(key, list);
  if (attempts.size > 5000) for (const [k, l] of attempts) if (t - l[l.length - 1] > 15 * 60e3) attempts.delete(k);
}

// ---------- workspaces / memberships ----------
function membership(workspaceId, userId) {
  return db.prepare('SELECT role FROM memberships WHERE workspace_id=? AND user_id=?').get(workspaceId, userId) || null;
}
function requireMember(user, workspaceId) {
  if (user.passwordRequiresChange) throw new HttpError(403, 'Change your temporary password before continuing.');
  const m = membership(workspaceId, user.id);
  if (!m) throw new HttpError(404, 'Workspace not found.'); // do not reveal other workspaces exist
  return m.role;
}
function log(workspaceId, user, text) {
  db.prepare('INSERT INTO activity(workspace_id,user_id,user_name,text,created_at) VALUES(?,?,?,?,?)').run(workspaceId, user ? user.id : null, user ? user.name : 'Someone', text, now());
}
function workspacesFor(userId) {
  return db.prepare('SELECT w.id,w.name,m.role FROM memberships m JOIN workspaces w ON w.id=m.workspace_id WHERE m.user_id=? ORDER BY w.created_at').all(userId);
}
function adminCount(workspaceId) {
  return db.prepare("SELECT COUNT(*) c FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.workspace_id=? AND m.role='Admin' AND u.account_status!='Suspended'").get(workspaceId).c;
}

// ---------- workspace data ----------
function loadData(workspaceId) {
  const data = {};
  COLLECTIONS.forEach(c => data[c] = db.prepare('SELECT data FROM items WHERE workspace_id=? AND collection=? ORDER BY seq DESC').all(workspaceId, c).map(r => JSON.parse(r.data)));
  data.settings = { notifications: true };
  KV_KEYS.forEach(k => { const r = db.prepare('SELECT data FROM kv WHERE workspace_id=? AND key=?').get(workspaceId, k); if (r) data[k] = JSON.parse(r.data); });
  return data;
}
function fullState(workspaceId, user, role) {
  const ws = db.prepare('SELECT id,name FROM workspaces WHERE id=?').get(workspaceId);
  const members = db.prepare('SELECT u.id,u.name,u.username,u.account_status accountStatus,u.password_requires_change passwordRequiresChange,m.role FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.workspace_id=? ORDER BY m.created_at').all(workspaceId)
    .map(m => ({ ...m, status: m.accountStatus === 'Suspended' ? 'Suspended' : m.passwordRequiresChange ? 'Pending Password Setup' : 'Active' }));
  const out = {
    workspace: ws, me: { ...publicUser(user), role },
    workspaces: workspacesFor(user.id), data: loadData(workspaceId), members,
    comments: db.prepare('SELECT id,target_kind targetKind,target_id targetId,parent_id parentId,user_id userId,user_name author,body text,created_at at FROM comments WHERE workspace_id=? ORDER BY created_at').all(workspaceId),
    activity: db.prepare('SELECT id,user_id userId,user_name userName,text,created_at at FROM activity WHERE workspace_id=? ORDER BY id DESC LIMIT 100').all(workspaceId),
    invitations: [],
  };
  return out;
}

const KIND_LABEL = { ideas: 'content idea', reminders: 'reminder', goals: 'goal', hashtagSets: 'hashtag set', analytics: 'analytics record', imports: 'import', calendarEvents: 'calendar event' };
const titleOf = it => `“${cleanText(it.title || it.name || 'Untitled', 80)}”`;
const isOwnerOrAssignee = (it, user) => it && (it.createdBy === user.id || it.assigneeId === user.id);

// Role rules for writing workspace data.
function canWriteCollection(role, collection) {
  if (role === 'Admin' || role === 'Editor') return true;
  return collection === 'ideas'; // Contributors work only with ideas
}

const CAL_STATUSES = ['Idea', 'Planned', 'In Progress', 'Ready to Post', 'Scheduled', 'Published', 'Cancelled'];
const CAL_FORMATS = ['', 'Reel', 'Video', 'Image', 'Carousel', 'Story', 'Text post'];
const CAL_PLATFORMS = ['', 'Instagram', 'Facebook', 'TikTok', 'YouTube', 'Threads'];
const CAL_TEXT = { title: 140, description: 2000, pillar: 100, caption: 2200, hook: 300, onScreenText: 500, cta: 300, hashtags: 1000, notes: 2000, ideaId: 80 };
const METRIC_KEYS = ['reach', 'likes', 'shares', 'watchTime', 'avgPlayTime', 'views', 'viewers', 'interactions', 'comments', 'saves', 'linkClicks', 'replies', 'follows'];
function validDate(d) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(d ?? ''));
  if (!m) return false;
  const dt = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return dt.getUTCFullYear() === +m[1] && dt.getUTCMonth() === +m[2] - 1 && dt.getUTCDate() === +m[3];
}
// Server-side validation so the API (not just the browser) rejects malformed calendar events and analytics records.
function validateCollectionItem(collection, item) {
  if (collection === 'calendarEvents') {
    for (const [k, max] of Object.entries(CAL_TEXT)) {
      if (item[k] === undefined || item[k] === null) { item[k] = ''; continue; }
      if (typeof item[k] !== 'string') throw new HttpError(400, `Invalid ${k}.`);
      if (item[k].length > max) throw new HttpError(400, `${k} is too long.`);
    }
    item.title = item.title.trim();
    if (!item.title) throw new HttpError(400, 'A calendar event needs a title.');
    if (!validDate(item.date)) throw new HttpError(400, 'A calendar event needs a valid date (YYYY-MM-DD).');
    item.time = item.time ?? '';
    if (item.time !== '' && !/^([01]\d|2[0-3]):[0-5]\d$/.test(String(item.time))) throw new HttpError(400, 'Invalid time (use HH:MM).');
    item.platform = item.platform ?? ''; item.format = item.format ?? ''; item.status = item.status || 'Idea';
    if (!CAL_PLATFORMS.includes(item.platform)) throw new HttpError(400, 'Unknown platform.');
    if (!CAL_FORMATS.includes(item.format)) throw new HttpError(400, 'Unknown content format.');
    if (!CAL_STATUSES.includes(item.status)) throw new HttpError(400, 'Unknown calendar status.');
  }
  if (collection === 'analytics') {
    for (const k of METRIC_KEYS) {
      const v = item[k];
      if (v === undefined || v === null || v === '') { delete item[k]; continue; } // missing stays missing, never zero
      if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) throw new HttpError(400, `${k} must be a non-negative number or left blank.`);
    }
    if (item.date !== undefined && item.date !== '' && !validDate(item.date)) throw new HttpError(400, 'Invalid date published.');
    for (const k of ['title', 'platform', 'externalId', 'calendarEventId', 'dateOriginal']) if (item[k] !== undefined && (typeof item[k] !== 'string' || item[k].length > 500)) throw new HttpError(400, `Invalid ${k}.`);
  }
}

function applyItemOps(workspaceId, user, role, collection, upsert, remove) {
  if (!COLLECTIONS.includes(collection)) throw new HttpError(400, 'Unknown collection.');
  if (!canWriteCollection(role, collection)) throw new HttpError(403, 'Your role cannot change this content.');
  if (!Array.isArray(upsert) || !Array.isArray(remove)) throw new HttpError(400, 'Invalid request.');
  const members = new Map(db.prepare('SELECT u.id,u.name FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.workspace_id=?').all(workspaceId).map(m => [m.id, m.name]));
  const get = db.prepare('SELECT data FROM items WHERE workspace_id=? AND collection=? AND id=?');
  const put = db.prepare('INSERT INTO items(workspace_id,collection,id,data,seq) VALUES(?,?,?,?,?) ON CONFLICT(workspace_id,collection,id) DO UPDATE SET data=excluded.data');
  const seqRow = db.prepare('SELECT COALESCE(MAX(seq),0)+1 s FROM items WHERE workspace_id=?');
  let created = 0, quiet = collection === 'analytics';
  tx(() => {
    for (const raw of upsert) {
      if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string' || raw.id.length > 80) throw new HttpError(400, 'Invalid item.');
      const prevRow = get.get(workspaceId, collection, raw.id);
      const prev = prevRow ? JSON.parse(prevRow.data) : null;
      let item = { ...raw };
      delete item.comments;
      if (role === 'Contributor') {
        if (prev) {
          if (!isOwnerOrAssignee(prev, user)) throw new HttpError(403, 'Contributors can update only ideas they created or that are assigned to them.');
          // Contributors cannot reassign work.
          item.assigneeId = prev.assigneeId; item.assignee = prev.assignee;
        } else { item.status = 'Ideas'; item.assigneeId = ''; item.assignee = ''; }
      }
      if (item.assigneeId) {
        if (!members.has(item.assigneeId)) throw new HttpError(400, 'Assignee must be a member of this workspace.');
        item.assignee = members.get(item.assigneeId);
      } else { item.assigneeId = ''; item.assignee = ''; }
      if (collection === 'ideas' && item.status && !STAGES.includes(item.status)) throw new HttpError(400, 'Unknown board stage.');
      if (prev) { item.createdBy = prev.createdBy; item.createdByName = prev.createdByName; } else { item.createdBy = user.id; item.createdByName = user.name; }
      item.updatedAt = now(); item.updatedBy = user.id;
      validateCollectionItem(collection, item);
      if (JSON.stringify(item).length > 200000) throw new HttpError(413, 'Item too large.');
      put.run(workspaceId, collection, item.id, JSON.stringify(item), prev ? 0 : seqRow.get(workspaceId).s);
      if (prev) {
        if (prev.status !== item.status && item.status) log(workspaceId, user, item.status === 'Approved' ? `approved ${titleOf(item)}` : `moved ${titleOf(item)} to ${item.status}`);
        else if (prev.assigneeId !== item.assigneeId && item.assigneeId) log(workspaceId, user, `assigned ${titleOf(item)} to ${item.assignee}`);
        else if (!quiet && JSON.stringify({ ...prev, updatedAt: 0, updatedBy: 0 }) !== JSON.stringify({ ...item, updatedAt: 0, updatedBy: 0 })) log(workspaceId, user, `updated ${KIND_LABEL[collection]} ${titleOf(item)}`);
      } else {
        created++;
        if (!quiet && collection !== 'imports') log(workspaceId, user, `created a new ${KIND_LABEL[collection]} ${titleOf(item)}`);
        if (item.assigneeId && !quiet) log(workspaceId, user, `assigned ${titleOf(item)} to ${item.assignee}`);
      }
    }
    for (const id of remove) {
      const row = get.get(workspaceId, collection, String(id));
      if (!row) continue;
      const prev = JSON.parse(row.data);
      if (role === 'Contributor') throw new HttpError(403, 'Contributors cannot delete content.');
      db.prepare('DELETE FROM items WHERE workspace_id=? AND collection=? AND id=?').run(workspaceId, collection, String(id));
      if (collection === 'ideas' || collection === 'reminders' || collection === 'goals') db.prepare('DELETE FROM comments WHERE workspace_id=? AND target_kind=? AND target_id=?').run(workspaceId, collection, String(id));
      if (!quiet) log(workspaceId, user, `deleted ${KIND_LABEL[collection]} ${titleOf(prev)}`);
    }
    if (collection === 'analytics' && created) log(workspaceId, user, `imported ${created} analytics record${created === 1 ? '' : 's'}`);
  });
}

// ---------- HTTP ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
const STATIC = new Set(['index.html', 'app.js', 'styles.css']);
function send(res, status, body, headers = {}) {
  const payload = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers });
  res.end(payload);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > 20e6) { reject(new HttpError(413, 'Request too large.')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch { reject(new HttpError(400, 'Invalid JSON.')); } });
    req.on('error', reject);
  });
}

async function api(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean).slice(1); // after "api"
  const method = req.method;
  if (method !== 'GET') {
    // CSRF defense in depth on top of SameSite=Strict cookies.
    const origin = req.headers.origin;
    if (origin && new URL(origin).host !== req.headers.host) throw new HttpError(403, 'Cross-origin request blocked.');
    if (!/^application\/json/.test(req.headers['content-type'] || '') && method !== 'DELETE') throw new HttpError(415, 'JSON required.');
  }
  const body = method === 'GET' || method === 'DELETE' ? {} : await readBody(req);

  if (parts[0] === 'login' && method === 'POST') {
    if (!authConfigured && !db.prepare('SELECT 1 FROM users LIMIT 1').get()) throw new HttpError(503, 'Authentication service is not configured.');
    const username = cleanUsername(body.username);
    throttle('login:' + req.socket.remoteAddress + ':' + username);
    const user = db.prepare('SELECT * FROM users WHERE username=? COLLATE NOCASE').get(username);
    if (!user || user.account_status === 'Suspended' || !verifyPassword(String(body.password || ''), user)) throw new HttpError(401, 'Invalid username or password.');
    if (!workspacesFor(user.id).length) throw new HttpError(403, 'You do not have permission to access this workspace.');
    db.prepare('UPDATE users SET last_login=? WHERE id=?').run(now(), user.id);
    createSession(res, user.id);
    return send(res, 200, { user: publicUser({ ...user, passwordRequiresChange: !!user.password_requires_change }), workspaces: workspacesFor(user.id) });
  }

  const user = sessionUser(req);
  if (!user) throw new HttpError(401, 'Please sign in.');
  if (parts[0] === 'change-password' && method === 'POST') {
    throttle('password-change:' + user.id + ':' + req.socket.remoteAddress);
    const password = String(body.newPassword || '');
    if (!validPassword(password)) throw new HttpError(400, 'New password must be at least 8 characters.');
    if (password !== String(body.confirmPassword || '')) throw new HttpError(400, 'New passwords do not match.');
    const current = db.prepare('SELECT * FROM users WHERE id=?').get(user.id);
    if (!user.passwordRequiresChange && (!body.currentPassword || !verifyPassword(String(body.currentPassword), current))) throw new HttpError(401, 'Current password is incorrect.');
    const { salt, hash } = hashPassword(password);
    db.prepare("UPDATE users SET pw_salt=?,pw_hash=?,password_requires_change=0,account_status='Active' WHERE id=?").run(salt, hash, user.id);
    return send(res, 200, { ok: true });
  }
  if (parts[0] === 'logout' && method === 'POST') {
    db.prepare('DELETE FROM sessions WHERE token_hash=?').run(user.tokenHash);
    return send(res, 200, { ok: true }, { 'Set-Cookie': 'hom_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' });
  }
  if (parts[0] === 'me' && method === 'GET') return send(res, 200, { user: publicUser(user), workspaces: workspacesFor(user.id) });

  if (parts[0] !== 'w' || !parts[1]) throw new HttpError(404, 'Not found.');
  const wid = parts[1];
  const role = requireMember(user, wid); // all workspace access is gated here
  const sub = parts[2];

  if (!sub && method === 'GET') return send(res, 200, fullState(wid, user, role));
  if (!sub && method === 'PATCH') {
    if (role !== 'Admin') throw new HttpError(403, 'Only admins can manage workspace settings.');
    const name = cleanText(body.name, 80);
    if (!name) throw new HttpError(400, 'Workspace name is required.');
    db.prepare('UPDATE workspaces SET name=? WHERE id=?').run(name, wid);
    log(wid, user, `renamed the workspace to “${name}”`);
    return send(res, 200, { ok: true });
  }
  if (sub === 'items' && method === 'POST') {
    applyItemOps(wid, user, role, parts[3], body.upsert || [], body.remove || []);
    return send(res, 200, { ok: true });
  }
  if (sub === 'kv' && method === 'PUT') {
    const key = parts[3];
    if (!KV_KEYS.includes(key)) throw new HttpError(400, 'Unknown setting.');
    if (key === 'settings' && role !== 'Admin') throw new HttpError(403, 'Only admins can manage workspace settings.');
    db.prepare('INSERT INTO kv(workspace_id,key,data) VALUES(?,?,?) ON CONFLICT(workspace_id,key) DO UPDATE SET data=excluded.data').run(wid, key, JSON.stringify(body.value ?? null));
    return send(res, 200, { ok: true });
  }
  if (sub === 'comments' && method === 'POST') {
    const kind = body.targetKind, text = cleanText(body.text, 2000);
    if (!COMMENT_TARGETS.includes(kind)) throw new HttpError(400, 'Unknown comment target.');
    if (!text) throw new HttpError(400, 'Comment cannot be empty.');
    const target = db.prepare('SELECT data FROM items WHERE workspace_id=? AND collection=? AND id=?').get(wid, kind, String(body.targetId));
    if (!target) throw new HttpError(404, 'Item not found.');
    let parentId = null;
    if (body.parentId) {
      const p = db.prepare('SELECT id,parent_id FROM comments WHERE workspace_id=? AND id=? AND target_kind=? AND target_id=?').get(wid, String(body.parentId), kind, String(body.targetId));
      if (!p) throw new HttpError(404, 'Comment to reply to was not found.');
      parentId = p.parent_id || p.id; // one level of replies
    }
    const id = uid();
    db.prepare('INSERT INTO comments(id,workspace_id,target_kind,target_id,parent_id,user_id,user_name,body,created_at) VALUES(?,?,?,?,?,?,?,?,?)').run(id, wid, kind, String(body.targetId), parentId, user.id, user.name, text, now());
    log(wid, user, `${parentId ? 'replied to a comment on' : 'commented on'} ${titleOf(JSON.parse(target.data))}`);
    return send(res, 201, { id });
  }
  if (sub === 'comments' && method === 'DELETE') {
    const c = db.prepare('SELECT user_id FROM comments WHERE workspace_id=? AND id=?').get(wid, parts[3] || '');
    if (!c) throw new HttpError(404, 'Comment not found.');
    if (c.user_id !== user.id && role !== 'Admin') throw new HttpError(403, 'You can delete only your own comments.');
    db.prepare('DELETE FROM comments WHERE workspace_id=? AND (id=? OR parent_id=?)').run(wid, parts[3], parts[3]);
    return send(res, 200, { ok: true });
  }

  // ----- admin-only team management -----
  if (sub === 'members') {
    if (role !== 'Admin') throw new HttpError(403, 'Only admins can manage the team.');
  }
  if (sub === 'members' && parts.length === 3 && method === 'POST') {
    const firstName = cleanText(body.firstName, 60), lastName = cleanText(body.lastName, 60);
    const username = String(body.username || '').trim(), password = String(body.temporaryPassword || '');
    if (!firstName || !lastName) throw new HttpError(400, 'Please enter a first and last name.');
    if (!validUsername(username)) throw new HttpError(400, 'Username must be 3–30 characters and use only letters, numbers, _ or -.');
    if (!validPassword(password)) throw new HttpError(400, 'Temporary password must be at least 8 characters.');
    if (!ROLES.includes(body.role)) throw new HttpError(400, 'Please select a role.');
    if (db.prepare('SELECT 1 FROM users WHERE username=? COLLATE NOCASE').get(username)) throw new HttpError(409, 'That username is already in use. Please choose another username.');
    const member = { id: uid(), username, firstName, lastName, name: `${firstName} ${lastName}` };
    const { salt, hash } = hashPassword(password), created = now();
    tx(() => {
      db.prepare("INSERT INTO users(id,username,first_name,last_name,name,pw_salt,pw_hash,password_requires_change,account_status,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)")
        .run(member.id, username, firstName, lastName, member.name, salt, hash, 1, 'Pending Password Setup', created);
      db.prepare('INSERT INTO memberships(workspace_id,user_id,role,created_at) VALUES(?,?,?,?)').run(wid, member.id, body.role, created);
      log(wid, user, `created an account for ${member.name} as ${body.role}`);
    });
    return send(res, 201, { member: { ...member, role: body.role, status: 'Pending Password Setup' } });
  }
  if (sub === 'members' && parts[4] === 'reset-password' && method === 'POST') {
    throttle('password-reset:' + user.id + ':' + req.socket.remoteAddress);
    const target = db.prepare('SELECT u.id,u.name,u.account_status FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.workspace_id=? AND u.id=?').get(wid, parts[3] || '');
    if (!target) throw new HttpError(404, 'Member not found.');
    const password = String(body.temporaryPassword || '');
    if (!validPassword(password)) throw new HttpError(400, 'Temporary password must be at least 8 characters.');
    const { salt, hash } = hashPassword(password);
    tx(() => {
      db.prepare("UPDATE users SET pw_salt=?,pw_hash=?,password_requires_change=1,account_status=CASE WHEN account_status='Suspended' THEN 'Suspended' ELSE 'Pending Password Setup' END WHERE id=?").run(salt, hash, target.id);
      db.prepare('DELETE FROM sessions WHERE user_id=?').run(target.id);
      log(wid, user, `reset the password for ${target.name}`);
    });
    return send(res, 200, { ok: true });
  }
  if (sub === 'members' && parts[4] === 'profile' && method === 'PATCH') {
    const target = db.prepare('SELECT u.id,u.name FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.workspace_id=? AND u.id=?').get(wid, parts[3] || '');
    if (!target) throw new HttpError(404, 'Member not found.');
    const firstName = cleanText(body.firstName, 60), lastName = cleanText(body.lastName, 60);
    if (!firstName || !lastName) throw new HttpError(400, 'Please enter a first and last name.');
    db.prepare('UPDATE users SET first_name=?,last_name=?,name=? WHERE id=?').run(firstName, lastName, `${firstName} ${lastName}`, target.id);
    log(wid, user, `updated the account name for ${target.name}`);
    return send(res, 200, { ok: true });
  }
  if (sub === 'members' && parts[4] === 'status' && method === 'PATCH') {
    const target = db.prepare('SELECT u.id,m.role,u.name,u.password_requires_change passwordRequiresChange,u.account_status accountStatus FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.workspace_id=? AND u.id=?').get(wid, parts[3] || '');
    if (!target) throw new HttpError(404, 'Member not found.');
    if (!['Active', 'Suspended'].includes(body.status)) throw new HttpError(400, 'Unknown account status.');
    if (body.status === 'Suspended' && target.accountStatus !== 'Suspended' && target.role === 'Admin' && adminCount(wid) <= 1) throw new HttpError(409, 'A workspace needs at least one active admin.');
    const status = body.status === 'Suspended' ? 'Suspended' : target.passwordRequiresChange ? 'Pending Password Setup' : 'Active';
    db.prepare('UPDATE users SET account_status=? WHERE id=?').run(status, target.id);
    if (status === 'Suspended') db.prepare('DELETE FROM sessions WHERE user_id=?').run(target.id);
    log(wid, user, `${body.status === 'Suspended' ? 'suspended' : 'reactivated'} ${target.name}'s account`);
    return send(res, 200, { ok: true });
  }
  if (sub === 'members' && parts.length === 4 && method === 'PATCH') {
    const target = db.prepare('SELECT m.role,u.name FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.workspace_id=? AND m.user_id=?').get(wid, parts[3] || '');
    if (!target) throw new HttpError(404, 'Member not found.');
    if (!ROLES.includes(body.role)) throw new HttpError(400, 'Unknown role.');
    if (target.role === 'Admin' && body.role !== 'Admin' && adminCount(wid) <= 1) throw new HttpError(409, 'A workspace needs at least one active admin.');
    db.prepare('UPDATE memberships SET role=? WHERE workspace_id=? AND user_id=?').run(body.role, wid, parts[3]);
    log(wid, user, `changed ${target.name}’s role to ${body.role}`);
    return send(res, 200, { ok: true });
  }
  if (sub === 'members' && parts.length === 4 && method === 'DELETE') {
    const target = db.prepare('SELECT m.role,u.name FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.workspace_id=? AND m.user_id=?').get(wid, parts[3] || '');
    if (!target) throw new HttpError(404, 'Member not found.');
    if (target.role === 'Admin' && adminCount(wid) <= 1) throw new HttpError(409, 'A workspace needs at least one active admin.');
    tx(() => {
      db.prepare('DELETE FROM memberships WHERE workspace_id=? AND user_id=?').run(wid, parts[3]);
      // unassign work from the removed member
      for (const c of COLLECTIONS) {
        for (const r of db.prepare('SELECT id,data FROM items WHERE workspace_id=? AND collection=?').all(wid, c)) {
          const it = JSON.parse(r.data);
          if (it.assigneeId === parts[3]) { it.assigneeId = ''; it.assignee = ''; db.prepare('UPDATE items SET data=? WHERE workspace_id=? AND collection=? AND id=?').run(JSON.stringify(it), wid, c, r.id); }
        }
      }
      log(wid, user, `removed ${target.name} from the workspace`);
    });
    return send(res, 200, { ok: true });
  }
  throw new HttpError(404, 'Not found.');
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    const name = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    if (!STATIC.has(name)) return send(res, 404, 'Not found', { 'Content-Type': 'text/plain' });
    send(res, 200, fs.readFileSync(path.join(ROOT, name)), { 'Content-Type': MIME[path.extname(name)], 'Cache-Control': 'no-cache' });
  } catch (e) {
    if (e instanceof HttpError) return send(res, e.status, { error: e.message });
    console.error(e);
    if (/database|SQLITE|sqlite/i.test(String(e && (e.code || e.message)))) return send(res, 503, { error: 'The House of Mercy authentication service is temporarily unavailable.' });
    send(res, 500, { error: 'Something went wrong while signing you in. Please try again.' });
  }
});
if (require.main === module) server.listen(PORT, () => console.log(`House of Mercy Content Hub running at http://localhost:${PORT}`));
module.exports = server;
