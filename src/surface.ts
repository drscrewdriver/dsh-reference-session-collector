/**
 * 查询面（T4.1）：status / listSessions / sessionDetail / surfaceLedger /
 * recallReport / search 六函数 + 缓存层 2/3（sessions 汇总常驻 Map 由
 * schema.ts 维护；per-session 台账 LRU cap 32，键含 synced_at 代际——
 * 会话重同步即自然失效）。
 *
 * sessionDetail 支持 `turn=` 区间过滤与 `fields=search`（返回 time/
 * search_text/on_surface 检索面——steward 二期切料与 memory 三期回填共用
 * 此臂）；search 查询走 segment.ts 同构切词（中文可用）。
 */
import type { ProjectionStore, SessionRow } from './schema.ts'
import { sanitizeFtsQuery } from './segment.ts'

/** 台账 LRU 容量（缓存层 3）。 */
export const LEDGER_LRU_CAP = 32

export interface CacheStats {
  summaries: number
  ledgerEntries: number
  ledgerHits: number
  ledgerMisses: number
}

interface LruEntry<T> { value: T }

/** per-session 台账 LRU：键含 synced_at 代际；get 命中重插尾部。 */
export class LedgerCache<T> {
  private readonly map = new Map<string, LruEntry<T>>()
  hits = 0
  misses = 0

  get(key: string): T | undefined {
    const hit = this.map.get(key)
    if (hit === undefined) {
      this.misses += 1
      return undefined
    }
    this.hits += 1
    this.map.delete(key)
    this.map.set(key, hit)
    return hit.value
  }

  set(key: string, value: T): void {
    this.map.delete(key)
    this.map.set(key, { value })
    while (this.map.size > LEDGER_LRU_CAP) {
      const oldest = this.map.keys().next()
      if (oldest.done === true) break
      this.map.delete(oldest.value)
    }
  }

  get size(): number { return this.map.size }

  stats(): { entries: number; hits: number; misses: number } {
    return { entries: this.map.size, hits: this.hits, misses: this.misses }
  }
}

/** 一个 store 的查询上下文（持有两类台账 LRU 与计数）。 */
export interface QueryContext {
  store: ProjectionStore
  surfaceLru: LedgerCache<unknown>
  recallLru: LedgerCache<unknown>
}

export function createQueryContext(store: ProjectionStore): QueryContext {
  return { store, surfaceLru: new LedgerCache(), recallLru: new LedgerCache() }
}

/** status：库自检 + 缓存统计（spec §HTTP 面）。 */
export function status(ctx: QueryContext, lastSync?: unknown): Record<string, unknown> {
  const store = ctx.store
  const row = store.db.prepare('SELECT COUNT(*) AS c FROM segments').get() as { c: number }
  const replaceCount = store.db.prepare('SELECT COUNT(*) AS c FROM replaces').get() as { c: number }
  const version = store.db.prepare("SELECT value FROM meta WHERE key='schema_version'").get() as { value: string } | undefined
  // 代次分布哨兵：老代(0-2)语料块形状可能不完整是如实事实，暴露给消费方自检。
  const gens = store.db.prepare('SELECT format_generation AS generation, COUNT(*) AS n FROM sessions GROUP BY format_generation ORDER BY format_generation').all() as unknown as { generation: number; n: number }[]
  return {
    ok: true,
    sessions: store.summaries.size,
    segments: row.c,
    replaces: replaceCount.c,
    schema_version: version?.value ?? 'unknown',
    generations: gens,
    cache: {
      summaries: store.summaries.size,
      surface_ledger: ctx.surfaceLru.stats(),
      recall_ledger: ctx.recallLru.stats(),
    },
    ...(lastSync === undefined ? {} : { last_sync: lastSync }),
  }
}

/** sessions 汇总表分页（0 SQL，走常驻 Map；按 last_time_ms 降序）。 */
export function listSessions(ctx: QueryContext, offset = 0, limit = 50): { total: number; rows: SessionRow[] } {
  const all = [...ctx.store.summaries.values()].sort((a, b) => b.last_time_ms - a.last_time_ms)
  const from = Math.max(0, Math.floor(offset))
  const size = Math.min(Math.max(1, Math.floor(limit)), 500)
  return { total: all.length, rows: all.slice(from, from + size) }
}

