import type { JotLocale } from './types.js'

export type AskAgentOutcome = 'inserted' | 'copied' | 'failed'
export interface AskAgentNote { id: string; title: string }

/** The agent finds the note by id with jot_read; the title only helps the person reading the message. */
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
  const en = locale === 'en'
  if (outcome === 'inserted') return en ? 'Added to the message box' : '已放进输入框'
  if (outcome === 'copied') return en ? 'Copied — paste it into a conversation' : '已复制，可粘贴到对话中'
  return en ? 'Could not add the note to the message box or copy it. Try again.' : '没能放进输入框，也没能复制，请重试。'
}
