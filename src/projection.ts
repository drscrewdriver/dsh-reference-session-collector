/**
 * 纯投影核心：解码事件流 → (summary, segments, replaces)。
 *
 * 零 IO、零宿主依赖，可独立单测；同步引擎（src/sync.ts）与测试种子共用本函数。
 * 三视界契约（spec §纯投影核心）：
 * - **text/tokens**＝CCI verify 同款：`data.message.content[]` 的 text 块逐块计数
 *   （富块计 0），与 `dsh-context-compression-improved`
 *   `packages/selector/src/runtime/savings-verify.ts:66-80` 同公式同词表；
 * - **search_text**＝steward `extractSessionEventText` 逐字同构（tool/call 参数、
 *   todo/write、turn/end 错误原因入面；reasoning 不入）；
 * - **on_surface**＝surface 重放：replace 对剔除 [start..end]、自身入面，
 *   从未被任何 pair 覆盖的行=1（checklist「被覆盖区间=0、replace 自身=1」）。
 * surfaceOp 双形状容错：`{op:'replace', startSeq, endSeq}`（CCI 写入）与
 * `{op:'replace', start, end}`（解码叶子接口注释）都认。
 */
import type { DecodedEvent } from './session-file-decode.ts'

/** 精确计数器（tokenizer.countText 的数值臂）；缺席时 chars/4 上界。 */
export type ExactCounter = (text: string) => number

/** chars/4 常数——与 CCI verify 的 CHARS_PER_TOKEN 同值。 */
const CHARS_PER_TOKEN = 4

/** segments 表一行（snake_case 列名映射在 schema.ts 完成）。 */
export interface ProjectionSegment {
  seq: number
  turn: number
  step: number
  kind: string
  role: string
  /** 事件 epoch ms。 */
  time: number
  /** 模型可见文本（CCI 视界）。 */
  text: string
  tokens: number
  /** 检索视界（steward 抽取超集）。 */
  searchText: string
  /** 1=当前表面；0=被某 replace 区间覆盖。 */
  onSurface: 0 | 1
  /** 1=本行被替换对覆盖（compressed 标记，R3）。 */
  compressed: 0 | 1
  /** 当前表面上是什么（链解析后的终替文本）；未压缩=null。 */
  surfaceText: string | null
  surfaceTokens: number | null
  /** 被谁替换（链解析后的终替事件 seq）；未压缩=null。 */
  replacedBy: number | null
}

/** replaces 表一行（R4 替换对指针）。 */
export interface ProjectionReplace {
  seq: number
  startSeq: number
  endSeq: number
  aTokens: number
  bTokens: number
  kind: 'compress' | 'recall'
  turn: number
  step: number
}

/** sessions 表一行的投影侧字段（watermark/archived 由 sync 侧补写）。 */
export interface SessionSummary {
  sessionId: string
  dirId: string
  title: string
  cwd: string
  eventCount: number
  maxSeq: number
  turnCount: number
  segmentTokens: number
  surfaceTokens: number
  grossSaved: number
  recallTokens: number
  compressPairs: number
  recallPairs: number
  basis: 'ds-token' | 'chars/4'
  lastTimeMs: number
}

/** 一次完整投影结果。 */
export interface SessionProjection {
  summary: SessionSummary
  segments: ProjectionSegment[]
  replaces: ProjectionReplace[]
}

/** projectSessionEvents 选项。 */
export interface ProjectionOptions {
  dirId: string
  /** 缺省=dirId（宿主目录名即会话 id 的代次布局）。 */
  sessionId?: string
  /** 日志首行 header（decodeSessionLogBytes 产出），取 cwd/title 元数据。 */
  header?: Record<string, unknown>
  /** 精确计数器；缺省 chars/4 降级并如实标注 basis。 */
  exactCounter?: ExactCounter
  /** 预置标题（steward 式从事件流抽出的最后一帧标题）。 */
  title?: string
}

// ─────────────────────────── 视界叶子（同构移植） ───────────────────────────

/** Whether a runtime value is a plain record. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Trimmed text of one string-or-undefined part list, joined by newlines. */
function joinText(parts: readonly (string | undefined)[]): string {
  return parts.map(part => (typeof part === 'string' ? part.trim() : '')).filter(Boolean).join('\n')
}

