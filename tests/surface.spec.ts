/**
 * T4.2 查询面断言:种子库 → 六查询形状/数学断言 + LRU 命中计数 +
 * 重同步后代际失效 + turn 过滤 + 中文查询命中 index_text;
 * v5 读侧(task_13):hash→blocks 还原的 v4 逐字段回归、redact=1 双态、
 * surface 两跳派生对拍、tail=N 尾窗。
 *
 * 种子纪律:手工构造 SessionProjection 走 schema.replaceSession 真身落库,
 * **不依赖 projection.ts 的实现**——surface(L2)对投影核心(L3)只认库形状;
 * 压缩/召回标记、on_surface、search_text 全部由种子显式给定,断言面清晰。
 * route.spec 已在 HTTP 层盖过 op 形状,本文件打模块函数级:数学、缓存、失效。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openProjectionStore, type ProjectionStore } from '../src/schema.ts'
import type { ProjectionSegment, ProjectionReplace, SessionProjection, SessionSummary } from '../src/projection.ts'
import {
  createQueryContext,
  listSessions,
  recallReport,
  search,
  searchGrouped,
  buildSearchSnippet,
  sessionDetail,
  status,
  surfaceLedger,
  type QueryContext,
} from '../src/surface.ts'

function segment(over: Partial<ProjectionSegment> & Pick<ProjectionSegment, 'seq' | 'kind'>): ProjectionSegment {
  return {
    turn: 1,
    step: 1,
    role: '',
    time: 1000,
    text: '',
    tokens: 0,
    searchText: '',
    onSurface: 1,
    compressed: 0,
    surfaceText: null,
    surfaceTokens: null,
    replacedBy: null,
    ...over,
  }
}

function replace(over: Partial<ProjectionReplace> & Pick<ProjectionReplace, 'seq' | 'kind'>): ProjectionReplace {
  return { startSeq: over.seq ?? 0, endSeq: over.seq ?? 0, aTokens: 0, bTokens: 0, turn: 1, step: 1, live: 1, ...over }
}

function summary(over: Partial<SessionSummary> & Pick<SessionSummary, 'sessionId' | 'dirId'>): SessionSummary {
  return {
    title: '',
    cwd: '',
    eventCount: 1,
    maxSeq: 1,
    turnCount: 1,
    segmentTokens: 0,
    surfaceTokens: 0,
    grossSaved: 0,
    recallTokens: 0,
    compressPairs: 0,
    recallPairs: 0,
    basis: 'chars/4',
    lastTimeMs: 1000,
    formatGeneration: 4,
    ...over,
  }
}

/** s1:一条压缩对(seq2→5)+ 一条召回对(seq3→6)+ 中文/英文混合检索面。 */
function projectionS1(): SessionProjection {
  return {
    summary: summary({
      sessionId: 's1',
      dirId: 'd1',
      title: '投影同步器演示',
      eventCount: 6,
      maxSeq: 6,
      turnCount: 2,
      segmentTokens: 114,
      surfaceTokens: 100,
      grossSaved: 2,
      recallTokens: 85,
      compressPairs: 1,
      recallPairs: 1,
      basis: 'ds-token',
      lastTimeMs: 1005,
    }),
    segments: [
      segment({ seq: 1, kind: 'user/message', role: 'user', time: 1001, text: '在会话里查投影同步器怎么用', tokens: 12, searchText: '在会话里查投影同步器怎么用' }),
      segment({ seq: 2, kind: 'tool/result', role: 'tool', time: 1002, text: 'PROJECTION NUMBERS OUTPUT TABLE', tokens: 5, searchText: 'PROJECTION NUMBERS OUTPUT TABLE', onSurface: 0, compressed: 1, surfaceText: 'numbers: 42', surfaceTokens: 3, replacedBy: 5 }),
      segment({ seq: 3, kind: 'assistant/message', role: 'assistant', turn: 2, time: 1003, text: '投影同步器的回答正文', tokens: 9, searchText: '投影同步器的回答正文', onSurface: 0, compressed: 1, surfaceText: '召回扩写后的全文回读', surfaceTokens: 85, replacedBy: 6 }),
      segment({ seq: 5, kind: 'system/op', time: 1004, text: 'numbers: 42', tokens: 3 }),
      segment({ seq: 6, kind: 'system/op', turn: 2, time: 1005, text: '召回扩写后的全文回读', tokens: 85 }),
    ],
    replaces: [
      replace({ seq: 5, startSeq: 2, endSeq: 2, aTokens: 5, bTokens: 3, kind: 'compress', turn: 1, step: 2 }),
      replace({ seq: 6, startSeq: 3, endSeq: 3, aTokens: 9, bTokens: 85, kind: 'recall', turn: 2, step: 1 }),
    ],
  }
}

