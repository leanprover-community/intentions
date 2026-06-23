import * as core from '@actions/core'
import { setNote, clearNote } from '../github/projects.js'
import { type Deps } from './deps.js'

/** Project v2 text fields are bounded; cap the scraped note so a long comment can't fail the write. */
export const MAX_NOTE_LENGTH = 1024

/**
 * Record the freeform note scraped from a claim/assign comment.
 *
 * With a non-empty note: writes it (truncated to a safe length) when the board has a note field,
 * else logs and ignores it (notes are an optional convenience). With an empty note: a no-op,
 * unless `clearIfEmpty` is set — fresh claims/assignments pass that so a new holder never inherits a
 * stale note left over from a failed clear or a manual board edit; renews leave the note as-is.
 *
 * Truncation iterates by code point (spread), so it can't split a surrogate pair and store
 * broken Unicode for notes ending in an emoji or other non-BMP character.
 */
export async function writeNote(deps: Deps, itemId: string, note: string, clearIfEmpty = false): Promise<void> {
  const { octokit, ctx } = deps
  const trimmed = note.trim()
  if (!trimmed) {
    if (clearIfEmpty) await clearNote(octokit, ctx, itemId)
    return
  }
  if (!ctx.noteFieldId) {
    core.info(`A claim note was provided but the board has no "${deps.cfg.noteField}" Text field; ignoring it.`)
    return
  }
  const chars = [...trimmed]
  const text = chars.length > MAX_NOTE_LENGTH ? `${chars.slice(0, MAX_NOTE_LENGTH - 1).join('')}…` : trimmed
  await setNote(octokit, ctx, itemId, text)
}
