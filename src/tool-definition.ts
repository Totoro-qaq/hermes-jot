/** Host-neutral tool definition; the Hermes registrar consumes the generated JSON schemas. */
type Field = { type: string; description?: string; required?: boolean }
export interface JotToolDefinition {
  name: string
  description: string
  parameters: Record<string, Field>
  output: unknown
  execute: (args: Record<string, any>) => Promise<unknown>
}
export function defineTool(tool: JotToolDefinition): JotToolDefinition { return tool }

export function toolSchema(tool: JotToolDefinition) {
  return { name: tool.name, description: tool.description, parameters: {
    type: 'object', additionalProperties: false,
    properties: Object.fromEntries(Object.entries(tool.parameters).map(([name, { required: _, ...field }]) => [name, field])),
    required: Object.entries(tool.parameters).filter(([, field]) => field.required).map(([name]) => name),
  } }
}

export function validateToolArgs(tool: JotToolDefinition, args: unknown): asserts args is Record<string, any> {
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Tool arguments must be an object.')
  for (const [name, value] of Object.entries(args)) {
    const field = tool.parameters[name]
    if (!field) throw new Error(`Unknown argument: ${name}`)
    if (field.type === 'integer' ? !Number.isSafeInteger(value) : typeof value !== field.type) {
      throw new Error(`Invalid ${name}: expected ${field.type}.`)
    }
  }
  for (const [name, field] of Object.entries(tool.parameters)) {
    if (field.required && !(name in args)) throw new Error(`Missing argument: ${name}`)
  }
}
