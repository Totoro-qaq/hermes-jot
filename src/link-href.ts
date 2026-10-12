const MAX_HREF = 2_048
const STORED_SCHEME = /^(?:https?:\/\/|mailto:|tel:|#)/iu
const WEB_OR_MAIL = /^(?:https?:|mailto:)/iu
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

function storable(href: string): string | null {
  return href.length <= MAX_HREF && !WHITESPACE.test(href) && !httpHrefHasCredentials(href) ? href : null
}

/** 把用户输入收成存储层接受的 href。保留用户原文，不用 URL.href 改写。 */
export function normalizeLinkHref(raw: string): string | null {
  const trimmed = raw.trim()
  if (!trimmed || trimmed.length > MAX_HREF) return null
  if (STORED_SCHEME.test(trimmed)) return storable(trimmed)
  if (EMAIL.test(trimmed)) return storable(`mailto:${trimmed}`)
  return phoneHref(trimmed) ?? (DOMAIN.test(trimmed) ? storable(`https://${trimmed}`) : null)
}

function phoneHref(value: string): string | null {
  const compact = value.replace(/[\u0000-\u0020]+/gu, '')
  if (!/^\+?[\d().-]{5,}$/u.test(compact)) return null
  const digits = compact.replace(/\D/gu, '').length
  return digits >= 5 && digits <= 15 ? storable(`tel:${compact}`) : null
}

/** 只有网页和邮箱可以在宿主里打开；带账号密码的地址、电话和页内锚点都不打开。 */
export function openableLinkHref(raw: string): string | null {
  const href = normalizeLinkHref(raw)
  return href && WEB_OR_MAIL.test(href) ? href : null
}

/**
 * 访客 iframe 里链接上的 click 和 auxclick。主键 click（包括键盘 Enter 触发的 click）和中键 auxclick 由 Jot 打开一次。
 * 别的按键不处理：中键补发的 click 不再开一次，右键交给浏览器。网页和邮箱地址一律拦住浏览器，带账号密码的不打开。
 */
export function editorLinkEventAction(event: { type: string; button: number }, href: string): { preventDefault: boolean; open: string | null } {
  const primary = event.type === 'click' && event.button === 0
  const middle = event.type === 'auxclick' && event.button === 1
  if ((!primary && !middle) || !WEB_OR_MAIL.test(href)) return { preventDefault: false, open: null }
  return { preventDefault: true, open: openableLinkHref(href) }
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
