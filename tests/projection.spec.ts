/**
 * T2.3 纯投影核心断言：压缩对 gross 数学、recall 分类、compressed/replaced_by
 * 指针（含链解析）、双形状容错、空文本过滤、chars/4 降级、turn/step 滚动、
 * time 落事件 epoch ms、search_text 检索视界（tool/call 参数、todo/write、
 * turn/end 错误原因）、on_surface 与 steward classifySurface 同视界。
 */
import { describe, expect, it } from 'vitest'
import { projectSessionEvents } from '../src/projection.ts'
import type { DecodedEvent } from '../src/session-file-decode.ts'

const LONG_TEXT = 'hello world this is a long text' // 31 chars → chars/4 = 8
const LONG_TOKENS = Math.ceil(LONG_TEXT.length / 4)

function makeEvents(): DecodedEvent[] {
  return [
    { type: 'step/start', seq: 0, time: 1000, data: { turn: 1, step: 1 } },
    { type: 'user/message', seq: 1, time: 1001, data: { content: [{ type: 'text', text: '原始问题' }] } },
    { type: 'assistant/message', seq: 2, time: 1002, data: { message: { content: [{ type: 'text', text: LONG_TEXT }] } } },
    { type: 'tool/call', seq: 3, time: 1003, data: { name: 'search', arguments: '{"q":"笔记"}' } },
    // 压缩对：seq4 替 seq2（startSeq/endSeq 形状，CCI 写入侧）。b=1 ≤ a=8。
    {
      type: 'assistant/message', seq: 4, time: 1004,
      data: { message: { content: [{ type: 'text', text: 'B' }] } },
      surfaceOp: { op: 'replace', startSeq: 2, endSeq: 2 } as unknown as { op: 'replace'; start: number; end: number },
    },
    // 召回对：seq5 扩写替 seq4（start/end 形状，叶子接口注释）。b=8 > a=1。
    {
      type: 'assistant/message', seq: 5, time: 1005,
      data: { message: { content: [{ type: 'text', text: LONG_TEXT }] } },
      surfaceOp: { op: 'replace', start: 4, end: 4 },
    },
    { type: 'assistant/chunk', seq: 6, time: 1006, data: { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: '' } } },
    { type: 'todo/write', seq: 7, time: 1007, data: { todos: [{ status: 'pending', content: '写报告' }] } },
    { type: 'turn/end', seq: 8, time: 1008, data: { reason: { kind: 'error', error: { message: '超时' } } } },
    { type: 'step/start', seq: 9, time: 1009, data: { turn: 2, step: 3 } },
    { type: 'assistant/message', seq: 10, time: 1010, data: { message: { content: [{ type: 'text', text: 'later turn' }] } } },
    { type: 'session/title', seq: 11, time: 1011, data: { title: '投影测试会话' } },
  ]
}

