/**
 * T4.2 查询面断言:种子库 → 六查询形状/数学断言 + LRU 命中计数 +
 * 重同步后代际失效 + turn 过滤 + 中文查询命中 index_text。
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
  return { startSeq: over.seq ?? 0, endSeq: over.seq ?? 0, aTokens: 0, bTokens: 0, turn: 1, step: 1, ...over }
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
    expect(report['schema_version']).toBe('3')
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
    expect(pointers[1]?.['replaced_by']).toBe(6)
    expect(pointers[1]?.['surface_tokens']).toBe(85)

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
