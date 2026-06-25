import * as core from '@actions/core'
import { parseTtlSetting, type TtlSetting } from './ttl.js'

export type Mode = 'command' | 'sweep' | 'lifecycle'
export type BackfillMode = 'grace' | 'ignore' | 'expire'

export interface Config {
  mode: Mode
  token: string
  repoToken: string
  projectTitle: string
  statusField: string
  statusUnclaimed: string
  statusClaimed: string
  statusInProgress: string
  statusInReview: string
  statusCompleted: string
  terminalStatuses: string[]
  expiryField: string
  noteField: string
  defaultTtl: TtlSetting
  maxTtlMs: number | null
  expireInProgress: boolean
  backfillLegacy: BackfillMode
  autoAdd: boolean
  autoAddLabels: string[]
  claimOnOpen: boolean
  claimExpiryField: string
}

/** True when the project has turned expiry off entirely (default-ttl: none). */
export function expiryEnabled(cfg: Config): boolean {
  return !cfg.defaultTtl.disabled
}

/**
 * Should a newly-opened issue carrying these labels be auto-added to the board?
 * `auto-add: false` disables it entirely. Otherwise an empty `auto-add-labels` adds every issue,
 * and a non-empty `auto-add-labels` adds only issues carrying at least one of those labels
 * (case-insensitive), e.g. set it to `intention` so only intention issues land on the board.
 */
export function shouldAutoAdd(cfg: Config, issueLabels: string[]): boolean {
  if (!cfg.autoAdd) return false
  if (cfg.autoAddLabels.length === 0) return true
  const have = new Set(issueLabels.map((l) => l.toLowerCase()))
  return cfg.autoAddLabels.some((l) => have.has(l.toLowerCase()))
}

function parseMode(raw: string): Mode {
  if (raw === 'command' || raw === 'sweep' || raw === 'lifecycle') return raw
  throw new Error(`Invalid mode ${JSON.stringify(raw)}; expected "command", "sweep", or "lifecycle".`)
}

function parseBackfill(raw: string): BackfillMode {
  if (raw === 'grace' || raw === 'ignore' || raw === 'expire') return raw
  throw new Error(`Invalid backfill-legacy ${JSON.stringify(raw)}; expected "grace", "ignore", or "expire".`)
}

export function readConfig(): Config {
  const defaultTtl = parseTtlSetting(core.getInput('default-ttl') || '30d')
  const maxTtl = parseTtlSetting(core.getInput('max-ttl') || '90d')

  // The project token writes Projects v2 (the default GITHUB_TOKEN can't). Issue/PR REST ops use
  // repo-token, which the reusable workflow sets to the job GITHUB_TOKEN; fall back to the project
  // token when repo-token is unset, so a GitHub-App installation token still drives everything.
  const token = core.getInput('project-token', { required: true })

  return {
    mode: parseMode(core.getInput('mode', { required: true })),
    token,
    repoToken: core.getInput('repo-token') || token,
    projectTitle: core.getInput('project-title', { required: true }),
    statusField: core.getInput('status-field') || 'Status',
    statusUnclaimed: core.getInput('status-unclaimed') || 'Unclaimed',
    statusClaimed: core.getInput('status-claimed') || 'Claimed',
    statusInProgress: core.getInput('status-in-progress') || 'In Progress',
    statusInReview: core.getInput('status-in-review') || 'In Review',
    statusCompleted: core.getInput('status-completed') || 'Completed',
    terminalStatuses: (core.getInput('terminal-statuses') || 'In Review,Completed')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    expiryField: core.getInput('expiry-field') || 'Claim Expires',
    noteField: core.getInput('note-field') || 'Claim Note',
    defaultTtl,
    maxTtlMs: maxTtl.disabled ? null : maxTtl.ms,
    expireInProgress: core.getBooleanInput('expire-in-progress'),
    backfillLegacy: parseBackfill(core.getInput('backfill-legacy') || 'grace'),
    autoAdd: boolInput('auto-add', true),
    autoAddLabels: (core.getInput('auto-add-labels') || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    claimOnOpen: boolInput('claim-on-open', false),
    claimExpiryField: core.getInput('claim-expiry-field') || '',
  }
}

/** Boolean input with a default when unset (core.getBooleanInput throws on empty). */
function boolInput(name: string, dflt: boolean): boolean {
  const raw = core.getInput(name)
  if (!raw) return dflt
  return core.getBooleanInput(name)
}