/** sessionDetail 的检索面行（fields=search——steward 切料/memory 回填共用）。 */
export interface SearchFaceRow {
  seq: number
  turn: number
  step: number
  kind: string
  time: number
  search_text: string
  on_surface: number
}

/** turn 参数解析：`3` 精确 / `2-4` 闭区间；其余忽略。 */
function parseTurnRange(raw?: string): { min: number; max: number } | undefined {
  if (raw === undefined || raw === '') return undefined
  const range = /^(\d+)-(\d+)$/.exec(raw)
  if (range !== null) {
    const min = Number(range[1]); const max = Number(range[2])
    return { min, max }
  }
  const single = Number(raw)
  if (Number.isFinite(single)) return { min: single, max: single }
  return undefined
}

/**
 * segments 明细。
 * @param turn - `turn=` 区间过滤（`a-b` 闭区间或单值）。
 * @param fields - `'search'` 返检索面字段（time/search_text/on_surface）。
 */
export function sessionDetail(
  ctx: QueryContext,
  sessionId: string,
  opts: { turn?: string; fields?: string } = {},
): { session: SessionRow | undefined; rows: unknown[] } {
  const store = ctx.store
  const session = store.summaries.get(sessionId)
  const range = parseTurnRange(opts.turn)
  const where = range === undefined
    ? 'SELECT * FROM segments WHERE session_id=? ORDER BY seq'
    : 'SELECT * FROM segments WHERE session_id=? AND turn BETWEEN ? AND ? ORDER BY seq'
  const rows = (range === undefined
    ? store.db.prepare(where).all(sessionId)
    : store.db.prepare(where).all(sessionId, range.min, range.max)) as unknown as Record<string, unknown>[]
  if (opts.fields !== 'search') {
    return { session, rows }
  }
  const searchRows: SearchFaceRow[] = rows.map(r => ({
    seq: Number(r['seq']),
    turn: Number(r['turn']),
    step: Number(r['step']),
    kind: String(r['kind']),
    time: Number(r['time']),
    search_text: String(r['search_text'] ?? ''),
    on_surface: Number(r['on_surface']),
  }))
  return { session, rows: searchRows }
}

/** surface 台账（R3）：当前表面行 + 被替换指针视图（LRU）。 */
export function surfaceLedger(ctx: QueryContext, sessionId: string): Record<string, unknown> {
  const store = ctx.store
  const synced = store.summaries.get(sessionId)?.synced_at ?? '?'
  const key = `${sessionId}|${synced}`
  const cached = ctx.surfaceLru.get(key)
  if (cached !== undefined) return cached as Record<string, unknown>
  const onSurface = store.db.prepare(
    'SELECT seq, turn, step, kind, role, time, tokens, text FROM segments WHERE session_id=? AND on_surface=1 ORDER BY seq',
  ).all(sessionId)
  const compressed = store.db.prepare(
    'SELECT seq, replaced_by, surface_text, surface_tokens FROM segments WHERE session_id=? AND compressed=1 ORDER BY seq',
  ).all(sessionId)
  const value: Record<string, unknown> = {
    session_id: sessionId,
    on_surface: onSurface,
    compressed_pointers: compressed,
  }
  ctx.surfaceLru.set(key, value)
  return value
}

/** 召回对账（R4）：替换对分类 + Σb（回吐）+ Σ(a−b)（毛节省）（LRU）。 */
export function recallReport(ctx: QueryContext, sessionId: string): Record<string, unknown> {
  const store = ctx.store
  const synced = store.summaries.get(sessionId)?.synced_at ?? '?'
  const key = `${sessionId}|${synced}`
  const cached = ctx.recallLru.get(key)
  if (cached !== undefined) return cached as Record<string, unknown>
  const pairs = store.db.prepare(
    'SELECT seq, start_seq, end_seq, a_tokens, b_tokens, kind, turn, step FROM replaces WHERE session_id=? ORDER BY seq',
  ).all(sessionId) as unknown as { kind: string; a_tokens: number; b_tokens: number }[]
  let gross = 0
  let recall = 0
  let compressPairs = 0
  let recallPairs = 0
  for (const p of pairs) {
    if (p.kind === 'recall') {
      recall += p.b_tokens
      recallPairs += 1
    } else {
      gross += p.a_tokens - p.b_tokens
      compressPairs += 1
    }
  }
  const value: Record<string, unknown> = {
    session_id: sessionId,
    pairs,
    gross_saved: gross,
    recall_tokens: recall,
    compress_pairs: compressPairs,
    recall_pairs: recallPairs,
    basis: store.summaries.get(sessionId)?.basis ?? 'chars/4',
  }
  ctx.recallLru.set(key, value)
  return value
}

