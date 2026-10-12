import type { RichDoc } from '../client/types.js'

/** Host echoes may trail keystrokes. Metadata updates cannot roll back newer local text. */
export class EditorSync {
  private value: RichDoc | null = null
  private revision = 0
  private documentId: string | null = null

  /** 换笔记时清掉上一篇的修订号，否则新文档会被当成过期回声丢掉。同一篇再发属性不会重置。 */
  beginDocument(id: string): void {
    if (this.documentId === id) return
    this.documentId = id
    this.value = null
    this.revision = 0
  }

  /** React may commit after another input event. Check at application time. */
  prepareHostUpdate(value: RichDoc, acknowledged: number): () => RichDoc {
    return () => {
      if (this.value === null || acknowledged >= this.revision) {
        this.value = value
        this.revision = Math.max(this.revision, acknowledged)
      }
      return this.value
    }
  }

  edited(value: RichDoc): { content: RichDoc; revision: number } {
    this.value = value
    return { content: value, revision: ++this.revision }
  }
}
