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
const COLLECTIONS = ['ideas', 'reminders', 'goals', 'analytics', 'hashtagSets', 'imports'];
const KV_KEYS = ['settings', 'lastGeneration'];
const STAGES = ['Ideas', 'Developing', 'Review', 'Approved', 'Planned'];
const COMMENT_TARGETS = ['ideas', 'reminders', 'goals'];
const INVITE_DAYS = 7;
const SESSION_DAYS = 30;
const DEFAULT_WORKSPACE = 'house-of-mercy';

fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
const db = new DatabaseSync(DB_FILE);
db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT NOT NULL, pw_salt TEXT NOT NULL, pw_hash TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS workspaces(id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS memberships(workspace_id TEXT NOT NULL REFERENCES workspaces(id), user_id TEXT NOT NULL REFERENCES users(id), role TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(workspace_id, user_id));
CREATE TABLE IF NOT EXISTS invitations(id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id), email TEXT NOT NULL, role TEXT NOT NULL, token_hash TEXT UNIQUE NOT NULL, invited_by TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL, accepted_at TEXT, accepted_by TEXT);
CREATE TABLE IF NOT EXISTS sessions(token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), expires_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS items(workspace_id TEXT NOT NULL REFERENCES workspaces(id), collection TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, seq INTEGER NOT NULL, PRIMARY KEY(workspace_id, collection, id));
CREATE TABLE IF NOT EXISTS kv(workspace_id TEXT NOT NULL REFERENCES workspaces(id), key TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(workspace_id, key));
CREATE TABLE IF NOT EXISTS comments(id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id), target_kind TEXT NOT NULL, target_id TEXT NOT NULL, parent_id TEXT, user_id TEXT NOT NULL, user_name TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS activity(id INTEGER PRIMARY KEY AUTOINCREMENT, workspace_id TEXT NOT NULL REFERENCES workspaces(id), user_id TEXT, user_name TEXT NOT NULL, text TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_items_ws ON items(workspace_id, collection);
CREATE INDEX IF NOT EXISTS idx_comments_ws ON comments(workspace_id, target_kind, target_id);
CREATE INDEX IF NOT EXISTS idx_activity_ws ON activity(workspace_id, id);
`);
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
const cleanEmail = e => String(e || '').trim().toLowerCase();
const validEmail = e => e.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
const cleanText = (s, max) => String(s || '').trim().slice(0, max);

function createSession(res, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const exp = new Date(Date.now() + SESSION_DAYS * 864e5).toISOString();
  db.prepare('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)').run(sha(token), userId, exp);
  res.setHeader('Set-Cookie', `hom_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_DAYS * 86400}${process.env.HOM_SECURE_COOKIE ? '; Secure' : ''}`);
}
function sessionUser(req) {
  const m = /(?:^|;\s*)hom_session=([a-f0-9]{64})/.exec(req.headers.cookie || '');
  if (!m) return null;
  const row = db.prepare('SELECT u.id,u.email,u.name,s.expires_at FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=?').get(sha(m[1]));
  if (!row) return null;
  if (row.expires_at < now()) { db.prepare('DELETE FROM sessions WHERE token_hash=?').run(sha(m[1])); return null; }
  return { id: row.id, email: row.email, name: row.name, tokenHash: sha(m[1]) };
}
const attempts = new Map();
function throttle(key) {
  const t = Date.now(), list = (attempts.get(key) || []).filter(x => t - x < 15 * 60e3);
  if (list.length >= 10) throw new HttpError(429, 'Too many attempts. Please try again in a few minutes.');
  list.push(t); attempts.set(key, list);
  if (attempts.size > 5000) for (const [k, l] of attempts) if (t - l[l.length - 1] > 15 * 60e3) attempts.delete(k);
}

// ---------- workspaces / invitations ----------
function membership(workspaceId, userId) {
  return db.prepare('SELECT role FROM memberships WHERE workspace_id=? AND user_id=?').get(workspaceId, userId) || null;
}
function requireMember(user, workspaceId) {
  const m = membership(workspaceId, user.id);
  if (!m) throw new HttpError(404, 'Workspace not found.'); // do not reveal other workspaces exist
  return m.role;
}
const inviteStatus = i => i.accepted_at ? 'Accepted' : i.expires_at < now() ? 'Expired' : 'Pending';
function findInvite(token) {
  return db.prepare('SELECT * FROM invitations WHERE token_hash=?').get(sha(String(token || '')));
}
function acceptInvite(user, token) {
  const inv = findInvite(token);
  if (!inv) throw new HttpError(404, 'This invitation was not found.');
  if (inv.accepted_at) throw new HttpError(409, 'This invitation has already been used.');
  if (inv.expires_at < now()) throw new HttpError(410, 'This invitation has expired. Ask an admin to send a new one.');
  if (inv.email !== user.email) throw new HttpError(403, `This invitation was sent to a different email address (${inv.email}).`);
  tx(() => {
    if (!membership(inv.workspace_id, user.id)) db.prepare('INSERT INTO memberships(workspace_id,user_id,role,created_at) VALUES(?,?,?,?)').run(inv.workspace_id, user.id, inv.role, now());
    db.prepare('UPDATE invitations SET accepted_at=?,accepted_by=? WHERE id=?').run(now(), user.id, inv.id);
    log(inv.workspace_id, user, `joined the workspace as ${inv.role}`);
  });
  return inv.workspace_id;
}
function log(workspaceId, user, text) {
  db.prepare('INSERT INTO activity(workspace_id,user_id,user_name,text,created_at) VALUES(?,?,?,?,?)').run(workspaceId, user ? user.id : null, user ? user.name : 'Someone', text, now());
}
function workspacesFor(userId) {
  return db.prepare('SELECT w.id,w.name,m.role FROM memberships m JOIN workspaces w ON w.id=m.workspace_id WHERE m.user_id=? ORDER BY w.created_at').all(userId);
}
function adminCount(workspaceId) {
  return db.prepare("SELECT COUNT(*) c FROM memberships WHERE workspace_id=? AND role='Admin'").get(workspaceId).c;
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
  const members = db.prepare('SELECT u.id,u.name,u.email,m.role FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.workspace_id=? ORDER BY m.created_at').all(workspaceId);
  const out = {
    workspace: ws, me: { id: user.id, name: user.name, email: user.email, role },
    workspaces: workspacesFor(user.id), data: loadData(workspaceId), members,
    comments: db.prepare('SELECT id,target_kind targetKind,target_id targetId,parent_id parentId,user_id userId,user_name author,body text,created_at at FROM comments WHERE workspace_id=? ORDER BY created_at').all(workspaceId),
    activity: db.prepare('SELECT id,user_id userId,user_name userName,text,created_at at FROM activity WHERE workspace_id=? ORDER BY id DESC LIMIT 100').all(workspaceId),
    invitations: [],
  };
  if (role === 'Admin') {
    out.invitations = db.prepare('SELECT id,email,role,created_at createdAt,expires_at expiresAt,accepted_at acceptedAt FROM invitations WHERE workspace_id=? ORDER BY created_at DESC LIMIT 100').all(workspaceId)
      .map(i => ({ id: i.id, email: i.email, role: i.role, createdAt: i.createdAt, expiresAt: i.expiresAt, status: inviteStatus({ accepted_at: i.acceptedAt, expires_at: i.expiresAt }) }));
  }
  return out;
}

const KIND_LABEL = { ideas: 'content idea', reminders: 'reminder', goals: 'goal', hashtagSets: 'hashtag set', analytics: 'analytics record', imports: 'import' };
const titleOf = it => `“${cleanText(it.title || it.name || 'Untitled', 80)}”`;
const isOwnerOrAssignee = (it, user) => it && (it.createdBy === user.id || it.assigneeId === user.id);

// Role rules for writing workspace data.
function canWriteCollection(role, collection) {
  if (role === 'Admin' || role === 'Editor') return true;
  return collection === 'ideas'; // Contributors work only with ideas
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

  if (parts[0] === 'invitations' && parts[1] === 'lookup' && method === 'GET') {
    const inv = findInvite(url.searchParams.get('token'));
    if (!inv) throw new HttpError(404, 'This invitation was not found.');
    const ws = db.prepare('SELECT name FROM workspaces WHERE id=?').get(inv.workspace_id);
    return send(res, 200, { email: inv.email, role: inv.role, workspace: ws.name, status: inviteStatus(inv), hasAccount: !!db.prepare('SELECT 1 FROM users WHERE email=?').get(inv.email) });
  }
  if (parts[0] === 'register' && method === 'POST') {
    throttle('reg:' + req.socket.remoteAddress);
    const email = cleanEmail(body.email), name = cleanText(body.name, 80), pw = String(body.password || '');
    if (!name) throw new HttpError(400, 'Please enter your name.');
    if (!validEmail(email)) throw new HttpError(400, 'Please enter a valid email address.');
    if (pw.length < 8 || pw.length > 200) throw new HttpError(400, 'Password must be at least 8 characters.');
    if (db.prepare('SELECT 1 FROM users WHERE email=?').get(email)) throw new HttpError(409, 'An account with this email already exists. Please sign in.');
    const inv = body.inviteToken ? findInvite(body.inviteToken) : null;
    if (body.inviteToken && !inv) throw new HttpError(404, 'This invitation was not found.');
    const firstUser = db.prepare('SELECT COUNT(*) c FROM memberships WHERE workspace_id=?').get(DEFAULT_WORKSPACE).c === 0;
    if (inv) {
      if (inv.accepted_at) throw new HttpError(409, 'This invitation has already been used.');
      if (inv.expires_at < now()) throw new HttpError(410, 'This invitation has expired. Ask an admin to send a new one.');
      if (inv.email !== email) throw new HttpError(403, `This invitation was sent to ${inv.email}. Please use that email address.`);
    }
    if (!inv && !firstUser) throw new HttpError(403, 'House of Mercy is invitation-only. Ask a workspace admin to invite you.');
    const user = { id: uid(), email, name };
    const { salt, hash } = hashPassword(pw);
    tx(() => {
      db.prepare('INSERT INTO users(id,email,name,pw_salt,pw_hash,created_at) VALUES(?,?,?,?,?,?)').run(user.id, email, name, salt, hash, now());
      if (!inv) { // very first account bootstraps the workspace as its Admin
        db.prepare('INSERT INTO memberships(workspace_id,user_id,role,created_at) VALUES(?,?,?,?)').run(DEFAULT_WORKSPACE, user.id, 'Admin', now());
        log(DEFAULT_WORKSPACE, user, 'created the House of Mercy workspace');
      }
    });
    if (inv) acceptInvite(user, body.inviteToken);
    createSession(res, user.id);
    return send(res, 201, { user: { id: user.id, name, email }, workspaces: workspacesFor(user.id) });
  }
  if (parts[0] === 'login' && method === 'POST') {
    const email = cleanEmail(body.email);
    throttle('login:' + req.socket.remoteAddress + ':' + email);
    const user = db.prepare('SELECT * FROM users WHERE email=?').get(email);
    if (!user || !verifyPassword(String(body.password || ''), user)) throw new HttpError(401, 'Incorrect email or password.');
    if (body.inviteToken) acceptInvite(user, body.inviteToken);
    createSession(res, user.id);
    return send(res, 200, { user: { id: user.id, name: user.name, email: user.email }, workspaces: workspacesFor(user.id) });
  }

  const user = sessionUser(req);
  if (!user) throw new HttpError(401, 'Please sign in.');
  if (parts[0] === 'logout' && method === 'POST') {
    db.prepare('DELETE FROM sessions WHERE token_hash=?').run(user.tokenHash);
    return send(res, 200, { ok: true }, { 'Set-Cookie': 'hom_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' });
  }
  if (parts[0] === 'me' && method === 'GET') return send(res, 200, { user: { id: user.id, name: user.name, email: user.email }, workspaces: workspacesFor(user.id) });
  if (parts[0] === 'invitations' && parts[1] === 'accept' && method === 'POST') {
    const wid = acceptInvite(user, body.token);
    return send(res, 200, { workspaceId: wid, workspaces: workspacesFor(user.id) });
  }

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
  if (sub === 'invitations' || sub === 'members') {
    if (role !== 'Admin') throw new HttpError(403, 'Only admins can manage the team.');
  }
  if (sub === 'invitations' && method === 'POST') {
    const email = cleanEmail(body.email);
    if (!validEmail(email)) throw new HttpError(400, 'Please enter a valid email address.');
    if (!ROLES.includes(body.role)) throw new HttpError(400, 'Please select a role.');
    if (db.prepare('SELECT 1 FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.workspace_id=? AND u.email=?').get(wid, email)) throw new HttpError(409, 'That person is already a member.');
    const token = crypto.randomBytes(24).toString('hex');
    tx(() => {
      // a new invite replaces any older pending one for the same address
      db.prepare('DELETE FROM invitations WHERE workspace_id=? AND email=? AND accepted_at IS NULL').run(wid, email);
      db.prepare('INSERT INTO invitations(id,workspace_id,email,role,token_hash,invited_by,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?)').run(uid(), wid, email, body.role, sha(token), user.id, now(), new Date(Date.now() + INVITE_DAYS * 864e5).toISOString());
      log(wid, user, `invited ${email} as ${body.role}`);
    });
    return send(res, 201, { token, expiresInDays: INVITE_DAYS });
  }
  if (sub === 'invitations' && method === 'DELETE') {
    const r = db.prepare('DELETE FROM invitations WHERE workspace_id=? AND id=? AND accepted_at IS NULL').run(wid, parts[3] || '');
    if (!r.changes) throw new HttpError(404, 'Invitation not found.');
    return send(res, 200, { ok: true });
  }
  if (sub === 'members' && method === 'PATCH') {
    const target = db.prepare('SELECT m.role,u.name FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.workspace_id=? AND m.user_id=?').get(wid, parts[3] || '');
    if (!target) throw new HttpError(404, 'Member not found.');
    if (!ROLES.includes(body.role)) throw new HttpError(400, 'Unknown role.');
    if (target.role === 'Admin' && body.role !== 'Admin' && adminCount(wid) <= 1) throw new HttpError(409, 'A workspace needs at least one admin.');
    db.prepare('UPDATE memberships SET role=? WHERE workspace_id=? AND user_id=?').run(body.role, wid, parts[3]);
    log(wid, user, `changed ${target.name}’s role to ${body.role}`);
    return send(res, 200, { ok: true });
  }
  if (sub === 'members' && method === 'DELETE') {
    const target = db.prepare('SELECT m.role,u.name FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.workspace_id=? AND m.user_id=?').get(wid, parts[3] || '');
    if (!target) throw new HttpError(404, 'Member not found.');
    if (target.role === 'Admin' && adminCount(wid) <= 1) throw new HttpError(409, 'A workspace needs at least one admin.');
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
    send(res, 500, { error: 'Something went wrong.' });
  }
});
if (require.main === module) server.listen(PORT, () => console.log(`House of Mercy Content Hub running at http://localhost:${PORT}`));
module.exports = server;
