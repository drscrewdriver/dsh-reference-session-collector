/**
 * 注入剥离叶子断言：成对剥离/开闭异名不剥/未闭合保留/纯注入→空串/
 * 空白折叠/非注入标记不动。
 */
import { describe, expect, it } from 'vitest'
import { INJECTED_BLOCK_TAGS, stripInjectedBlocks } from '../src/strip-injected.ts'

describe('stripInjectedBlocks', () => {
  it('剥完整成对注入段，保留用户真实问题', () => {
    const text = '<relevant-memories>\n以下是当前对话召回的相关记忆：\n- [work] 某记忆\n</relevant-memories>\n我的问题是：DRS 装机怎么弄'
    const out = stripInjectedBlocks(text)
    expect(out).toBe('我的问题是：DRS 装机怎么弄')
    expect(out).not.toContain('relevant-memories')
  })

  it('多个注入段同现全部剥离（persona+guide+reminder 样张）', () => {
    const text = [
      '<user-persona>人格文本</user-persona>',
      '<memory-tools-guide>指南</memory-tools-guide>',
      '<system-reminder>提醒 第一行\n提醒 第二行</system-reminder>',
      '真正的用户输入',
    ].join('\n')
    expect(stripInjectedBlocks(text)).toBe('真正的用户输入')
  })

  it('开闭异名不剥（反向引用配对）；未闭合整段保留', () => {
    const mismatched = '<system-reminder>内容</relevant-memories>尾部'
    // 开标记与闭标记异名 → 不构成注入段，原样保留（宁可留噪声，不吞正文）。
    expect(stripInjectedBlocks(mismatched)).toBe(mismatched)
    const unterminated = '<scene-navigation>没有闭合标签的尾巴'
    expect(stripInjectedBlocks(unterminated)).toBe(unterminated)
  })

  it('非注入白名单的标记不动（</b>、<attached_files> 等）', () => {
    const text = '正文 <attached_files>some diff</attached_files> 与 </b> 标签'
    expect(stripInjectedBlocks(text)).toBe(text)
  })

  it('纯注入消息剥后为空串；多段落剥离产生的连换行被重整', () => {
    expect(stripInjectedBlocks('<skill_instructions>只此一段注入</skill_instructions>')).toBe('')
    const spaced = '<scene-navigation>a</scene-navigation>\n\n\n\n正文'
    const out = stripInjectedBlocks(spaced)
    expect(out).toBe('正文')
  })

  it('标记全集恰为真机取证七类', () => {
    expect(INJECTED_BLOCK_TAGS).toEqual([
      'relevant-memories', 'user-persona', 'memory-tools-guide',
      'scene-navigation', 'system-reminder', 'skill_instructions', 'skill_resources',
    ])
  })
})
