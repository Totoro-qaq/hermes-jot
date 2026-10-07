/** One bounded stdio request per process; the request logic lives in worker-request.ts so tests can import it. */
import type { JotStore } from './store.js'
import { createJotTools } from './tools.js'
import { toolSchema } from './tool-definition.js'
import { runWorker } from './worker-request.js'

export { runWorker } from './worker-request.js'

const MAX_INPUT = 30 * 1024 * 1024

async function main() {
  if (process.argv.includes('--schemas')) {
    process.stdout.write(JSON.stringify(createJotTools(null as unknown as JotStore).map(toolSchema)))
    return
  }
  let size = 0
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) {
    size += chunk.length
    if (size > MAX_INPUT) throw new Error('Request exceeds the attachment limit.')
    chunks.push(chunk)
  }
  const input = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  try { process.stdout.write(JSON.stringify(await runWorker(input, process.argv[2] ?? ''))) }
  catch (error) {
    const known = error && typeof error === 'object' && 'code' in error
    process.stdout.write(JSON.stringify({ error: { code: known ? error.code : 'INVALID_INPUT',
      message: error instanceof Error ? error.message : 'The operation failed.' },
      status: error && typeof error === 'object' && 'status' in error ? error.status : 400 }))
  }
}
main().catch(() => { process.stdout.write(JSON.stringify({ status: 400, error: { code: 'INVALID_INPUT', message: 'Invalid worker request.' } })); process.exitCode = 1 })
