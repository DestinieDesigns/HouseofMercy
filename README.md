# House of Mercy Content Hub

A responsive browser-based workspace for organizing church content ideas, planning reminders and goals, collaborating on an idea board, importing Meta Insights CSV exports, and exploring data-derived performance insights.

## Run locally

Requires Node.js 22.5 or newer (uses the built-in `node:sqlite`; no npm dependencies).

```sh
npm start        # http://localhost:8000
npm test         # API integration tests (temporary database)
```

Data is stored in `data/hom.db` (override with `HOM_DB`; set `PORT` to change the port; set `HOM_SECURE_COOKIE=1` behind HTTPS).

## Shared workspace

Everyone has their own login, and everyone works in the same **House of Mercy** workspace.

- **Structure:** User → Workspace Membership → Workspace → Workspace Data. Every item, comment, and activity row carries a `workspace_id`, and every request is checked against the caller's membership, so one workspace can never read another's data. More churches can be added later as new `workspaces` rows with no schema change.
- **Accounts:** username + password (scrypt-hashed), HttpOnly session cookie. Email is not required or stored. Existing email-based accounts are migrated to usernames based on their former email name and retain their password hashes.
- **Roles (enforced on the server):** *Admin* – create accounts, reset passwords, manage roles and settings, and manage all content. *Editor* – create/edit all content, assign work, move board items, comment. *Contributor* – create ideas, view, comment, and update ideas created by or assigned to them.
- **Initial Admin:** on a new database, set `HOM_ADMIN_INITIAL_PASSWORD` through the deployment environment before starting the server. This provisions `HOMMediaAdmin` with a required password change; do not put the password in source control. The initial password must be at least eight characters.
- **Accounts:** Admins create accounts under Team → Create Account and provide the username and temporary password directly to the user. Temporary passwords are hashed and must be changed at first login. Users can change their own passwords in Settings → Security; forgotten passwords must be reset by an Admin.
- **Account management:** Admins can change names and roles, reset passwords, suspend/reactivate accounts, and remove workspace access without deleting the underlying account. A final active Admin cannot be suspended, removed, or downgraded.
- **Sharing:** the app polls every few seconds, so changes (new ideas, board moves, comments, assignments) appear for everyone with access. The Team and My Work pages show assigned work, and the activity log records who did what.

CSV imports accept mapped available columns and retain import history in the browser. Analytics and posting-time suggestions are calculated only from imported rows; unavailable information is not fabricated. Admins can export workspace data from Settings.

## Supabase backend (GitHub Pages deployment)

Production runs as a static GitHub Pages frontend + Supabase (PostgreSQL + the `hom-api` Edge Function). See [docs-supabase-migration.md](docs-supabase-migration.md) for the schema, RLS, auth design, deployment steps and the SQLite migration script. `config.js` holds only the public Supabase URL and publishable key; the secret key must never be committed.
