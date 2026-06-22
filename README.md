# claim-bot

Coordinate who works on what. Contributors **claim** tasks by commenting on GitHub issues;
the bot assigns them and moves a card on a Projects v2 board. Claims can carry a
configurable **expiry (TTL)**, so abandoned work is released automatically instead of
blocking everyone forever.

This is a single, reusable GitHub Action — projects opt in with a couple of small workflow
files, no copy-pasted scripts.

## How it works

Comment on an issue that's on the project board:

| Comment | Effect |
|---|---|
| `claim` | Claim the task with the project's default TTL. |
| `claim 2w` · `claim 5 hours` · `claim 2026-08-01` | Claim with a custom expiry (duration or date). |
| `claim …` (again, as the holder) | Renew / extend your claim. |
| `disclaim` | Release a task you hold. |
| `propose PR #123` | Link your PR; move the task to *In Progress* (refreshes the TTL). |
| `withdraw PR #123` | Move back to *Claimed* (you keep the claim). |

Durations are parsed flexibly: `1h`, `1 hr`, `5 hours`, `7d`, `7 days`, `2wks`, `3 weeks`,
`2 mths`, `3 months` (a month = 30 days). Dates are `YYYY-MM-DD` or full ISO 8601. The bot
always tells you the effective expiry, and rejects requests over the project maximum with a
helpful message.

The board's `Status` field moves `Unclaimed → Claimed → In Progress`, and a scheduled
**sweep** returns expired claims to `Unclaimed`.

## Adoption

A four-step recipe. (To adopt without any expiry behavior, see step 2's note — you can skip
the `Claim Expires` field and the sweep workflow entirely.)

### 1. Set up the board

On your **Projects v2** board, make sure you have:

- a **single-select** field `Status` with options `Unclaimed`, `Claimed`, `In Progress`
  (add `In Review` / `Completed` too if you use them);
- a **Text** field `Claim Expires` (the bot stores each claim's expiry here as an ISO 8601
  UTC datetime). *Skip this if you set `default-ttl: none`.*

Add issues to the board and set their `Status` to `Unclaimed` — those are the claimable tasks.

### 2. Create a GitHub App

The bot needs to read/write the project and assign/comment on issues. The default
`GITHUB_TOKEN` **cannot** write org Projects v2, so it authenticates as a GitHub App (a PAT
works too — see below). With an App, the bot acts under its own `…[bot]` identity.

Create an App (org → **Settings → Developer settings → GitHub Apps → New**) with:

- **Repository permissions:** Issues → Read and write; Pull requests → Read and write.
- **Organization permissions:** Projects → Read and write. *(Account permissions → Projects
  if the board is user-owned.)*

**Install** it on the repo with your issues, generate a **private key**, then set:

- a variable `CLAIM_BOT_APP_ID` (the App's numeric ID), and
- a secret `CLAIM_BOT_APP_PRIVATE_KEY` (the downloaded `.pem` contents).

> Prefer a PAT? Set a secret `CLAIM_BOT_TOKEN` (fine-grained PAT with the three permissions
> above; org-owned boards need the Projects permission under *Organization*). Then use the
> `project-token:` secret in the workflows below instead of the App inputs.

See [examples/board-setup.md](examples/board-setup.md) for the full details.

### 3. Add the command workflow

Create `.github/workflows/claim.yml`:

```yaml
name: Claim bot
on:
  issue_comment:
    types: [created]
jobs:
  claim:
    uses: leanprover-community/claim-bot/.github/workflows/claim-commands.yml@v1
    with:
      project-title: "My Project"   # exact title of your Projects v2 board
      default-ttl: "30d"            # use "none" to disable expiry entirely
      max-ttl: "90d"
      app-id: ${{ vars.CLAIM_BOT_APP_ID }}
    secrets:
      app-private-key: ${{ secrets.CLAIM_BOT_APP_PRIVATE_KEY }}
```

### 4. Add the sweep workflow

Create `.github/workflows/claim-sweep.yml` (skip this if `default-ttl: none`):

```yaml
name: Claim bot sweep
on:
  schedule:
    - cron: "17 */6 * * *"   # tighter (e.g. "*/15 * * * *") if you use short TTLs
  workflow_dispatch: {}
jobs:
  sweep:
    uses: leanprover-community/claim-bot/.github/workflows/claim-sweep.yml@v1
    with:
      project-title: "My Project"
      default-ttl: "30d"
      app-id: ${{ vars.CLAIM_BOT_APP_ID }}
    secrets:
      app-private-key: ${{ secrets.CLAIM_BOT_APP_PRIVATE_KEY }}
```

That's it. Contributors now claim tasks by commenting `claim`.

## Expiry: defaults, limits, and opting out

- `default-ttl` (default `30d`) — applied to a bare `claim`.
- `max-ttl` (default `90d`) — the longest a claimant may request.
- **Opt out entirely:** set `default-ttl: none`. The bot then never records or mentions
  expiry, the sweep is a no-op, and you don't need the `Claim Expires` field or the sweep
  workflow. (You still get the maintained, reusable claim workflow.)

> **Sub-day TTLs are best-effort.** GitHub's `cron` fires loosely (often delayed many
> minutes), so a `1h` claim is released at *next sweep ≥ expiry*, not on the minute. If you
> rely on short TTLs, run the sweep more often (e.g. `*/15 * * * *`). An explicit `disclaim`
> always releases immediately.