/** FTS5 BM25 内容搜索（中英同构切词，走 sanitizeFtsQuery）。 */
export function search(
  ctx: QueryContext,
  query: string,
  opts: { session?: string; limit?: number } = {},
): { query: string; match: string; hits: Record<string, unknown>[] } {
  const match = sanitizeFtsQuery(query)
  if (match === '') return { query, match, hits: [] }
  const limit = Math.min(Math.max(1, Math.floor(opts.limit ?? 20)), 100)
  const sessionClause = opts.session !== undefined && opts.session !== '' ? 'AND segments_fts.session_id = ?' : ''
  const sql = `SELECT segments_fts.session_id AS session_id, segments_fts.seq AS seq, segments_fts.kind AS kind,
      bm25(segments_fts) AS rank, substr(s.search_text, 1, 200) AS snippet, s.time, s.on_surface, s.turn
    FROM segments_fts
    JOIN segments s ON s.session_id = segments_fts.session_id AND s.seq = segments_fts.seq
    WHERE segments_fts MATCH ? ${sessionClause}
    ORDER BY rank LIMIT ?`
  const stmt = ctx.store.db.prepare(sql)
  const hits = (opts.session !== undefined && opts.session !== ''
    ? stmt.all(match, opts.session, limit)
    : stmt.all(match, limit)) as unknown as Record<string, unknown>[]
  return { query, match, hits }
}

// ─────────────────── 分组搜索臂（steward 检索语义直译） ───────────────────

/** 搜索权重：消息正文盖过工具噪声（steward TYPE_WEIGHT 同值）。 */
const SEARCH_TYPE_WEIGHT: Readonly<Record<string, number>> = {
  'user/message': 3,
  'assistant/message': 3,
  'tool/call': 1,
  'tool/result': 1,
}

/** 节选长度（steward SNIPPET_CHARS 同值）。 */
const SEARCH_SNIPPET_CHARS = 240

/** FTS 扫描上限（分组前的候选窗口，steward MATCH_SCAN_LIMIT 同值）。 */
const SEARCH_SCAN_LIMIT = 5000

/**
 * 锤定查询词首次出现的节选（steward buildSnippet 逐字同构移植，
 * 2026-10-20）：短文本直返；命中词居中开窗；无锚点退化为头部截断。
 */
export function buildSearchSnippet(text: string, query: string, max = SEARCH_SNIPPET_CHARS): string {
  const flat = text.replace(/\s+/gu, ' ').trim()
  if (flat.length <= max) return flat
  const lower = flat.toLowerCase()
  const terms = query.toLowerCase().split(/\s+/u).filter(Boolean)
  let anchor = -1
  for (const term of terms) {
    const at = lower.indexOf(term)
    if (at >= 0 && (anchor < 0 || at < anchor)) anchor = at
  }
  if (anchor < 0) return `${flat.slice(0, max)}…`
  const start = Math.max(0, anchor - Math.floor((max - 3) / 2))
  const end = Math.min(flat.length, start + max - 3)
  const head = start > 0 ? '…' : ''
  const tail = end < flat.length ? '…' : ''
  return `${head}${flat.slice(start, end)}${tail}`
}

/** 分组搜索请求（与 steward engine.search 入参同形；kinds 为原事件 type 列表）。 */
export interface GroupedSearchRequest {
  query: string
  /** 允许的原事件 type（已由调用方展开粗类）；缺省= user+assistant（steward resolveTypes 同标）。 */
  kinds?: readonly string[]
  /** 检索域：'active' 仅活跃、'archived' 仅归档、缺省 'all'。 */
  archived?: 'active' | 'archived' | 'all'
  /** 会话末事件时间下界（epoch ms，含）。 */
  from?: number
  /** 上界（排他）。 */
  to?: number
  /** true（缺省）=仅当前表面行（on_surface=1，steward surface='current' 同款）。 */
  surfaceOnly?: boolean
  /** 排序：缺省 relevance；'time'=会话 updated_at 降序、分数平手。 */
  sortBy?: 'relevance' | 'time'
  limit?: number
}

