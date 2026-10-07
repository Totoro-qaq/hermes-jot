import type { RichDoc } from '../client/types.js'

/** Host echoes may trail keystrokes. Metadata updates cannot roll back newer local text. */
export class EditorSync {
  private value: RichDoc | null = null
  private revision = 0

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
