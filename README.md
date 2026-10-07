# House of Mercy Content Hub

A responsive browser-based workspace for organizing church content ideas, planning reminders and goals, collaborating on an idea board, importing Meta Insights CSV exports, and exploring data-derived performance insights.

## Run locally

Open `index.html` directly, or serve this directory with any static web server:

```sh
python3 -m http.server 8000
```

Then visit `http://localhost:8000`.

## Current scope

This first implementation is a client-side prototype. Workspace content is saved in the current browser's local storage; it is not a shared database and does not include secure authentication, server-enforced permissions, or email delivery. Invitation, membership, and role rules live in `access.js` (a pure module meant to move server-side, tested with plain Node) and are applied in the browser as a preview only. AI drafts use local templates (no AI API is connected), and live trend data is unavailable. Do not use this prototype for sensitive information or as a production multi-user workspace.

CSV imports accept mapped available columns and retain import history in the browser. Analytics and posting-time suggestions are calculated only from imported rows; unavailable information is not fabricated. Use Settings to export or clear the local workspace data.
