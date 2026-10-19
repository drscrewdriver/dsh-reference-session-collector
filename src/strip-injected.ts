/**
 * 宿主注入样板段剥离（检索视界专用，2026-10-20 真机取证定标）。
 *
 * 背景：user/message 原文头部含宿主注入的成对标记段（记忆召回/人格/工具指南/
 * 场景导航/系统提醒/技能指令）。真机统计（46 会话/3100 条用户消息）：1210 条
 * （39%）含注入段，标记全集七类——这些段落随原文进了 search_text 后成为检索
 * 污染主因：关键词命中在用户没写过的注入样板里，节选与正文对不上。
 *
 * 纪律：**只作用于 search_text（检索面），绝不作用于 text/tokens**——后者是
 * CCI verify 同口径视界（savings-verify 对 message.content 全文计数），
 * 剥离会破坏对账数学（spec R5）。
 * 只剥**完整成对**标记段；未闭合（撕裂尾行）原样保留，不伪造丢失。
 */

/** 注入标记全集（真机 tagscan 实测，按出现频降序）。 */
export const INJECTED_BLOCK_TAGS: readonly string[] = [
  'relevant-memories',
  'user-persona',
  'memory-tools-guide',
  'scene-navigation',
  'system-reminder',
  'skill_instructions',
  'skill_resources',
]

// 单个 alternation 正则 + 反向引用配对：开闭同名才剥，避免被段内任意
// 闭合标记（markdown/其它 XML 样文本）提前截断；未闭合则整体不匹配。
const INJECTED_BLOCK_RE = new RegExp(
  `<(${INJECTED_BLOCK_TAGS.join('|')})>[\\s\\S]*?<\\/\\1>`,
  'giu',
)

/**
 * 剥离一段文本里的全部注入样板块。
 * @param text - 原始检索文本（任意事件视界产出均可过）。
 * @returns 剥离并重整空白后的文本；无注入块时与原串仅可能差在首尾空白。
 */
export function stripInjectedBlocks(text: string): string {
  if (text === '' || text.indexOf('<') < 0) return text
  const stripped = text.replace(INJECTED_BLOCK_RE, '')
  // 只剩空白 → 空串（该行进/不落 segments 由投影侧既有规则决定）。
  if (stripped.trim() === '') return ''
  // 折叠剥离产生的连续空行（≥3 换行 → 2），并去首尾空白——与 joinText 的
  // trim 纪律一致。
  return stripped.replace(/\n{3,}/gu, '\n\n').trim()
}