/** s2:极小会话,更旧 last_time(listSessions 排序锚)。 */
function projectionS2(): SessionProjection {
  return {
    summary: summary({ sessionId: 's2', dirId: 'd2', lastTimeMs: 100 }),
    segments: [
      segment({ seq: 1, kind: 'user/message', role: 'user', time: 100, text: '另一个会话提到投影但是没有同步器细节', tokens: 10, searchText: '另一个会话提到投影但是没有同步器细节' }),
    ],
    replaces: [],
  }
}

let dir = ''
let store: ProjectionStore
let ctx: QueryContext

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'drs-surface-'))
  store = openProjectionStore(dir)
  store.replaceSession(projectionS1(), 111, 1000)
  store.replaceSession(projectionS2(), 222, 500)
  ctx = createQueryContext(store)
})

afterAll(() => {
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

const tick = (ms: number): Promise<void> => new Promise(resolve => { setTimeout(resolve, ms) })

function seqs(rows: unknown[], key = 'seq'): number[] {
  return rows.map(row => Number((row as Record<string, unknown>)[key]))
}

describe('status / listSessions(缓存层 2)', () => {
  it('status:四计数 + schema 版本 + 缓存面形状', () => {
    const report = status(ctx) as Record<string, unknown>
    expect(report['ok']).toBe(true)
    expect(report['sessions']).toBe(2)
    expect(report['segments']).toBe(6)
    expect(report['replaces']).toBe(2)
    expect(report['schema_version']).toBe('5')
    const cache = report['cache'] as Record<string, unknown>
    expect(cache['summaries']).toBe(2)
    expect(cache['surface_ledger']).toHaveProperty('hits')
  })

  it('listSessions:常驻 Map 按 last_time 降序,分页不动 total', () => {
    const page = listSessions(ctx)
    expect(page.total).toBe(2)
    expect(page.rows.map(row => row.session_id)).toEqual(['s1', 's2'])
    const shifted = listSessions(ctx, 1, 1)
    expect(shifted.total).toBe(2)
    expect(shifted.rows.map(row => row.session_id)).toEqual(['s2'])
  })
})

describe('sessionDetail(turn 过滤 / fields=search)', () => {
  it('默认全段行(SELECT * 形状,seq 升序)', () => {
    const detail = sessionDetail(ctx, 's1')
    expect(detail?.session?.title).toBe('投影同步器演示')
    expect(seqs(detail?.rows ?? [])).toEqual([1, 2, 3, 5, 6])
    const first = (detail?.rows ?? [])[0] as Record<string, unknown>
    expect(first).toHaveProperty('search_text')
  })

  it('turn= 单值与闭区间;非法串按无过滤处理(不抛)', () => {
    expect(seqs(sessionDetail(ctx, 's1', { turn: '1' })?.rows ?? [])).toEqual([1, 2, 5])
    expect(seqs(sessionDetail(ctx, 's1', { turn: '2' })?.rows ?? [])).toEqual([3, 6])
    expect(seqs(sessionDetail(ctx, 's1', { turn: '2-2' })?.rows ?? [])).toEqual([3, 6])
    expect(seqs(sessionDetail(ctx, 's1', { turn: '1-2' })?.rows ?? [])).toEqual([1, 2, 3, 5, 6])
    expect(seqs(sessionDetail(ctx, 's1', { turn: 'abc' })?.rows ?? [])).toEqual([1, 2, 3, 5, 6])
  })

  it('fields=search 返回检索臂行(time/search_text/on_surface)', () => {
    const detail = sessionDetail(ctx, 's1', { fields: 'search' })
    const rows = detail?.rows as Record<string, unknown>[]
    expect(rows).toHaveLength(5)
    const bySeq = new Map(rows.map(row => [Number(row['seq']), row]))
    expect(bySeq.get(2)?.['on_surface']).toBe(0)
    expect(bySeq.get(2)?.['search_text']).toBe('PROJECTION NUMBERS OUTPUT TABLE')
    expect(bySeq.get(1)?.['time']).toBe(1001)
    expect(bySeq.get(1)).not.toHaveProperty('text')
  })

  it('未知会话:session undefined + 空行', () => {
    const detail = sessionDetail(ctx, 'nope')
    expect(detail?.session).toBeUndefined()
    expect(detail?.rows).toEqual([])
  })
})

describe('surfaceLedger(R3 台账 + 缓存层 3)', () => {
  it('表面行与被替换指针视图;LRU 二次命中', () => {
    const first = surfaceLedger(ctx, 's1')
    expect(seqs(first['on_surface'] as unknown[])).toEqual([1, 5, 6])
    const pointers = first['compressed_pointers'] as Record<string, unknown>[]
    expect(seqs(pointers)).toEqual([2, 3])
    expect(pointers[0]?.['replaced_by']).toBe(5)
    expect(pointers[0]?.['surface_tokens']).toBe(3)
    // v5 两跳派生对拍:还原值 == v4 直存的种子 surfaceText
    expect(pointers[0]?.['surface_text']).toBe('numbers: 42')
    expect(pointers[1]?.['replaced_by']).toBe(6)
    expect(pointers[1]?.['surface_tokens']).toBe(85)
    expect(pointers[1]?.['surface_text']).toBe('召回扩写后的全文回读')

    const statsAfterFirst = ctx.surfaceLru.stats()
    expect(statsAfterFirst.misses).toBe(1)
    const second = surfaceLedger(ctx, 's1')
    expect(second).toBe(first)
    expect(ctx.surfaceLru.stats()).toEqual({ entries: 1, hits: 1, misses: 1 })
  })
})

describe('recallReport(R4 对账 + 缓存层 3)', () => {
  it('gross=Σ(a−b)、recall=Σb,分类计数与口径 basis 直读', () => {
    const first = recallReport(ctx, 's1')
    expect(first['gross_saved']).toBe(2)
    expect(first['recall_tokens']).toBe(85)
    expect(first['compress_pairs']).toBe(1)
    expect(first['recall_pairs']).toBe(1)
    expect(first['basis']).toBe('ds-token')
    const pairs = first['pairs'] as Record<string, unknown>[]
    expect(seqs(pairs)).toEqual([5, 6])
    expect(seqs(pairs, 'start_seq')).toEqual([2, 3])
    expect(seqs(pairs, 'end_seq')).toEqual([2, 3])

    expect(ctx.recallLru.stats().misses).toBe(1)
    expect(recallReport(ctx, 's1')).toBe(first)
    expect(ctx.recallLru.stats().hits).toBe(1)
  })
})

describe('重同步后代际失效', () => {
  it('replaceSession 换 synced_at → LRU 未命中并反映新内容', async () => {
    surfaceLedger(ctx, 's1')
    recallReport(ctx, 's1')
    const before = { surface: ctx.surfaceLru.stats(), recall: ctx.recallLru.stats() }
    expect(before.surface.hits).toBeGreaterThanOrEqual(1)

    // 重同步:seq2 的压缩标记摘除(模拟内容变化),等 5ms 保证 ISO 毫秒代际前进
    await tick(5)
    const next = projectionS1()
    const seq2 = next.segments.find(seg => seg.seq === 2)
    if (seq2 !== undefined) {
      seq2.compressed = 0
      seq2.onSurface = 1
      seq2.surfaceText = null
      seq2.surfaceTokens = null
      seq2.replacedBy = null
    }
    next.replaces = next.replaces.filter(pair => pair.seq !== 5)
    next.summary.compressPairs = 0
    next.summary.grossSaved = 0
    store.replaceSession(next, 111, 2000)

    const ledger = surfaceLedger(ctx, 's1')
    expect(seqs(ledger['compressed_pointers'] as unknown[])).toEqual([3])
    const after = ctx.surfaceLru.stats()
    expect(after.misses).toBe(before.surface.misses + 1)

    const recall = recallReport(ctx, 's1')
    expect(recall['gross_saved']).toBe(0)
    expect(recall['compress_pairs']).toBe(0)
    expect(ctx.recallLru.stats().misses).toBe(before.recall.misses + 1)
  })
})

describe('search(中英同构切词)', () => {
  it('中文词命中 index_text(索引/查询同一把刀)', () => {
    const report = search(ctx, '投影')
    expect(report.match).toBe('"投影"*')
    const hitKeys = report.hits.map(hit => `${hit['session_id']}#${hit['seq']}`)
    expect(hitKeys).toContain('s1#1')
    expect(hitKeys).toContain('s1#3')
    expect(hitKeys).toContain('s2#1')
    expect(hitKeys).not.toContain('s1#2')
  })

  it('切词短语:投影同步器 命中相邻词位,松散出现不命中', () => {
    const report = search(ctx, '投影同步器')
    const hitKeys = report.hits.map(hit => `${hit['session_id']}#${hit['seq']}`)
    expect(hitKeys).toContain('s1#1')
    expect(hitKeys).toContain('s1#3')
    expect(hitKeys).not.toContain('s2#1')
  })

  it('session 过滤与英文词命中', () => {
    const scoped = search(ctx, '投影', { session: 's2' })
    expect(scoped.hits).toHaveLength(1)
    expect(scoped.hits[0]?.['session_id']).toBe('s2')
    const english = search(ctx, 'PROJECTION NUMBERS')
    expect(english.hits.map(hit => `${hit['session_id']}#${hit['seq']}`)).toEqual(['s1#2'])
  })

  it('空查询:不执行 MATCH,返回空命中', () => {
    const report = search(ctx, '   ')
    expect(report.match).toBe('')
    expect(report.hits).toEqual([])
  })
})

describe('searchGrouped(分组臂：steward 检索语义直译)', () => {
  // 库态（重同步改写后）：s1{seq1 user/on1, seq2 tool-result/on1, seq3 assistant/on0,
  // seq5, seq6 system} + s2{seq1 user/on1}；sessions.last_time s1=1005、s2=100。
  it('缺省 kinds=user+assistant 且仅表面：会话分组各取最强命中', () => {
    const report = searchGrouped(ctx, { query: '投影' })
    const keys = report.hits.map(hit => `${hit.session_id}#${hit.seq}`)
    // s1#3 已 shadowed（on_surface=0）不入候选；s1 取 seq1，s2 取 seq1
    expect(keys).toEqual(expect.arrayContaining(['s1#1', 's2#1']))
    expect(keys).not.toContain('s1#3')
    // 标题/时间面携回（steward 命中行 join s.title 同形）
    expect(report.hits.find(hit => hit.session_id === 's1')?.title).toBe('投影同步器演示')
  })

  it('kinds 展开面：英文词只在 tool/result 时，默认 kinds 零命中、显式 kinds 可中', () => {
    expect(searchGrouped(ctx, { query: 'PROJECTION' }).hits).toEqual([])
    const widened = searchGrouped(ctx, { query: 'PROJECTION', kinds: ['user/message', 'assistant/message', 'tool/result'] })
    const keys = widened.hits.map(hit => `${hit.session_id}#${hit.seq}`)
    expect(keys).toEqual(['s1#2'])
    expect(widened.hits[0]?.type).toBe('tool/result')
  })

  it('archived 域切换：s2 归档后 active 臂不含、archived 臂独有', () => {
    store.setArchived('s2', 1)
    try {
      expect(searchGrouped(ctx, { query: '投影', archived: 'active' }).hits.map(h => h.session_id)).toEqual(['s1'])
      const only = searchGrouped(ctx, { query: '投影', archived: 'archived' }).hits
      expect(only.map(h => h.session_id)).toEqual(['s2'])
      expect(searchGrouped(ctx, { query: '投影', archived: 'all' }).hits).toHaveLength(2)
    } finally {
      store.setArchived('s2', 0)
    }
  })

  it('日期半开区间 [from,to) 键在会话末时间：s2(100) 被 [1000,2000) 排除', () => {
    const ids = searchGrouped(ctx, { query: '投影', from: 1000, to: 2000 }).hits.map(h => h.session_id)
    expect(ids).toEqual(['s1'])
  })

  it('sortBy=time 键在 updated_at 降序（非命中 time）', () => {
    const ids = searchGrouped(ctx, { query: '投影', sortBy: 'time' }).hits.map(h => h.session_id)
    expect(ids).toEqual(['s1', 's2'])
  })

  it('surface=0 放开阴影行：命中集可能变宽且不抛', () => {
    const open = searchGrouped(ctx, { query: '投影', surfaceOnly: false, kinds: ['user/message', 'assistant/message'] })
    expect(open.hits.length).toBeGreaterThanOrEqual(1)
  })
})

describe('buildSearchSnippet(锚定节选)', () => {
  it('短文本直返 flatten 全文', () => {
    expect(buildSearchSnippet('一段  很\n短的文本', '短')).toBe('一段 很 短的文本'.replace(/\s+/g, ' '))
  })

  it('长文本窗口居查询词首现处，前后加省略号且限长 240', () => {
    const filler = 'x'.repeat(300)
    const text = `${filler} 关键词正文 ${filler}`
    const out = buildSearchSnippet(text, '关键词正文')
    expect(out.length).toBeLessThanOrEqual(240)
    expect(out).toContain('关键词正文')
    expect(out.startsWith('…')).toBe(true)
    expect(out.endsWith('…')).toBe(true)
  })

  it('无锚点退化为头部 240+省略号（steward 同形：slice(0,max) 后再加 …）', () => {
    const text = 'y'.repeat(400)
    const out = buildSearchSnippet(text, '查不到的词')
    expect(out).toBe(`${'y'.repeat(240)}…`)
  })
})

describe('v5 读侧（redact=1 双态 / tail 尾窗 / v4 逐字段回归 / 多跳链派生）', () => {
  let v5dir = ''
  let v5store: ProjectionStore
  let v5ctx: QueryContext
  const SECRET = 'sk-abcdefghijklmnop1234567890'

  beforeAll(() => {
    v5dir = mkdtempSync(join(tmpdir(), 'drs-v5face-'))
    v5store = openProjectionStore(v5dir)
    // 多跳链种子：2→4→5 在投影期已收敛——行面 replacedBy 直指终替 5，
    // 读侧两跳还原结果必须等于 v4 直存的 surfaceText。
    v5store.replaceSession({
      summary: summary({ sessionId: 's9', dirId: 'd9' }),
      segments: [
        segment({ seq: 1, kind: 'user/message', role: 'user', time: 2001, text: `轮换令牌 ${SECRET} 请核对`, tokens: 5, searchText: `轮换令牌 ${SECRET} 请核对` }),
        segment({ seq: 2, kind: 'tool/result', time: 2002, text: 'OUT BIG PAYLOAD 原文正文', tokens: 9, searchText: 'OUT BIG PAYLOAD 原文正文', onSurface: 0, compressed: 1, surfaceText: '收敛后的尾正文', surfaceTokens: 4, replacedBy: 5 }),
        segment({ seq: 4, kind: 'system/op', time: 2003, text: '中段正文', tokens: 2, searchText: '中段正文', onSurface: 0, compressed: 1, surfaceText: '收敛后的尾正文', surfaceTokens: 4, replacedBy: 5 }),
        segment({ seq: 5, kind: 'system/op', time: 2004, text: '收敛后的尾正文', tokens: 4, searchText: '收敛后的尾正文' }),
      ],
      replaces: [replace({ seq: 5, startSeq: 2, endSeq: 4, aTokens: 11, bTokens: 4, kind: 'compress' })],
    }, 33, 3000)
    // 撞键防御种子：s10 用同 seq 空间(2→5)但链头正文不同——两跳 JOIN 若漏
    // session_id 条件就会串块（findings 风险①的读侧盖）。
    v5store.replaceSession({
      summary: summary({ sessionId: 's10', dirId: 'd10' }),
      segments: [
        segment({ seq: 2, kind: 'tool/result', time: 2102, text: 's10 中段载荷', tokens: 3, searchText: 's10 中段载荷', onSurface: 0, compressed: 1, surfaceText: '十字会话专属尾正文', surfaceTokens: 5, replacedBy: 5 }),
        segment({ seq: 5, kind: 'system/op', time: 2104, text: '十字会话专属尾正文', tokens: 5, searchText: '十字会话专属尾正文' }),
      ],
      replaces: [replace({ seq: 5, startSeq: 2, endSeq: 2, aTokens: 3, bTokens: 5, kind: 'recall' })],
    }, 44, 3100)
    v5ctx = createQueryContext(v5store)
  })

  afterAll(() => {
    v5store.close()
    rmSync(v5dir, { recursive: true, force: true })
  })

  it('缺省臂：行面与 v4 逐字段同形（15 列同序），text 经 blocks 还原原文', () => {
    const rows = sessionDetail(v5ctx, 's9').rows as Record<string, unknown>[]
    expect(rows.map(row => Number(row['seq']))).toEqual([1, 2, 4, 5])
    expect(Object.keys(rows[0]!)).toEqual([
      'session_id', 'seq', 'turn', 'step', 'kind', 'role', 'time', 'text', 'tokens',
      'search_text', 'on_surface', 'compressed', 'surface_text', 'surface_tokens', 'replaced_by',
    ])
    expect(String(rows[0]!['text'])).toContain(SECRET)
    expect(rows[0]!['surface_text']).toBeNull()
    expect(rows[1]!['surface_text']).toBe('收敛后的尾正文')
  })

  it('redact=1 臂：text/search_text 切 redacted 列，原密钥零残留；未命中行同串共块', () => {
    const red = sessionDetail(v5ctx, 's9', { redact: true }).rows as Record<string, unknown>[]
    expect(String(red[0]!['text'])).toContain('[REDACTED:API_KEY]')
    expect(String(red[0]!['text'])).not.toContain(SECRET)
    expect(String(red[0]!['search_text'])).not.toContain(SECRET)
    // 派生 surface_text 同步切链头 redacted 列（尾行未命中→与原文同块同值）
    expect(String(red[1]!['surface_text'])).toBe('收敛后的尾正文')
    // 两臂同 15 列同序（字段名不随 redact 变）
    expect(Object.keys(red[0]!)).toEqual([
      'session_id', 'seq', 'turn', 'step', 'kind', 'role', 'time', 'text', 'tokens',
      'search_text', 'on_surface', 'compressed', 'surface_text', 'surface_tokens', 'replaced_by',
    ])
  })

  it('surface 两跳派生：多跳链台账指针直接给终替正文；台账臂恒原文', () => {
    const ledger = surfaceLedger(v5ctx, 's9')
    const pointers = ledger['compressed_pointers'] as Record<string, unknown>[]
    expect(pointers.map(p => Number(p['seq']))).toEqual([2, 4])
    expect(pointers[0]!['surface_text']).toBe('收敛后的尾正文')
    expect(pointers[1]!['surface_text']).toBe('收敛后的尾正文')
    expect(seqs(ledger['on_surface'] as unknown[])).toEqual([1, 5])
    const head = (ledger['on_surface'] as Record<string, unknown>[])[0]!
    expect(String(head['text'])).toContain(SECRET)
  })

  it('双会话同 seq 撞键防御（读侧）：s9/s10 各自链头各自还原，JOIN 不串块', () => {
    const l10 = surfaceLedger(v5ctx, 's10')
    const p10 = l10['compressed_pointers'] as Record<string, unknown>[]
    expect(p10.map(p => Number(p['seq']))).toEqual([2])
    expect(p10[0]!['surface_text']).toBe('十字会话专属尾正文')
    // s9 同 seq(2→5) 的派生值不受 s10 影响（两跳均带 session_id）
    const p9 = (surfaceLedger(v5ctx, 's9')['compressed_pointers'] as Record<string, unknown>[])[0]!
    expect(p9['surface_text']).toBe('收敛后的尾正文')
    // 明细臂同面：s10 行面只含自身会话 id
    const rows10 = sessionDetail(v5ctx, 's10').rows as Record<string, unknown>[]
    expect(rows10.every(row => row['session_id'] === 's10')).toBe(true)
  })

  it('tail=N：尾窗 N 行升序；超行数=全量；非法(0/NaN)=忽略；与 turn 过滤先滤后取尾', () => {
    expect(seqs(sessionDetail(v5ctx, 's9', { tail: 2 }).rows as unknown[])).toEqual([4, 5])
    expect(seqs(sessionDetail(v5ctx, 's9', { tail: 99 }).rows as unknown[])).toEqual([1, 2, 4, 5])
    expect(seqs(sessionDetail(v5ctx, 's9', { tail: 0 }).rows as unknown[])).toEqual([1, 2, 4, 5])
    expect(seqs(sessionDetail(v5ctx, 's9', { tail: Number.NaN }).rows as unknown[])).toEqual([1, 2, 4, 5])
    expect(seqs(sessionDetail(v5ctx, 's9', { turn: '1', tail: 1 }).rows as unknown[])).toEqual([5])
    expect(seqs(sessionDetail(v5ctx, 's9', { turn: '9', tail: 3 }).rows as unknown[])).toEqual([])
  })

  it('tail×redact 组合：尾窗行面与全量 redact 臂同窗同值（两参正交不打折）', () => {
    const fullRed = sessionDetail(v5ctx, 's9', { redact: true }).rows as Record<string, unknown>[]
    const tailRed = sessionDetail(v5ctx, 's9', { tail: 2, redact: true }).rows as Record<string, unknown>[]
    expect(tailRed).toEqual(fullRed.slice(-2))
    const wholeRed = sessionDetail(v5ctx, 's9', { tail: 99, redact: true }).rows as Record<string, unknown>[]
    expect(wholeRed).toEqual(fullRed)
  })

  it('search 双态：fts 仍索引原文，两臂命中/排序一致；snippet 取材列随 redact 切', () => {
    const plain = search(v5ctx, '轮换令牌')
    expect(plain.hits.map(hit => `${hit['session_id']}#${hit['seq']}`)).toContain('s9#1')
    expect(String(plain.hits[0]!['snippet'])).toContain(SECRET)
    const red = search(v5ctx, '轮换令牌', { redact: true })
    expect(red.hits.map(hit => `${hit['session_id']}#${hit['seq']}`))
      .toEqual(plain.hits.map(hit => `${hit['session_id']}#${hit['seq']}`))
    expect(String(red.hits[0]!['snippet'])).not.toContain(SECRET)
    expect(String(red.hits[0]!['snippet'])).toContain('[REDACTED:API_KEY]')
  })

  it('searchGrouped redact 臂：snippet 锚定文本切 redacted，命中/权重不变', () => {
    const plain = searchGrouped(v5ctx, { query: '轮换令牌' })
    expect(plain.hits.map(hit => `${hit.session_id}#${hit.seq}`)).toEqual(['s9#1'])
    expect(plain.hits[0]!.snippet).toContain(SECRET)
    const red = searchGrouped(v5ctx, { query: '轮换令牌', redact: true })
    expect(red.hits.map(hit => `${hit.session_id}#${hit.seq}`)).toEqual(['s9#1'])
    expect(red.hits[0]!.snippet).not.toContain(SECRET)
    expect(red.hits[0]!.snippet).toContain('[REDACTED:API_KEY]')
  })

  it('fields=search + redact：检索臂 search_text 同步切列（steward/memory 共用臂）', () => {
    const rows = sessionDetail(v5ctx, 's9', { fields: 'search', redact: true }).rows as Record<string, unknown>[]
    expect(String(rows[0]!['search_text'])).toContain('[REDACTED:API_KEY]')
    expect(String(rows[0]!['search_text'])).not.toContain(SECRET)
    expect(rows[0]).not.toHaveProperty('text')
  })
})
