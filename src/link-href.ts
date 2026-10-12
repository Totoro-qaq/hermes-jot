const MAX_HREF = 2_048
const STORED_SCHEME = /^(?:https?:\/\/|mailto:|tel:|#)/iu
const WHITESPACE = /[\u0000-\u0020]/u
const EMAIL = /^[^\s@:]+@[^\s@]+\.[^\s@]+$/u
const DOMAIN = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}(?::\d{1,5})?(?:[/?#][^\s]*)?$/iu

/** http(s) 地址里带了用户名或密码。解析不了的 http(s) 也拒绝。其它协议交给各自的规则。 */
export function httpHrefHasCredentials(href: string): boolean {
  if (!/^https?:\/\//iu.test(href)) return false
  try {
    const url = new URL(href)
    return url.username !== '' || url.password !== ''
  } catch {
    return true
  }
}

/** 把用户输入收成存储层接受的 href。保留用户原文，不用 URL.href 改写。 */
export function normalizeLinkHref(raw: string): string | null {
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  if (!trimmed || trimmed.length > MAX_HREF) return null
  if (STORED_SCHEME.test(trimmed)) {
    if (WHITESPACE.test(trimmed) || httpHrefHasCredentials(trimmed)) return null
    if (/^https?:\/\//iu.test(trimmed)) {
      try {
        const url = new URL(trimmed)
        if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
      } catch { return null }
    }
    return trimmed
  }
  if (!WHITESPACE.test(trimmed) && EMAIL.test(trimmed)) {
    const href = `mailto:${trimmed}`
    return href.length <= MAX_HREF ? href : null
  }
  const phone = phoneHref(trimmed)
  if (phone) return phone
  if (!WHITESPACE.test(trimmed) && DOMAIN.test(trimmed)) {
    const href = `https://${trimmed}`
    if (href.length > MAX_HREF || httpHrefHasCredentials(href)) return null
    try {
      const url = new URL(href)
      if (url.protocol !== 'https:') return null
    } catch { return null }
    return href
  }
  return null
}

function phoneHref(value: string): string | null {
  const compact = value.replace(/[\u0000-\u0020]+/gu, '')
  if (!/^\+?[\d().-]{5,}$/u.test(compact)) return null
  const digits = compact.replace(/\D/gu, '')
  if (digits.length < 5 || digits.length > 15) return null
  const href = `tel:${compact}`
  return href.length <= MAX_HREF && !WHITESPACE.test(href) ? href : null
}

/** 只有网页和邮箱可以在宿主里打开；带账号密码的地址、电话和页内锚点都不打开。 */
export function openableLinkHref(raw: string): string | null {
  const href = normalizeLinkHref(raw)
  return href && /^(?:https?:\/\/|mailto:)/iu.test(href) ? href : null
}

/**
 * 编辑器里点到链接。带账号密码的地址要拦住浏览器，并且不交给宿主打开。
 * 属性里的原文和浏览器解析后的地址都看，避免一边被剥掉账号后另一边又打开。
 */
export function resolveEditorLinkClick(attribute: string, property: string): { preventDefault: boolean; open: string | null } {
  const candidates = [attribute, property].filter(value => value.length > 0)
  if (candidates.some(httpHrefHasCredentials)) return { preventDefault: true, open: null }
  const open = candidates.map(value => openableLinkHref(value)).find((value): value is string => Boolean(value)) ?? null
  if (!open && !candidates.some(value => /^(?:https?:|mailto:)/iu.test(value))) return { preventDefault: false, open: null }
  return { preventDefault: true, open }
}

/**
 * 访客 iframe 里链接上的 click 和 auxclick。主键 click（包括键盘 Enter 触发的 click）和中键 auxclick 由 Jot 打开一次。
 * 别的按键的 click 不处理，免得给中键补发 click 的浏览器再开一次。右键交给浏览器。
 */
export function editorLinkEventAction(event: { type: string; button: number }, attribute: string, property: string): { preventDefault: boolean; open: string | null } {
  const primary = event.type === 'click' && event.button === 0
  const middle = event.type === 'auxclick' && event.button === 1
  if (!primary && !middle) return { preventDefault: false, open: null }
  return resolveEditorLinkClick(attribute, property)
}

/** 导出时去掉 http(s) 里的账号密码。解析不了就不要把原文写进文件。其它地址原样保留。 */
export function exportableLinkHref(href: string): string | null {
  if (!href) return null
  if (!httpHrefHasCredentials(href)) return href
  try {
    const url = new URL(href)
    url.username = ''
    url.password = ''
    return url.username === '' && url.password === '' ? url.href : null
  } catch {
    return null
  }
}
