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