/** 分组命中（wire 蛇形，会话级最强命中）。 */
export interface GroupedSearchHit {
  session_id: string
  title: string
  seq: number
  type: string
  time: number
  updated_at: number
  snippet: string
}

/**
 * 会话分组全文搜索（op=search&group=session）：BM25 候选窗 → 按会话取
 * 加权最强命中 → 排序分页。数学/视界与 steward engine.search 逐字同构：
 * score = −rank × weight(type)，时间排序键是会话 updated_at（非命中 time）。
 */
export function searchGrouped(ctx: QueryContext, request: GroupedSearchRequest): { query: string; hits: GroupedSearchHit[] } {
  const match = sanitizeFtsQuery(request.query)
  if (match === '') return { query: request.query, hits: [] }
  const limit = Math.min(Math.max(1, Math.floor(request.limit ?? 20)), 100)
  const kinds = request.kinds !== undefined && request.kinds.length > 0
    ? [...request.kinds]
    : ['user/message', 'assistant/message']
  const placeholders = kinds.map(() => '?').join(', ')
  const archivedClause = request.archived === 'active'
    ? 'AND sess.archived = 0'
    : request.archived === 'archived'
      ? 'AND sess.archived = 1'
      : ''
  const surfaceClause = request.surfaceOnly === false ? '' : 'AND seg.on_surface = 1'
  const dateClauses: string[] = []
  const dateParams: number[] = []
  if (typeof request.from === 'number' && Number.isFinite(request.from)) {
    dateClauses.push('AND sess.last_time_ms >= ?')
    dateParams.push(request.from)
  }
  if (typeof request.to === 'number' && Number.isFinite(request.to)) {
    dateClauses.push('AND sess.last_time_ms < ?')
    dateParams.push(request.to)
  }
  const dateClause = dateClauses.join(' ')
  const sql = `SELECT seg.session_id AS session_id, seg.seq AS seq, seg.kind AS kind, seg.time AS time,
      seg.search_text AS search_text, bm25(segments_fts) AS rank,
      sess.title AS title, sess.last_time_ms AS updated_at
    FROM segments_fts
    JOIN segments seg ON seg.session_id = segments_fts.session_id AND seg.seq = segments_fts.seq
    JOIN sessions sess ON sess.session_id = seg.session_id
    WHERE segments_fts MATCH ?
      AND seg.kind IN (${placeholders}) ${surfaceClause} ${archivedClause} ${dateClause}
    ORDER BY rank LIMIT ?`
  const docs = ctx.store.db.prepare(sql)
    .all(match, ...kinds, ...dateParams, SEARCH_SCAN_LIMIT) as unknown as {
      session_id: string
      seq: number
      kind: string
      time: number
      search_text: string
      rank: number
      title: string
      updated_at: number
    }[]
  const bestBySession = new Map<string, { doc: typeof docs[number]; score: number }>()
  for (const doc of docs) {
    const weight = SEARCH_TYPE_WEIGHT[doc.kind] ?? 1
    const score = -Number(doc.rank) * weight
    const best = bestBySession.get(doc.session_id)
    if (best === undefined || score > best.score) bestBySession.set(doc.session_id, { doc, score })
  }
  const grouped = [...bestBySession.values()]
  if (request.sortBy === 'time') {
    grouped.sort((a, b) => (b.doc.updated_at - a.doc.updated_at) || (b.score - a.score))
  } else {
    grouped.sort((a, b) => b.score - a.score)
  }
  const hits = grouped.slice(0, limit).map(({ doc }) => ({
    session_id: doc.session_id,
    title: doc.title,
    seq: doc.seq,
    type: doc.kind,
    time: doc.time,
    updated_at: doc.updated_at,
    snippet: buildSearchSnippet(doc.search_text, request.query),
  }))
  return { query: request.query, hits }
}
