/**
 * ⚠ 同构移植（回搬件）——检索切分视界源自 dsh-session-steward
 *   `src/host/index/extract.ts:62-95`（SEGMENTER/segmentForIndex/segmentQueryTerm）
 *   与 `src/host/index/engine.ts:83-95`（sanitizeFtsQuery），回搬时点 2026-10-19。
 *   回搬纪律：**逐字同构，禁止分叉**；索引侧与查询侧必须共用本文件的同一
 *   切分函数（spec 决策「CJK 分词=DRS 自带 Intl.Segmenter 切分」）。
 *   唯一非授权差异：导出面去掉 steward 内部类型耦合（行为零差异）。
 */

/**
 * ICU word segmenter shared by index and query paths (Node >= 16 / all evergreen
 * browsers, zero dependency). 'zh' sensitivity keeps CJK word granularity.
 */
const SEGMENTER = typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function'
  ? new Intl.Segmenter('zh', { granularity: 'word' })
  : undefined

/**
 * Space-separate word boundaries so the FTS5 unicode61 tokenizer indexes
 * words instead of whole CJK runs: the index and query sides must apply the
 * exact same segmentation for a token to meet its match.
 * @param text - raw extracted text (or a query term).
 * @returns text with a single space at every word boundary.
 */
export function segmentForIndex(text: string): string {
  if (SEGMENTER === undefined) return text
  const parts: string[] = []
  for (const { segment } of SEGMENTER.segment(text)) {
    const piece = segment.trim()
    if (piece !== '') parts.push(piece)
  }
  return parts.join(' ')
}

/**
 * Segment one whitespace-delimited query term into FTS5 phrase tokens.
 * @returns word-like segments, or the raw term when segmentation is unavailable.
 */
export function segmentQueryTerm(term: string): string[] {
  if (SEGMENTER === undefined) return [term]
  const words: string[] = []
  for (const { segment, isWordLike } of SEGMENTER.segment(term)) {
    const piece = segment.trim()
    if (piece !== '' && isWordLike === true) words.push(piece)
  }
  return words.length > 0 ? words : [term]
}

/**
 * Sanitize free text into a safe FTS5 query over the segmented index: each
 * whitespace term is segmented into word tokens, quoted as an adjacent
 * phrase, and the last token carries a prefix `*` so partial input matches
 * ("正在搜" hits 正在搜索). Terms AND together.
 */
export function sanitizeFtsQuery(query: string): string {
  const terms = query.split(/\s+/u).filter(Boolean)
  if (terms.length === 0) return ''
  const phrases: string[] = []
  for (const term of terms) {
    const words = segmentQueryTerm(term)
      .map(word => word.replace(/"/g, '""'))
      .filter(word => word !== '')
    if (words.length === 0) continue
    phrases.push(`"${words.join(' ')}"*`)
  }
  return phrases.join(' ')
}
