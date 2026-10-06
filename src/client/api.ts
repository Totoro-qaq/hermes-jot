/** Typed errors shared by the UI and its host adapter. Transport belongs to Hermes SDK. */
export class JotApiError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) {
    super(message)
    this.name = 'JotApiError'
  }
}