## Configuration

All inputs (set on the reusable workflows):

| input | default | meaning |
|---|---|---|
| `project-title` | — (required) | exact title of the Projects v2 board |
| `default-ttl` | `30d` | TTL for a bare `claim`; `none`/`off` disables expiry |
| `max-ttl` | `90d` | maximum requestable TTL |
| `status-field` | `Status` | single-select field name |
| `status-unclaimed` / `status-claimed` / `status-in-progress` | `Unclaimed` / `Claimed` / `In Progress` | option names |
| `terminal-statuses` | `In Review,Completed` | states recognized but not managed |
| `expiry-field` | `Claim Expires` | Text field holding the ISO 8601 UTC expiry |
| `expire-in-progress` | `false` | also expire *In Progress* items in the sweep |
| `backfill-legacy` | `grace` | how the sweep treats claims with no expiry: `grace` / `ignore` / `expire` |

## Migrating from the original four-file bot

Replace the per-project `01-claim-issue.yml` … `04-withdraw-pr.yml` with the two workflows
above (one PR). The command vocabulary is unchanged, so contributors notice nothing except
that claims now expire. To preserve the old "claims never expire" behavior, set
`default-ttl: none`. Existing open claims (which have no recorded expiry) are handled by
`backfill-legacy` — the default `grace` gives them `now + default-ttl` on first sweep rather
than expiring them immediately.

The bot assumes a **single assignee per claim** (the claimant). On expiry the sweep clears
the assignee; don't co-assign maintainers to claim-managed issues, or set the expiry on the
board directly to override.

## Development

```bash
npm install
npm run typecheck && npm run lint && npm run test
npm run build        # compiles src/ into the committed dist/ via @vercel/ncc
```

The action runs from `dist/`, which is **committed**. CI fails if `dist/` is out of date, so
always `npm run build` and commit the result with any source change. Contributions welcome.

## Credits

This bot is a reimplementation of, and owes everything to, the claim/dashboard workflow
originally designed and built by **[Pietro Monticone](https://github.com/pitmonticone)** and
**[Shreyas Srinivas](https://github.com/Shreyas4991)** for the
[Equational Theories Project](https://github.com/teorth/equational_theories), and
subsequently deployed by Pietro to
[FLT](https://github.com/ImperialCollegeLondon/FLT),
[PrimeNumberTheorem+](https://github.com/AlexKontorovich/PrimeNumberTheoremAnd), and
[∞-Cosmos](https://github.com/emilyriehl/infinity-cosmos). The `claim` / `disclaim` /
`propose PR` / `withdraw PR` vocabulary and the board-driven workflow are theirs; this repo
repackages that idea as a maintained, reusable action and adds claim expiry. Thank you both.

## License

Apache-2.0.
