'use strict';
// One-off migration: data/hom.db (SQLite) -> Supabase. Run LOCALLY by an operator; never in the browser/CI logs.
//   node scripts/migrate-sqlite-to-supabase.js                  # dry run: prints row counts only
//   SUPABASE_URL=... SUPABASE_SECRET_KEY=... node scripts/migrate-sqlite-to-supabase.js --apply
//   add --require-reset to NOT copy password hashes (users get an unusable password + forced reset by an Admin)
// Idempotent (upserts). Sessions are never migrated. The SQLite DB is only read, never modified.
const path = require('node:path'), crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const apply = process.argv.includes('--apply'), reset = process.argv.includes('--require-reset');
const file = process.env.HOM_DB || path.join(__dirname, '..', 'data', 'hom.db');
const db = new DatabaseSync(file, { readOnly: true });
const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SECRET_KEY;

const rows = {
  workspaces: db.prepare('SELECT id,name,created_at FROM workspaces').all(),
  app_users: db.prepare('SELECT id,username,first_name,last_name,name,pw_salt,pw_hash,password_requires_change,account_status,created_at,last_login FROM users').all().map(u => {
    const out = { ...u, password_requires_change: !!u.password_requires_change };
    if (reset) { // unusable random credential; an Admin must issue a temporary password
      out.pw_salt = crypto.randomBytes(16).toString('hex'); out.pw_hash = crypto.randomBytes(64).toString('hex');
      out.password_requires_change = true; if (out.account_status !== 'Suspended') out.account_status = 'Pending Password Setup';
    }
    return out;
  }),
  memberships: db.prepare('SELECT workspace_id,user_id,role,created_at FROM memberships').all(),
  items: db.prepare('SELECT workspace_id,collection,id,data,seq FROM items ORDER BY seq').all().map(r => ({ ...r, data: JSON.parse(r.data) })),
  kv: db.prepare('SELECT workspace_id,key,data FROM kv').all().map(r => ({ ...r, data: JSON.parse(r.data) })),
  comments: db.prepare('SELECT id,workspace_id,target_kind,target_id,parent_id,user_id,user_name,body,created_at FROM comments ORDER BY created_at').all(),
  activity: db.prepare('SELECT id,workspace_id,user_id,user_name,text,created_at FROM activity ORDER BY id').all(),
};
const conflict = { workspaces: 'id', app_users: 'id', memberships: 'workspace_id,user_id', items: 'workspace_id,collection,id', kv: 'workspace_id,key', comments: 'id', activity: 'id' };
for (const [t, r] of Object.entries(rows)) console.log(`${t}: ${r.length} rows${reset && t === 'app_users' ? ' (password hashes NOT copied)' : ''}`);
if (!apply) { console.log('Dry run only. Re-run with --apply to write to Supabase.'); process.exit(0); }
if (!url || !key) { console.error('Set SUPABASE_URL and SUPABASE_SECRET_KEY (server-side only) to use --apply.'); process.exit(1); }
(async () => {
  for (const t of ['workspaces', 'app_users', 'memberships', 'items', 'kv', 'comments', 'activity']) {
    for (let i = 0; i < rows[t].length; i += 200) {
      const r = await fetch(`${url}/rest/v1/${t}?on_conflict=${conflict[t]}`, {
        method: 'POST',
        headers: { apikey: key, Authorization: 'Bearer ' + key, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify(rows[t].slice(i, i + 200)),
      });
      if (!r.ok) { console.error(`Failed on ${t}: HTTP ${r.status} ${await r.text()}`); process.exit(1); }
    }
    console.log(`migrated ${t}`);
  }
  console.log('Done. Verify counts in Supabase, then keep SQLite until verification is complete.');
})();
