// House of Mercy API as a Supabase Edge Function (port of the former Node/SQLite server.js).
// Username + password (scrypt) auth, opaque server-side sessions, workspace + role checks.
// The service-role key lives only in the function environment; the browser never receives it.
import { createClient } from "npm:@supabase/supabase-js@2";
import crypto from "node:crypto";

const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? Deno.env.get("SUPABASE_SECRET_KEY") ?? "";
const db = createClient(Deno.env.get("SUPABASE_URL")!, SERVICE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });

const ROLES = ["Admin", "Editor", "Contributor"];
const COLLECTIONS = ["ideas", "reminders", "goals", "analytics", "hashtagSets", "imports"];
const KV_KEYS = ["settings", "lastGeneration"];
const STAGES = ["Ideas", "Developing", "Review", "Approved", "Planned"];
const COMMENT_TARGETS = ["ideas", "reminders", "goals"];
const SESSION_HOURS = 12;
const DEFAULT_WORKSPACE = "house-of-mercy";
const ALLOWED = (Deno.env.get("HOM_ALLOWED_ORIGINS") ?? "*").split(",").map((s) => s.trim()).filter(Boolean);

class HttpError extends Error { constructor(public status: number, message: string) { super(message); } }
// deno-lint-ignore no-explicit-any
type Any = any;
const now = () => new Date().toISOString();
const sha = (s: string) => crypto.createHash("sha256").update(s).digest("hex");
const cleanText = (s: unknown, max: number) => String(s ?? "").trim().slice(0, max);
const validUsername = (u: unknown) => /^[A-Za-z0-9_-]{3,30}$/.test(String(u ?? ""));
const validPassword = (p: unknown) => typeof p === "string" && p.length >= 8 && p.length <= 200;
const hashPassword = (pw: string, salt = crypto.randomBytes(16).toString("hex")) => ({ salt, hash: crypto.scryptSync(pw, salt, 64).toString("hex") });
function verifyPassword(pw: string, salt: string, hash: string) {
  const a = Buffer.from(hashPassword(pw, salt).hash, "hex"), b = Buffer.from(hash, "hex");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
const escLike = (s: string) => s.replace(/[%_\\]/g, "\\$&");
const must = <T>(r: { data: T; error: Any }): T => { if (r.error) throw r.error; return r.data; };

function corsHeaders(req: Request) {
  const origin = req.headers.get("origin") ?? "";
  const allow = ALLOWED.includes("*") ? "*" : ALLOWED.includes(origin) ? origin : ALLOWED[0];
  return {
    "Access-Control-Allow-Origin": allow, "Vary": "Origin",
    "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-hom-session",
    "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
  };
}
const send = (req: Request, status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders(req), "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });

async function throttle(key: string) {
  const since = new Date(Date.now() - 15 * 60e3).toISOString();
  const { count } = await db.from("login_attempts").select("id", { count: "exact", head: true }).eq("key", key).gte("at", since);
  if ((count ?? 0) >= 10) throw new HttpError(429, "Too many attempts. Please try again in a few minutes.");
  must(await db.from("login_attempts").insert({ key }));
  if (Math.random() < 0.05) await db.from("login_attempts").delete().lt("at", since);
}

// ---------- accounts ----------
const publicUser = (u: Any) => ({
  id: u.id, username: u.username, firstName: u.first_name, lastName: u.last_name, name: u.name,
  passwordRequiresChange: !!u.password_requires_change, accountStatus: u.account_status ?? "Active",
});

async function bootstrapAdmin() {
  const { count } = await db.from("app_users").select("id", { count: "exact", head: true });
  if (count) return;
  const password = Deno.env.get("HOM_ADMIN_INITIAL_PASSWORD");
  if (!password || !validPassword(password)) throw new HttpError(503, "Authentication service is not configured.");
  const { salt, hash } = hashPassword(password);
  const id = crypto.randomUUID();
  must(await db.from("workspaces").upsert({ id: DEFAULT_WORKSPACE, name: "House of Mercy" }, { ignoreDuplicates: true }));
  must(await db.from("app_users").insert({ id, username: "HOMMediaAdmin", first_name: "House of Mercy", last_name: "Admin", name: "House of Mercy Admin", pw_salt: salt, pw_hash: hash, password_requires_change: true, account_status: "Pending Password Setup" }));
  must(await db.from("memberships").insert({ workspace_id: DEFAULT_WORKSPACE, user_id: id, role: "Admin" }));
}

async function workspacesFor(userId: string) {
  const rows = must(await db.from("memberships").select("role,workspaces(id,name,created_at)").eq("user_id", userId)) as Any[];
  return rows.sort((a, b) => a.workspaces.created_at.localeCompare(b.workspaces.created_at)).map((m) => ({ id: m.workspaces.id, name: m.workspaces.name, role: m.role }));
}

async function sessionUser(req: Request) {
  const token = req.headers.get("x-hom-session") ?? "";
  if (!/^[a-f0-9]{64}$/.test(token)) return null;
  const th = sha(token);
  const { data: s } = await db.from("sessions").select("expires_at,app_users(*)").eq("token_hash", th).maybeSingle();
  if (!s) return null;
  if (s.expires_at < now()) { await db.from("sessions").delete().eq("token_hash", th); return null; }
  const u = s.app_users as Any;
  if (!u || u.account_status === "Suspended") return null;
  return { ...publicUser(u), tokenHash: th };
}

async function requireMember(user: Any, ws: string) {
  if (user.passwordRequiresChange) throw new HttpError(403, "Change your temporary password before continuing.");
  const { data } = await db.from("memberships").select("role").eq("workspace_id", ws).eq("user_id", user.id).maybeSingle();
  if (!data) throw new HttpError(404, "Workspace not found.");
  return data.role as string;
}
async function log(ws: string, user: Any, text: string) {
  must(await db.from("activity").insert({ workspace_id: ws, user_id: user?.id ?? null, user_name: user?.name ?? "Someone", text }));
}

// ---------- workspace data ----------
async function fullState(ws: string, user: Any, role: string) {
  const data: Any = {};
  for (const c of COLLECTIONS) {
    data[c] = (must(await db.from("items").select("data").eq("workspace_id", ws).eq("collection", c).order("seq", { ascending: false })) as Any[]).map((r) => r.data);
  }
  data.settings = { notifications: true };
  for (const r of must(await db.from("kv").select("key,data").eq("workspace_id", ws)) as Any[]) if (KV_KEYS.includes(r.key)) data[r.key] = r.data;
  const workspace = must(await db.from("workspaces").select("id,name").eq("id", ws).single());
  const members = (must(await db.from("memberships").select("role,created_at,app_users(id,name,username,account_status,password_requires_change)").eq("workspace_id", ws).order("created_at")) as Any[]).map((m) => {
    const u = m.app_users;
    return { id: u.id, name: u.name, username: u.username, accountStatus: u.account_status, passwordRequiresChange: u.password_requires_change, role: m.role,
      status: u.account_status === "Suspended" ? "Suspended" : u.password_requires_change ? "Pending Password Setup" : "Active" };
  });
  const comments = (must(await db.from("comments").select("id,target_kind,target_id,parent_id,user_id,user_name,body,created_at").eq("workspace_id", ws).order("created_at")) as Any[])
    .map((c) => ({ id: c.id, targetKind: c.target_kind, targetId: c.target_id, parentId: c.parent_id, userId: c.user_id, author: c.user_name, text: c.body, at: c.created_at }));
  const activity = (must(await db.from("activity").select("id,user_id,user_name,text,created_at").eq("workspace_id", ws).order("id", { ascending: false }).limit(100)) as Any[])
    .map((a) => ({ id: a.id, userId: a.user_id, userName: a.user_name, text: a.text, at: a.created_at }));
  return { workspace, me: { ...publicUser(user), role }, workspaces: await workspacesFor(user.id), data, members, comments, activity, invitations: [] };
}

const KIND_LABEL: Record<string, string> = { ideas: "content idea", reminders: "reminder", goals: "goal", hashtagSets: "hashtag set", analytics: "analytics record", imports: "import" };
const titleOf = (it: Any) => `“${cleanText(it.title || it.name || "Untitled", 80)}”`;
const isOwnerOrAssignee = (it: Any, user: Any) => it && (it.createdBy === user.id || it.assigneeId === user.id);
const canWriteCollection = (role: string, c: string) => role === "Admin" || role === "Editor" || c === "ideas";

async function applyItemOps(ws: string, user: Any, role: string, collection: string, upsert: Any, remove: Any) {
  if (!COLLECTIONS.includes(collection)) throw new HttpError(400, "Unknown collection.");
  if (!canWriteCollection(role, collection)) throw new HttpError(403, "Your role cannot change this content.");
  if (!Array.isArray(upsert) || !Array.isArray(remove)) throw new HttpError(400, "Invalid request.");
  const members = new Map((must(await db.from("memberships").select("app_users(id,name)").eq("workspace_id", ws)) as Any[]).map((m) => [m.app_users.id, m.app_users.name]));
  const quiet = collection === "analytics";
  let created = 0;
  const prepared: { item: Any; prev: Any }[] = [];
  // Validate everything first so a bad item rejects the whole batch (the SQLite version used a transaction).
  for (const raw of upsert) {
    if (!raw || typeof raw !== "object" || typeof raw.id !== "string" || raw.id.length > 80) throw new HttpError(400, "Invalid item.");
    const { data: row } = await db.from("items").select("data").eq("workspace_id", ws).eq("collection", collection).eq("id", raw.id).maybeSingle();
    const prev = row?.data ?? null;
    const item = { ...raw }; delete item.comments;
    if (role === "Contributor") {
      if (prev) {
        if (!isOwnerOrAssignee(prev, user)) throw new HttpError(403, "Contributors can update only ideas they created or that are assigned to them.");
        item.assigneeId = prev.assigneeId; item.assignee = prev.assignee;
      } else { item.status = "Ideas"; item.assigneeId = ""; item.assignee = ""; }
    }
    if (item.assigneeId) {
      if (!members.has(item.assigneeId)) throw new HttpError(400, "Assignee must be a member of this workspace.");
      item.assignee = members.get(item.assigneeId);
    } else { item.assigneeId = ""; item.assignee = ""; }
    if (collection === "ideas" && item.status && !STAGES.includes(item.status)) throw new HttpError(400, "Unknown board stage.");
    if (prev) { item.createdBy = prev.createdBy; item.createdByName = prev.createdByName; } else { item.createdBy = user.id; item.createdByName = user.name; }
    item.updatedAt = now(); item.updatedBy = user.id;
    if (JSON.stringify(item).length > 200000) throw new HttpError(413, "Item too large.");
    prepared.push({ item, prev });
  }
  if (role === "Contributor" && remove.length) throw new HttpError(403, "Contributors cannot delete content.");
  for (const { item, prev } of prepared) {
    if (prev) must(await db.from("items").update({ data: item }).eq("workspace_id", ws).eq("collection", collection).eq("id", item.id));
    else must(await db.from("items").insert({ workspace_id: ws, collection, id: item.id, data: item }));
    if (prev) {
      const strip = (o: Any) => JSON.stringify({ ...o, updatedAt: 0, updatedBy: 0 });
      if (prev.status !== item.status && item.status) await log(ws, user, item.status === "Approved" ? `approved ${titleOf(item)}` : `moved ${titleOf(item)} to ${item.status}`);
      else if (prev.assigneeId !== item.assigneeId && item.assigneeId) await log(ws, user, `assigned ${titleOf(item)} to ${item.assignee}`);
      else if (!quiet && strip(prev) !== strip(item)) await log(ws, user, `updated ${KIND_LABEL[collection]} ${titleOf(item)}`);
    } else {
      created++;
      if (!quiet && collection !== "imports") await log(ws, user, `created a new ${KIND_LABEL[collection]} ${titleOf(item)}`);
      if (item.assigneeId && !quiet) await log(ws, user, `assigned ${titleOf(item)} to ${item.assignee}`);
    }
  }
  for (const rid of remove) {
    const { data: row } = await db.from("items").select("data").eq("workspace_id", ws).eq("collection", collection).eq("id", String(rid)).maybeSingle();
    if (!row) continue;
    must(await db.from("items").delete().eq("workspace_id", ws).eq("collection", collection).eq("id", String(rid)));
    if (COMMENT_TARGETS.includes(collection)) must(await db.from("comments").delete().eq("workspace_id", ws).eq("target_kind", collection).eq("target_id", String(rid)));
    if (!quiet) await log(ws, user, `deleted ${KIND_LABEL[collection]} ${titleOf(row.data)}`);
  }
  if (collection === "analytics" && created) await log(ws, user, `imported ${created} analytics record${created === 1 ? "" : "s"}`);
}

const rpcError = (e: Any) => {
  const m = String(e?.message ?? "");
  if (m.includes("LAST_ADMIN")) return new HttpError(409, "A workspace needs at least one active admin.");
  if (m.includes("NOT_FOUND")) return new HttpError(404, "Member not found.");
  return e;
};
async function targetMember(ws: string, id: string) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new HttpError(404, "Member not found.");
  const { data } = await db.from("memberships").select("role,app_users(id,name,account_status,password_requires_change)").eq("workspace_id", ws).eq("user_id", id).maybeSingle();
  if (!data) throw new HttpError(404, "Member not found.");
  return { role: data.role as string, ...(data.app_users as Any) };
}

// ---------- router ----------
async function route(req: Request, url: URL): Promise<Response> {
  const parts = url.pathname.split("/").filter(Boolean);
  const i = parts.indexOf("hom-api");
  const p = i >= 0 ? parts.slice(i + 1) : parts;
  const method = req.method;
  const ip = (req.headers.get("x-forwarded-for") ?? "unknown").split(",")[0].trim();
  let body: Any = {};
  if (method !== "GET" && method !== "DELETE") {
    try { const t = await req.text(); body = t ? JSON.parse(t) : {}; } catch { throw new HttpError(400, "Invalid JSON."); }
  }

  if (p[0] === "login" && method === "POST") {
    await bootstrapAdmin();
    const username = String(body.username ?? "").trim().toLowerCase();
    await throttle(`login:${ip}:${username}`);
    const { data: u } = await db.from("app_users").select("*").ilike("username", escLike(username)).maybeSingle();
    const ok = u ? verifyPassword(String(body.password ?? ""), u.pw_salt, u.pw_hash) : (hashPassword("x"), false);
    if (!u || !ok || u.account_status === "Suspended") throw new HttpError(401, "Invalid username or password.");
    const wss = await workspacesFor(u.id);
    if (!wss.length) throw new HttpError(403, "You do not have permission to access this workspace.");
    await db.from("app_users").update({ last_login: now() }).eq("id", u.id);
    const token = crypto.randomBytes(32).toString("hex");
    must(await db.from("sessions").insert({ token_hash: sha(token), user_id: u.id, expires_at: new Date(Date.now() + SESSION_HOURS * 36e5).toISOString() }));
    await db.from("sessions").delete().lt("expires_at", now());
    return send(req, 200, { user: publicUser(u), workspaces: wss, session: token });
  }

  const user = await sessionUser(req);
  if (!user) throw new HttpError(401, "Please sign in.");

  if (p[0] === "change-password" && method === "POST") {
    await throttle(`password-change:${user.id}:${ip}`);
    const password = String(body.newPassword ?? "");
    if (!validPassword(password)) throw new HttpError(400, "New password must be at least 8 characters.");
    if (password !== String(body.confirmPassword ?? "")) throw new HttpError(400, "New passwords do not match.");
    const cur = must(await db.from("app_users").select("pw_salt,pw_hash").eq("id", user.id).single());
    if (!user.passwordRequiresChange && (!body.currentPassword || !verifyPassword(String(body.currentPassword), cur.pw_salt, cur.pw_hash))) throw new HttpError(401, "Current password is incorrect.");
    const { salt, hash } = hashPassword(password);
    must(await db.from("app_users").update({ pw_salt: salt, pw_hash: hash, password_requires_change: false, account_status: "Active" }).eq("id", user.id));
    // Other sessions are invalidated on password change; the current one stays.
    must(await db.from("sessions").delete().eq("user_id", user.id).neq("token_hash", user.tokenHash));
    return send(req, 200, { ok: true });
  }
  if (p[0] === "logout" && method === "POST") {
    must(await db.from("sessions").delete().eq("token_hash", user.tokenHash));
    return send(req, 200, { ok: true });
  }
  if (p[0] === "me" && method === "GET") return send(req, 200, { user: publicUser(user), workspaces: await workspacesFor(user.id) });

  if (p[0] !== "w" || !p[1]) throw new HttpError(404, "Not found.");
  const ws = p[1];
  const role = await requireMember(user, ws); // all workspace access is gated here; ws is verified against membership
  const sub = p[2];

  if (!sub && method === "GET") return send(req, 200, await fullState(ws, user, role));
  if (!sub && method === "PATCH") {
    if (role !== "Admin") throw new HttpError(403, "Only admins can manage workspace settings.");
    const name = cleanText(body.name, 80);
    if (!name) throw new HttpError(400, "Workspace name is required.");
    must(await db.from("workspaces").update({ name }).eq("id", ws));
    await log(ws, user, `renamed the workspace to “${name}”`);
    return send(req, 200, { ok: true });
  }
  if (sub === "items" && method === "POST") {
    await applyItemOps(ws, user, role, p[3], body.upsert || [], body.remove || []);
    return send(req, 200, { ok: true });
  }
  if (sub === "kv" && method === "PUT") {
    const key = p[3];
    if (!KV_KEYS.includes(key)) throw new HttpError(400, "Unknown setting.");
    if (key === "settings" && role !== "Admin") throw new HttpError(403, "Only admins can manage workspace settings.");
    must(await db.from("kv").upsert({ workspace_id: ws, key, data: body.value ?? null }));
    return send(req, 200, { ok: true });
  }
  if (sub === "comments" && method === "POST") {
    const kind = body.targetKind, text = cleanText(body.text, 2000);
    if (!COMMENT_TARGETS.includes(kind)) throw new HttpError(400, "Unknown comment target.");
    if (!text) throw new HttpError(400, "Comment cannot be empty.");
    const { data: target } = await db.from("items").select("data").eq("workspace_id", ws).eq("collection", kind).eq("id", String(body.targetId)).maybeSingle();
    if (!target) throw new HttpError(404, "Item not found.");
    let parentId: string | null = null;
    if (body.parentId) {
      const { data: par } = await db.from("comments").select("id,parent_id").eq("workspace_id", ws).eq("id", String(body.parentId)).eq("target_kind", kind).eq("target_id", String(body.targetId)).maybeSingle();
      if (!par) throw new HttpError(404, "Comment to reply to was not found.");
      parentId = par.parent_id || par.id;
    }
    const id = crypto.randomUUID();
    must(await db.from("comments").insert({ id, workspace_id: ws, target_kind: kind, target_id: String(body.targetId), parent_id: parentId, user_id: user.id, user_name: user.name, body: text }));
    await log(ws, user, `${parentId ? "replied to a comment on" : "commented on"} ${titleOf(target.data)}`);
    return send(req, 201, { id });
  }
  if (sub === "comments" && method === "DELETE") {
    const { data: c } = await db.from("comments").select("user_id").eq("workspace_id", ws).eq("id", p[3] ?? "").maybeSingle();
    if (!c) throw new HttpError(404, "Comment not found.");
    if (c.user_id !== user.id && role !== "Admin") throw new HttpError(403, "You can delete only your own comments.");
    must(await db.from("comments").delete().eq("workspace_id", ws).eq("parent_id", p[3]));
    must(await db.from("comments").delete().eq("workspace_id", ws).eq("id", p[3]));
    return send(req, 200, { ok: true });
  }

  // ----- admin-only team management -----
  if (sub === "members") {
    if (role !== "Admin") throw new HttpError(403, "Only admins can manage the team.");
  }
  if (sub === "members" && p.length === 3 && method === "POST") {
    const firstName = cleanText(body.firstName, 60), lastName = cleanText(body.lastName, 60);
    const username = String(body.username ?? "").trim(), password = String(body.temporaryPassword ?? "");
    if (!firstName || !lastName) throw new HttpError(400, "Please enter a first and last name.");
    if (!validUsername(username)) throw new HttpError(400, "Username must be 3–30 characters and use only letters, numbers, _ or -.");
    if (!validPassword(password)) throw new HttpError(400, "Temporary password must be at least 8 characters.");
    if (!ROLES.includes(body.role)) throw new HttpError(400, "Please select a role.");
    const { data: dup } = await db.from("app_users").select("id").ilike("username", escLike(username)).maybeSingle();
    if (dup) throw new HttpError(409, "That username is already in use. Please choose another username.");
    const member = { id: crypto.randomUUID(), username, firstName, lastName, name: `${firstName} ${lastName}` };
    const { salt, hash } = hashPassword(password);
    const ins = await db.from("app_users").insert({ id: member.id, username, first_name: firstName, last_name: lastName, name: member.name, pw_salt: salt, pw_hash: hash, password_requires_change: true, account_status: "Pending Password Setup" });
    if (ins.error?.code === "23505") throw new HttpError(409, "That username is already in use. Please choose another username.");
    must(ins);
    const mem = await db.from("memberships").insert({ workspace_id: ws, user_id: member.id, role: body.role });
    if (mem.error) { await db.from("app_users").delete().eq("id", member.id); throw mem.error; }
    await log(ws, user, `created an account for ${member.name} as ${body.role}`);
    return send(req, 201, { member: { ...member, role: body.role, status: "Pending Password Setup" } });
  }
  if (sub === "members" && p[4] === "reset-password" && method === "POST") {
    await throttle(`password-reset:${user.id}:${ip}`);
    const t = await targetMember(ws, p[3] ?? "");
    const password = String(body.temporaryPassword ?? "");
    if (!validPassword(password)) throw new HttpError(400, "Temporary password must be at least 8 characters.");
    const { salt, hash } = hashPassword(password);
    must(await db.from("app_users").update({ pw_salt: salt, pw_hash: hash, password_requires_change: true, account_status: t.account_status === "Suspended" ? "Suspended" : "Pending Password Setup" }).eq("id", t.id));
    must(await db.from("sessions").delete().eq("user_id", t.id));
    await log(ws, user, `reset the password for ${t.name}`);
    return send(req, 200, { ok: true });
  }
  if (sub === "members" && p[4] === "profile" && method === "PATCH") {
    const t = await targetMember(ws, p[3] ?? "");
    const firstName = cleanText(body.firstName, 60), lastName = cleanText(body.lastName, 60);
    if (!firstName || !lastName) throw new HttpError(400, "Please enter a first and last name.");
    must(await db.from("app_users").update({ first_name: firstName, last_name: lastName, name: `${firstName} ${lastName}` }).eq("id", t.id));
    await log(ws, user, `updated the account name for ${t.name}`);
    return send(req, 200, { ok: true });
  }
  if (sub === "members" && p[4] === "status" && method === "PATCH") {
    const t = await targetMember(ws, p[3] ?? "");
    if (!["Active", "Suspended"].includes(body.status)) throw new HttpError(400, "Unknown account status.");
    const r = await db.rpc("hom_set_status", { ws, uid: t.id, new_status: body.status });
    if (r.error) throw rpcError(r.error);
    await log(ws, user, `${body.status === "Suspended" ? "suspended" : "reactivated"} ${t.name}'s account`);
    return send(req, 200, { ok: true });
  }
  if (sub === "members" && p.length === 4 && method === "PATCH") {
    const t = await targetMember(ws, p[3] ?? "");
    if (!ROLES.includes(body.role)) throw new HttpError(400, "Unknown role.");
    const r = await db.rpc("hom_set_role", { ws, uid: t.id, new_role: body.role });
    if (r.error) throw rpcError(r.error);
    await log(ws, user, `changed ${t.name}’s role to ${body.role}`);
    return send(req, 200, { ok: true });
  }
  if (sub === "members" && p.length === 4 && method === "DELETE") {
    const t = await targetMember(ws, p[3] ?? "");
    const r = await db.rpc("hom_remove_member", { ws, uid: t.id });
    if (r.error) throw rpcError(r.error);
    await log(ws, user, `removed ${t.name} from the workspace`);
    return send(req, 200, { ok: true });
  }
  throw new HttpError(404, "Not found.");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(req) });
  try {
    return await route(req, new URL(req.url));
  } catch (e) {
    if (e instanceof HttpError) return send(req, e.status, { error: e.message });
    console.error(e);
    return send(req, 500, { error: "Something went wrong while signing you in. Please try again." });
  }
});
