# Supabase migration report

## Phase 1 – existing behavior (spec, from `server.js`)
- **users**: id, username (unique, case-insensitive, `^[A-Za-z0-9_-]{3,30}$`), first/last/name, scrypt `pw_salt`/`pw_hash`, `password_requires_change`, `account_status` (Active / Pending Password Setup / Suspended), `last_login`.
- **workspaces / memberships**: User → Membership(role) → Workspace; single workspace `house-of-mercy`.
- **sessions**: random 32-byte token, only its sha256 stored, 30-day expiry (now 12h), deleted on logout / password reset / suspension.
- **items**: JSON documents per `(workspace, collection)`: ideas, reminders, goals, analytics, hashtagSets, imports. **kv**: settings, lastGeneration. **comments**: threaded one level, on ideas/reminders/goals. **activity**: append-only log (latest 100 returned).
- **Password change enforcement**: while `password_requires_change`, every workspace route returns 403 until `/change-password`; changing requires current password unless forced.
- **Roles**: Admin all; Editor all content; Contributor only ideas (create; edit only own/assigned; no delete, no reassign, status forced to `Ideas` on create); only Admin manages members/settings; own comments deletable, Admin any.
- **Admin provisioning**: first start with an empty DB creates `HOMMediaAdmin` from `HOM_ADMIN_INITIAL_PASSWORD`, forced change.
- **Last-admin rule**: cannot remove / downgrade / suspend the last active Admin.

## What was created
- **Tables** (`supabase/migrations/20261007000001_hom_schema.sql`): `workspaces, app_users, memberships, sessions, login_attempts, items, kv, comments, activity` (replace SQLite) and `content_ideas, calendar_items, campaigns, goals, reminders, events, published_content, content_analytics, meta_imports, hashtags, ai_recommendations` (content system, empty for now; composite `(workspace_id, id)` FKs keep Idea → Calendar → Published → Analytics → AI links inside one workspace; metric columns are nullable; `meta_imports.file_hash` unique per workspace blocks duplicate imports and `raw_data` preserves raw rows).
- **RLS**: enabled on every table; table privileges revoked from `anon`/`authenticated`; one restrictive `deny_browser_<table>` policy (`using (false)`) per table. The publishable key therefore can read/write nothing directly.
- **SQL functions** (service role only): `hom_active_admins`, `hom_set_role`, `hom_set_status`, `hom_remove_member` — atomic, row-locked last-admin guards.
- **Edge Function**: `hom-api` – a 1:1 port of the Node routes (`/login /logout /me /change-password /w/:id…`). Deployed with `verify_jwt = false` because it does its own username/password session auth.

## Authentication
Supabase Auth requires an email/phone identity, which the spec forbids, so it is not used. Instead: browser → `hom-api` → scrypt verify (same scheme as the Node app, so existing hashes are valid) → random opaque session token; only its sha256 is stored. The browser keeps the token in `sessionStorage` (survives refresh and navigation, cleared when the tab closes, never `localStorage`) and sends it in `x-hom-session`. HttpOnly cookies are not usable because `github.io` → `supabase.co` is cross-site; this is the documented trade-off. Logout deletes the server session. The service-role key exists only in the Edge Function environment. Workspace ids from the browser are always re-verified against the caller's membership; all role checks run in the function / SQL.

## HTTP 405
GitHub Pages only serves static files, so `POST /api/login` was rejected. The frontend now calls `https://<project>.supabase.co/functions/v1/hom-api/login` (CORS-enabled, `apikey` = publishable key). No fake `/api` exists on Pages.

## Deploy
1. `supabase link --project-ref <ref>`; `supabase db push`.
2. `supabase secrets set HOM_ADMIN_INITIAL_PASSWORD=<temporary password>` (never commit; the first login creates `HOMMediaAdmin` with forced change). CORS defaults to `https://destiniedesigns.github.io`; set `HOM_ALLOWED_ORIGINS` only if additional trusted origins are required.
3. `supabase functions deploy hom-api --no-verify-jwt`.
4. Add `SUPABASE_PUBLISHABLE_KEY` in GitHub → Settings → Secrets and variables → Actions → Variables (or Secrets), or under Settings → Environments → `github-pages` → Variables (or Secrets). Use the project's publishable key, never a secret/service-role key. The Pages workflow fixes the URL to this project, validates the key, runs tests, and fails rather than publishing if the key is missing or privileged.

## Data migration
`node scripts/migrate-sqlite-to-supabase.js` (dry-run) then `--apply` with `SUPABASE_URL`/`SUPABASE_SECRET_KEY` in your shell only. Migrates workspaces, users, memberships, items, kv, comments, activity. Hashes are scrypt, so they remain valid; use `--require-reset` to skip them and force Admin re-provisioning. Sessions are not migrated.

## Remains / not yet done
- Not deployed or tested against a live Supabase project or GitHub Pages from this environment (no credentials). Run the Phase 14 checks after deploying. `test.js` still tests the legacy Node server.
- The Node/SQLite server (`server.js`, `test.js`) is intentionally **not removed** until migration is verified.
- Content-system tables are created but the UI still stores ideas/analytics in `items`; the Meta importer persists via `items` (`analytics`/`imports`) for now.
- Secret scan: no secrets found in the working tree; `git log -S` for the initial password found none. Rotate any key if you find it was ever committed.
