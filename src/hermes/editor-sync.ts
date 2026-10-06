import type { RichDoc } from '../client/types.js'

/** Host echoes may trail keystrokes. Metadata updates cannot roll back newer local text. */
export class EditorSync {
  private value: RichDoc | null = null
  private revision = 0

  fromHost(value: RichDoc, acknowledged: number): RichDoc {
    if (this.value === null || acknowledged >= this.revision) {
      this.value = value
      this.revision = Math.max(this.revision, acknowledged)
    }
    return this.value
  }

  edited(value: RichDoc): { content: RichDoc; revision: number } {
    this.value = value
    return { content: value, revision: ++this.revision }
  }
}
