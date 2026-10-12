/** 编辑器默认属性和键顺序不算修改。null 与缺省相同，避免没打字也产生一次保存。 */
function normalizeRich(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeRich)
  if (!value || typeof value !== 'object') return value
  const record = value as Record<string, unknown>
  const result: Record<string, unknown> = {}
  for (const key of Object.keys(record).sort()) {
    if (key === 'attrs' && record.attrs && typeof record.attrs === 'object' && !Array.isArray(record.attrs)) {
      const attrs: Record<string, unknown> = {}
      for (const attr of Object.keys(record.attrs as Record<string, unknown>).sort()) {
        const attrValue = (record.attrs as Record<string, unknown>)[attr]
        if (attrValue === null || attrValue === undefined) continue
        attrs[attr] = normalizeRich(attrValue)
      }
      if (Object.keys(attrs).length) result.attrs = attrs
      continue
    }
    const child = normalizeRich(record[key])
    if (child !== undefined) result[key] = child
  }
  return result
}

export function sameEditorDocument(left: unknown, right: unknown): boolean {
  return JSON.stringify(normalizeRich(left)) === JSON.stringify(normalizeRich(right))
}
