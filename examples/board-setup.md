# One-time board setup

Intentions drives a **GitHub Projects v2** board. You need two fields on it.

## 1. Status (single-select)

A single-select field (default name `Status`) with at least these options:

- `Unclaimed` — available to claim
- `Claimed` — someone holds it
- `In Progress` — a draft PR is open for the task
- (optional) `In Review` — a ready PR is open; the lifecycle moves the task here
- (optional) `Completed` — the PR merged or the issue closed; the lifecycle moves the task here

The two optional options unlock the full PR-driven lifecycle (see the README); if your board
doesn't have them, those transitions are skipped cleanly. Option **names** are configurable
via inputs (`status-unclaimed`, `status-in-review`, `status-completed`, etc.) if yours differ.

## 2. Claim Expires (text)

A **Text** field named `Claim Expires`. The bot writes each claim's expiry here as an
ISO 8601 UTC datetime (e.g. `2026-08-01T14:00:00Z`); the sweep reads it. A Text field is
used (not a Date field) so hour-granularity TTLs are representable.

> If you set `default-ttl: none` (expiry disabled), you do **not** need this field, and you
> can drop the `schedule` trigger from the workflow (the sweep then does nothing).

## 3. Claim Note (text, optional)

A **Text** field named `Claim Note`. When someone claims a task, any lines following the
`claim` command in their comment are scraped verbatim into this field, so the board shows what
each claimant said they're doing. It's cleared when the claim is released.

> This field is optional. If the board doesn't have it, notes are silently ignored. Rename it
> with the `note-field` input.

## 4. Tasks

Add issues to the board and set their `Status` to `Unclaimed`. Each such issue is claimable.

## 5. Authentication

The bot needs to read/write the project and assign/comment on issues. The default
`GITHUB_TOKEN` **cannot** write org-level Projects v2, so a separate credential is required.

### GitHub App (recommended)

The bot acts under its own `…[bot]` identity, the token is short-lived (minted per run by
`actions/create-github-app-token`), and there's no SAML/expiry hassle.

1. Org → **Settings → Developer settings → GitHub Apps → New GitHub App**.
2. Permissions:
   - **Repository permissions:** Issues → Read and write; Pull requests → Read and write.
   - **Organization permissions:** Projects → Read and write. *(Or Account permissions →
     Projects, if the board is user-owned.)*
3. Create the App, **Install** it on the repository that holds your issues, and **generate a
   private key** (downloads a `.pem`).
4. In that repository (Settings → Secrets and variables → Actions):
   - add a **variable** `INTENTIONS_BOT_APP_ID` = the App's numeric ID;
   - add a **secret** `INTENTIONS_BOT_APP_PRIVATE_KEY` = the full contents of the `.pem`.

The caller workflows pass `app-id` + `app-private-key`; the bot mints an org-scoped
installation token at runtime.

### Fine-grained PAT (alternative)

A fine-grained PAT with `Issues: Read and write`, `Pull requests: Read and write`, and
`Projects: Read and write`. For an **org-owned** board the Projects permission must be set
under **Organization permissions** (and the token's resource owner must be that org); for an
org with SAML SSO the token must be SAML-authorized. Store it as a secret `INTENTIONS_BOT_TOKEN`
and pass it to the workflows via `project-token:` instead of the App inputs.