/** CCI verify 同视界：data.message.content[] 的 text 块列表（富块忽略）。 */
function modelTextBlocks(event: DecodedEvent): string[] {
  const data = isRecord(event.data) ? event.data : undefined
  const message = data !== undefined && isRecord(data['message']) ? data['message'] : undefined
  const content = message !== undefined ? message['content'] : undefined
  if (!Array.isArray(content)) return []
  const out: string[] = []
  for (const block of content) {
    const text = isRecord(block) ? block['text'] : undefined
    if (typeof text === 'string' && text !== '') out.push(text)
  }
  return out
}

/** Extracted text of one content block; unknown blocks contribute nothing. */
function blockText(block: unknown): string[] {
  if (!isRecord(block)) return []
  switch (block['type']) {
    case 'text':
      return typeof block['text'] === 'string' ? [block['text']] : []
    case 'reasoning':
      return []
    case 'tool-call':
      return [block['name'], block['arguments']].filter((v): v is string => typeof v === 'string')
    case 'tool-result': {
      const content = block['content']
      return Array.isArray(content) ? content.flatMap(blockText) : []
    }
    default:
      return []
  }
}

/** Text of one message content (array of blocks, or a plain string). */
function contentText(content: unknown): string {
  if (typeof content === 'string') return content.trim()
  if (!Array.isArray(content)) return ''
  return joinText(content.flatMap(blockText))
}

/** Turn-end reason text; completed turns contribute nothing. */
function turnEndText(data: Record<string, unknown>): string {
  const reason = data['reason']
  if (!isRecord(reason)) return ''
  switch (reason['kind']) {
    case 'error': {
      const error = reason['error']
      const message = isRecord(error) && typeof error['message'] === 'string' ? error['message'] : ''
      return joinText(['error', message])
    }
    case 'aborted':
      return 'aborted'
    case 'max-tokens':
    case 'interrupted':
      return String(reason['kind'])
    case 'completed':
      return ''
    // Unknown outcomes stay out until their owner defines search semantics.
    default:
      return ''
  }
}

/**
 * 检索视界——steward `extractSessionEventText`（extract.ts:161-199）逐字同构。
 * @param event - 解码后的一个会话事件。
 * @returns 换行拼接的检索文本；不可检索事件返回空串。
 */
export function extractSearchEventText(event: DecodedEvent): string {
  const data = isRecord(event.data) ? event.data : {}
  switch (event.type) {
    case 'user/message':
      return contentText(data['content'])
    case 'assistant/message': {
      const message = isRecord(data['message']) ? data['message'] : {}
      return contentText(message['content'])
    }
    case 'tool/call':
      return joinText([data['name'], data['arguments']].filter((v): v is string => typeof v === 'string'))
    case 'tool/result': {
      const message = isRecord(data['message']) ? data['message'] : {}
      const error = isRecord(data['error']) ? data['error'] : {}
      return joinText([
        contentText(message['content']),
        typeof error['name'] === 'string' ? error['name'] : '',
        typeof error['code'] === 'string' ? error['code'] : '',
      ])
    }
    case 'todo/write': {
      const todos = Array.isArray(data['todos']) ? data['todos'] : []
      return joinText(todos.flatMap((todo) => {
        if (!isRecord(todo)) return []
        return [todo['status'], todo['content']].filter((v): v is string => typeof v === 'string')
      }))
    }
    case 'turn/end':
      return turnEndText(data)
    case 'turn/start':
    case 'step/start':
    case 'step/end':
    case 'assistant/attempt':
    case 'request/header':
      return ''
    default:
      return ''
  }
}

/**
 * 从事件流抽最后一帧标题——steward `extractTitleFromEvents`（extract.ts:28-43）
 * 同构（形状三兼容：`{title}`、`{title:{title}}`、`{title:{val}}`）。
 */
export function extractTitleFromEvents(events: readonly DecodedEvent[]): string {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i]
    if (event === undefined || event === null || typeof event !== 'object') continue
    if (event.type !== 'session/title') continue
    const data = isRecord(event.data) ? (event.data as { title?: unknown }) : undefined
    const title = data?.title
    if (typeof title === 'string' && title.trim() !== '') return title
    if (title !== null && typeof title === 'object') {
      const inner = title as { title?: unknown; val?: unknown }
      if (typeof inner.title === 'string' && inner.title.trim() !== '') return inner.title
      if (typeof inner.val === 'string' && inner.val.trim() !== '') return inner.val
    }
  }
  return ''
}

