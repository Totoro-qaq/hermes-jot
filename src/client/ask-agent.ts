import { translator } from './i18n.js'
import type { JotLocale } from './types.js'

export type AskAgentOutcome = 'inserted' | 'copied' | 'failed'
export interface AskAgentNote { id: string; title: string }

/** The agent finds the note by id with jot_read; the title only helps the person reading the message. Agent-facing, so always English. */
export function askAgentReference(note: AskAgentNote): string {
  const title = note.title.replace(/\s+/gu, ' ').trim()
  return `Jot note “${title || 'Untitled'}” (id: ${note.id})`
}

/** Put text in the message box when a composer answers, else on the clipboard. */
export async function deliverAskAgent(text: string, channels: {
  insert?: (text: string) => Promise<boolean>
  copy?: (text: string) => Promise<boolean>
}): Promise<AskAgentOutcome> {
  try { if (await channels.insert?.(text)) return 'inserted' } catch { /* fall back to the clipboard */ }
  try { if (await channels.copy?.(text)) return 'copied' } catch { /* reported as failed */ }
  return 'failed'
}

export function askAgentMessage(outcome: AskAgentOutcome, locale: JotLocale): string {
  const t = translator(locale)
  if (outcome === 'inserted') return t('Added to the message box')
  if (outcome === 'copied') return t('Copied — paste it into a conversation')
  return t('Could not add the note to the message box or copy it. Try again.')
}
