import type { RichDoc } from '../client/types.js'

/** Host echoes may trail keystrokes. Metadata updates cannot roll back newer local text. */
export class EditorSync {
  private value: RichDoc | null = null
  private revision = 0
  private documentId: string | null = null
  private generation = 0

  /** 换笔记或换代次时清掉上一份修订号。同一代次再发属性不会重置。 */
  beginDocument(id: string, generation = 0): void {
    if (this.documentId === id && this.generation === generation) return
    this.documentId = id
    this.generation = generation
    this.value = null
    this.revision = 0
  }

  /**
   * React may commit after another input event. Check at application time.
   * 修订号只在同一代次里比较。旧代次的 rev 1 不能盖掉回到这篇之后新打出来的 rev 1。
   */
  prepareHostUpdate(value: RichDoc, acknowledged: number, acknowledgedGeneration = this.generation): () => RichDoc {
    return () => {
      const sameGeneration = acknowledgedGeneration === this.generation
      if (this.value === null) {
        this.value = value
        if (sameGeneration) this.revision = Math.max(this.revision, acknowledged)
        return this.value
      }
      if (sameGeneration && acknowledged >= this.revision) {
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
