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
- **Accounts:** per-user email + password (scrypt-hashed), HttpOnly session cookie. The first account created becomes the Admin of House of Mercy; after that, sign-up requires an invitation.
- **Roles (enforced on the server):** *Admin* – everything, including invites, roles, and settings. *Editor* – create/edit all content, assign work, move board items, comment. *Contributor* – create ideas, view, comment, and update ideas created by or assigned to them.
- **Invitations:** Team → Invite Member → email + role. Status is shown as Pending, Accepted, or Expired (7 days). Email delivery is not connected, so the admin copies the generated invitation link and sends it; the invitee must use the invited email address.
- **Sharing:** the app polls every few seconds, so changes (new ideas, board moves, comments, assignments) appear for everyone with access. The Team and My Work pages show assigned work, and the activity log records who did what.

CSV imports accept mapped available columns and retain import history in the browser. Analytics and posting-time suggestions are calculated only from imported rows; unavailable information is not fabricated. Admins can export workspace data from Settings.