describe('projectSessionEvents', () => {
  const projection = projectSessionEvents(makeEvents(), { dirId: 'dir-1', sessionId: 'sess-1' })

  it('压缩对/召回对数学与分类', () => {
    const { summary, replaces } = projection
    expect(replaces).toHaveLength(2)
    const compress = replaces.find(r => r.kind === 'compress')
    const recall = replaces.find(r => r.kind === 'recall')
    expect(compress).toBeDefined()
    expect(recall).toBeDefined()
    expect(compress?.startSeq).toBe(2)
    expect(compress?.endSeq).toBe(2)
    expect(compress?.aTokens).toBe(LONG_TOKENS)
    expect(compress?.bTokens).toBe(1)
    // 双形状容错：seq5 用 start/end，仍成对且区间指针正确
    expect(recall?.startSeq).toBe(4)
    expect(recall?.endSeq).toBe(4)
    expect(recall?.bTokens).toBe(LONG_TOKENS)
    expect(summary.grossSaved).toBe(LONG_TOKENS - 1)
    expect(summary.recallTokens).toBe(LONG_TOKENS)
    expect(summary.compressPairs).toBe(1)
    expect(summary.recallPairs).toBe(1)
  })

  it('compressed/replaced_by 指针与链解析（当前表面=终替）', () => {
    const bySeq = new Map(projection.segments.map(s => [s.seq, s]))
    const row2 = bySeq.get(2)
    const row4 = bySeq.get(4)
    const row5 = bySeq.get(5)
    expect(row2?.compressed).toBe(1)
    expect(row2?.onSurface).toBe(0)
    // seq2 直接指针=seq4，但 seq4 本身又被 seq5 覆盖 → 链解析到终替 5
    expect(row2?.replacedBy).toBe(5)
    expect(row2?.surfaceText).toBe(LONG_TEXT)
    expect(row2?.surfaceTokens).toBe(LONG_TOKENS)
    expect(row4?.compressed).toBe(1)
    expect(row4?.replacedBy).toBe(5)
    expect(row5?.onSurface).toBe(1) // replace 自身（终替）在面上
    expect(row5?.compressed).toBe(0)
  })

  it('on_surface 与 steward classifySurface 同视界：被覆盖区间=0', () => {
    for (const seq of [2, 4]) {
      expect(projection.segments.find(s => s.seq === seq)?.onSurface).toBe(0)
    }
    expect(projection.segments.find(s => s.seq === 1)?.onSurface).toBe(1)
    expect(projection.segments.find(s => s.seq === 10)?.onSurface).toBe(1)
  })

  it('空文本过滤：chunk 空行不落 segments', () => {
    expect(projection.segments.find(s => s.seq === 6)).toBeUndefined()
  })

  it('search_text 检索视界=steward 超集（tool/call 参数、todo/write、turn/end 错误原因）', () => {
    const bySeq = new Map(projection.segments.map(s => [s.seq, s]))
    expect(bySeq.get(3)?.searchText).toBe('search\n{"q":"笔记"}')
    expect(bySeq.get(7)?.searchText).toBe('pending\n写报告')
    expect(bySeq.get(8)?.searchText).toBe('error\n超时')
    expect(bySeq.get(1)?.searchText).toBe('原始问题')
    // user/message 无 data.message → CCI 视界 text 为空但检索面收录
    expect(bySeq.get(1)?.text).toBe('')
  })

  it('time 落事件 epoch ms；last_time_ms=事件最大 time', () => {
    expect(projection.segments.find(s => s.seq === 3)?.time).toBe(1003)
    expect(projection.summary.lastTimeMs).toBe(1011)
  })

  it('turn/step 从 step/start 滚动', () => {
    const bySeq = new Map(projection.segments.map(s => [s.seq, s]))
    expect(bySeq.get(3)?.turn).toBe(1)
    expect(bySeq.get(3)?.step).toBe(1)
    expect(bySeq.get(10)?.turn).toBe(2)
    expect(bySeq.get(10)?.step).toBe(3)
    expect(projection.summary.turnCount).toBe(2)
  })

  it('chars/4 降级标注；精确计数器切换 basis', () => {
    expect(projection.summary.basis).toBe('chars/4')
    const exact = projectSessionEvents(makeEvents(), {
      dirId: 'dir-1', sessionId: 'sess-1', exactCounter: text => text.length,
    })
    expect(exact.summary.basis).toBe('ds-token')
    const compress = exact.replaces.find(r => r.kind === 'compress')
    expect(compress?.aTokens).toBe(LONG_TEXT.length)
  })

  it('title 从 session/title 事件抽出；role 归属', () => {
    expect(projection.summary.title).toBe('投影测试会话')
    const bySeq = new Map(projection.segments.map(s => [s.seq, s]))
    expect(bySeq.get(1)?.role).toBe('user')
    expect(bySeq.get(2)?.role).toBe('assistant')
    expect(bySeq.get(3)?.role).toBe('')
    expect(bySeq.get(3)?.kind).toBe('tool/call')
  })

  it('缺省 sessionId=dirId', () => {
    const p = projectSessionEvents([], { dirId: 'only-dir' })
    expect(p.summary.sessionId).toBe('only-dir')
  })
})