/** surfaceOp 双形状解析：CCI 写 startSeq/endSeq，叶子接口注释 start/end。 */
function parseSurfaceOp(event: DecodedEvent): { start: number; end: number } | undefined {
  const op = event.surfaceOp
  if (op === 'append' || op === undefined || op === null || typeof op !== 'object') return undefined
  // 双形状：类型面只声明 start/end，写入侧实为 startSeq/endSeq——按记录索引。
  const rec = op as unknown as Record<string, unknown>
  if (rec['op'] !== 'replace') return undefined
  const start = typeof rec['startSeq'] === 'number' ? rec['startSeq'] : rec['start']
  const end = typeof rec['endSeq'] === 'number' ? rec['endSeq'] : rec['end']
  if (typeof start !== 'number' || typeof end !== 'number') return undefined
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return undefined
  return { start, end }
}

/** 事件 role 归属（DDL segments.role）。 */
function eventRole(type: string): string {
  if (type === 'user/message') return 'user'
  if (type === 'assistant/message') return 'assistant'
  return ''
}

// ─────────────────────────── 纯投影主函数 ───────────────────────────

/**
 * 投影一个会话的全部解码事件（两遍扫描）。
 * @param events - decodeSessionLogBytes 产出的连续事件流（含 header 后的全部行）。
 * @param options - 见 {@link ProjectionOptions}。
 * @returns summary + segments（text/search_text 任一非空才收）+ replaces（R4）。
 */
export function projectSessionEvents(
  events: readonly DecodedEvent[],
  options: ProjectionOptions,
): SessionProjection {
  const dirId = options.dirId
  const sessionId = options.sessionId ?? options.dirId
  const counter = options.exactCounter
  const basis: SessionSummary['basis'] = counter === undefined ? 'chars/4' : 'ds-token'
  const countOne = (text: string): number => counter?.(text) ?? Math.ceil(text.length / CHARS_PER_TOKEN)

  // 第一遍：tokensBySeq（CCI verify:129-137 同视界）+ 段行草集（turn/step 归属见第三遍）。
  const tokensBySeq = new Map<number, number>()
  const textBySeq = new Map<number, string>()
  for (const event of events) {
    const blocks = modelTextBlocks(event)
    let tokens = 0
    for (const block of blocks) tokens += countOne(block)
    tokensBySeq.set(event.seq, tokens)
    textBySeq.set(event.seq, blocks.join('\n'))
  }

  // 第二遍：替换对（surfaceOp 双形状）+ 覆盖集（on_surface 重放）。
  const replaces: ProjectionReplace[] = []
  const covered = new Set<number>()
  const pointerBySeq = new Map<number, { seq: number; turn: number; step: number }>()
  let scanTurn = 0
  let scanStep = 0
  for (const event of events) {
    const data = isRecord(event.data) ? (event.data as { turn?: unknown; step?: unknown }) : undefined
    if (event.type === 'step/start' && data !== undefined) {
      if (typeof data.turn === 'number') scanTurn = data.turn
      if (typeof data.step === 'number') scanStep = data.step
    }
    const range = parseSurfaceOp(event)
    if (range === undefined) continue
    let a = 0
    for (let seq = range.start; seq <= range.end; seq += 1) a += tokensBySeq.get(seq) ?? 0
    const b = tokensBySeq.get(event.seq) ?? 0
    replaces.push({
      seq: event.seq,
      startSeq: range.start,
      endSeq: range.end,
      aTokens: a,
      bTokens: b,
      // 用户定标公式（verify:150-154 同款）：b≤a 毛+=a−b；b>a=召回回吐 Σb。
      kind: b > a ? 'recall' : 'compress',
      turn: scanTurn,
      step: scanStep,
    })
    for (let seq = range.start; seq <= range.end; seq += 1) {
      covered.add(seq)
      pointerBySeq.set(seq, { seq: event.seq, turn: scanTurn, step: scanStep })
    }
  }

  // 段行收集：text/search_text 任一非空才收（chunk 空行不落）。
  const segments: ProjectionSegment[] = []
  const rowBySeq = new Map<number, ProjectionSegment>()
  for (const event of events) {
    const text = textBySeq.get(event.seq) ?? ''
    const searchText = extractSearchEventText(event)
    if (text === '' && searchText === '') continue
    const pointer = pointerBySeq.get(event.seq)
    const row: ProjectionSegment = {
      seq: event.seq,
      turn: 0,
      step: 0,
      kind: event.type,
      role: eventRole(event.type),
      time: typeof event.time === 'number' ? event.time : 0,
      text,
      tokens: tokensBySeq.get(event.seq) ?? 0,
      searchText,
      onSurface: covered.has(event.seq) ? 0 : 1,
      compressed: pointer !== undefined ? 1 : 0,
      surfaceText: pointer !== undefined ? (textBySeq.get(pointer.seq) ?? '') : null,
      surfaceTokens: pointer !== undefined ? (tokensBySeq.get(pointer.seq) ?? 0) : null,
      replacedBy: pointer?.seq ?? null,
    }
    segments.push(row)
    rowBySeq.set(event.seq, row)
  }

  // 指针链解析：替身行本身再被覆盖时，跟随到终替（当前表面语义）。
  for (const row of segments) {
    if (row.compressed !== 1 || row.replacedBy === null) continue
    let hop = rowBySeq.get(row.replacedBy)
    let guard = 0
    while (hop !== undefined && hop.compressed === 1 && hop.replacedBy !== null && guard < 64) {
      const next = rowBySeq.get(hop.replacedBy)
      if (next === undefined || next === hop) break
      hop = next
      guard += 1
    }
    if (hop !== undefined) {
      row.surfaceText = hop.text
      row.surfaceTokens = hop.tokens
      row.replacedBy = hop.seq
    }
  }

  // turn/step 归属：按 step/start 滚动补齐（段行落在哪个 turn/step 区间）。
  let rollTurn = 0
  let rollStep = 0
  const turnStepBySeq = new Map<number, { turn: number; step: number }>()
  for (const event of events) {
    const data = isRecord(event.data) ? (event.data as { turn?: unknown; step?: unknown }) : undefined
    if (event.type === 'step/start' && data !== undefined) {
      if (typeof data.turn === 'number') rollTurn = data.turn
      if (typeof data.step === 'number') rollStep = data.step
    }
    turnStepBySeq.set(event.seq, { turn: rollTurn, step: rollStep })
  }
  for (const row of segments) {
    const at = turnStepBySeq.get(row.seq)
    if (at !== undefined) {
      row.turn = at.turn
      row.step = at.step
    }
  }

  // 汇总（sessions 表字段）。
  let segmentTokens = 0
  let surfaceTokens = 0
  let lastTimeMs = 0
  let maxSeq = -1
  let turnCount = 0
  for (const row of segments) {
    segmentTokens += row.tokens
    if (row.onSurface === 1) surfaceTokens += row.tokens
    if (row.seq > maxSeq) maxSeq = row.seq
    if (row.turn > turnCount) turnCount = row.turn
  }
  for (const event of events) {
    if (typeof event.time === 'number' && event.time > lastTimeMs) lastTimeMs = event.time
    if (event.seq > maxSeq) maxSeq = event.seq
  }
  let grossSaved = 0
  let recallTokens = 0
  let compressPairs = 0
  let recallPairs = 0
  for (const pair of replaces) {
    if (pair.kind === 'recall') {
      recallTokens += pair.bTokens
      recallPairs += 1
    } else {
      grossSaved += pair.aTokens - pair.bTokens
      compressPairs += 1
    }
  }
  const header = options.header
  const summary: SessionSummary = {
    sessionId,
    dirId,
    title: options.title ?? extractTitleFromEvents(events),
    cwd: header !== undefined && typeof header['cwd'] === 'string' ? header['cwd'] : '',
    eventCount: events.length,
    maxSeq,
    turnCount,
    segmentTokens,
    surfaceTokens,
    grossSaved,
    recallTokens,
    compressPairs,
    recallPairs,
    basis,
    lastTimeMs,
  }
  return { summary, segments, replaces }
}
