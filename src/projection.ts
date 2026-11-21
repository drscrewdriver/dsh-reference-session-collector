/**
 * 纯投影核心：解码事件流 → (summary, segments, replaces)。
 *
 * 零 IO、零宿主依赖，可独立单测；同步引擎（src/sync.ts）与测试种子共用本函数。
 * 三视界契约（spec §纯投影核心）：
 * - **text/tokens**＝CCI verify 同款：`data.message.content[]` 的 text 块逐块计数
 *   （富块计 0），与 `dsh-context-compression-improved`
 *   `packages/selector/src/runtime/savings-verify.ts:66-80` 同公式同词表；
 * - **search_text**＝steward `extractSessionEventText` 逐字同构（tool/call 参数、
 *   todo/write、turn/end 错误原因入面；reasoning 不入）+ **宿主注入样板段
 *   剥离**（strip-injected，2026-10-20 真机取证：39% 用户消息含记忆召回/人格
 *   等注入段，不剥则节选/命中对不上关键词）；只影响检索面，
 *   text/tokens 的 CCI 口径不动（R5）；
 * - **on_surface**＝surface 重放：replace 对剔除 [start..end]、自身入面，
 *   从未被任何 pair 覆盖的行=1（checklist「被覆盖区间=0、replace 自身=1」）。
 * surfaceOp 双形状容错：`{op:'replace', startSeq, endSeq}`（CCI 写入）与
 * `{op:'replace', start, end}`（解码叶子接口注释）都认。
 */
import type { DecodedEvent } from './session-file-decode.ts'
import { stripInjectedBlocks } from './strip-injected.ts'

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
  /**
   * 1=替身行仍在面（delta 生效）；0=替身已被后续 checkpoint/replace 再覆盖，
   * delta 清除不入 gross（用户定标 2026-10-20：checkpoint 只影响其后的积分，
   * 被它吸收的先前对不再重复计费——与 CCI projectSavingsCore 「只算仍在
   * surface 中的替换节点」同语义）。per-pair a/b 保持原始区间事实不回改。
   */
  live: 0 | 1
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
  /** 文件头自声明格式代次（0..4 放行；-1=无 header 版本，理论上不至）。 */
  formatGeneration: number
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

/**
 * 模型可见文本视界：data.message.content[]（assistant/tool 形状）或
 * data.content[]（user/message 与宿主 checkpoint 替身形状，真机取证
 * 2026-10-20：compact-checkpoint 摘要挂在 data.content，旧视界全计 0
 * 致 b 侧漏记、用户消息漏记）——CCI verify eventTextTokens 同款双臂。
 * 两臂内容重复时只取一臂（checkpoint 行同时携两份同文，双计会虚高 b）。
 */
function modelTextBlocks(event: DecodedEvent): string[] {
  const data = isRecord(event.data) ? event.data : undefined
  if (data === undefined) return []
  const message = isRecord(data['message']) ? data['message'] : undefined
  const collect = (blocks: unknown): string[] => {
    if (!Array.isArray(blocks)) return []
    const out: string[] = []
    for (const block of blocks) {
      const text = isRecord(block) ? block['text'] : undefined
      if (typeof text === 'string' && text !== '') out.push(text)
    }
    return out
  }
  const fromMessage = collect(message?.['content'])
  const fromData = collect(data['content'])
  // 两臂都有且内容完全一致 → 取一臂（不双计）；不一致 → 并集（罕见形状，如实取全）。
  if (fromMessage.length > 0 && fromData.length > 0) {
    return joinText(fromMessage) === joinText(fromData) ? fromMessage : [...fromMessage, ...fromData]
  }
  return fromMessage.length > 0 ? fromMessage : fromData
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
      // 暂置 1；第二遍结束后按覆盖集统一重算（live 旗标）。
      live: 1,
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
    // 检索面过注入剥离；CCI 口径 text 保持原文（horizon v2，schema v3）。
    const searchText = stripInjectedBlocks(extractSearchEventText(event))
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

  // live 旗标（用户定标 2026-10-20）：替身行已被后续任何区间再覆盖 → delta
  // 清除，不再入 grossSaved（checkpoint 只影响其后的积分，不重复计先前对）。
  for (const pair of replaces) pair.live = covered.has(pair.seq) ? 0 : 1

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
      // 只计仍生效（live=1）的压缩对——被 checkpoint 吸收的先前对 delta 已清除，
      // 其原文的节省由 checkpoint 自身那对计费，不双计。
      if (pair.live === 1) grossSaved += pair.aTokens - pair.bTokens
      compressPairs += 1
    }
  }
  const header = options.header
  const formatGeneration = header !== undefined && typeof header['version'] === 'number' ? header['version'] : -1
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
    formatGeneration,
  }
  return { summary, segments, replaces }
}

// ─────────────────────────── 帧级增量投影（issue #3） ───────────────────────────

/** 先验段行窄视图（存储侧 getSessionState 产出；链解析与翻转修正的最小面）。 */
export interface PriorSegmentView {
  seq: number
  tokens: number
  onSurface: 0 | 1
  compressed: 0 | 1
  replacedBy: number | null
  surfaceTokens: number | null
}

/** 先验替换对窄视图（live 熄灭与 grossSaved 修正的最小面）。 */
export interface PriorReplaceView {
  seq: number
  aTokens: number
  bTokens: number
  kind: 'compress' | 'recall'
  live: 0 | 1
}

/** 增量投影的折叠基座：会话现状 + 水位处的滚动归属。 */
export interface ProjectionPrior {
  summary: SessionSummary
  /** 水位处的 turn/step 滚动值（新事件从此续算）。 */
  rollTurn: number
  rollStep: number
  segments: PriorSegmentView[]
  replaces: PriorReplaceView[]
}

/** 先验行的定点落库更新（onSurface/compressed/surface 指针终值）。 */
export interface IncrementSegmentUpdate {
  seq: number
  onSurface: 0 | 1
  compressed: 0 | 1
  surfaceTokens: number | null
  replacedBy: number | null
}

/** 一次增量投影的落库载荷（applyIncrement 的输入）。 */
export interface SessionIncrementDelta {
  /** 新段行（链解析后的 surface_tokens/replaced_by 终值）。 */
  newSegments: ProjectionSegment[]
  /** 新替换对（含批内 live 语义）。 */
  newReplaces: ProjectionReplace[]
  /** 先验段行的翻转与链尾连带更新。 */
  priorSegmentUpdates: IncrementSegmentUpdate[]
  /** 先验对被新覆盖熄灭（live 1→0）的 seq。 */
  priorReplaceLiveOff: number[]
  /** 合并后的会话汇总（可加字段 + 翻转修正）。 */
  summary: SessionSummary
  /** 本批事件后的 turn/step 滚动终值（水位推进写入面）。 */
  rollTurn: number
  rollStep: number
}

/**
 * 帧级增量投影（issue #3）：只折叠**新增帧的事件**，先验状态从库读入。
 *
 * 正确性依据（与 {@link projectSessionEvents} 全量投影的等价性）：
 * - 日志 append-only + 事件 seq 稠密 ⇒ 新事件 seq 严格大于全部先验 seq；
 *   replace 区间 end < 自身 seq ⇒ **旧覆盖永远够不到新段行**，新段行的
 *   onSurface/compressed 只由新 covered 集决定。
 * - covered 集只有 add（:349）⇒ 先验行的翻转**单向 1→0**，影响集 =
 *   新覆盖范围 ∩ 先验行（有界）；surfaceTokens/grossSaved 在翻转点上
 *   减去对应份额，可加字段直接合并。
 * - 指针链解析在全量投影里是"直接替身 → 链跳到终替"；先验行落库的是
 *   **终替值**，重跑链解析幂等（终替未变时结果不变），终替被新覆盖时
 *   自然续跳——因此先验行 + 新行合并视图统一重跑一次链解析即可，
 *   变化行进 priorSegmentUpdates（链尾连带行也在内）。
 * - turn/step 归属是前向滚动：从水位处的 roll 续算即可。
 *
 * 已知边界：surfaceText（不落库，读侧经 blocks 链派生）只在终替是**新行**
 * 时按全量口径精化；终替是先验行时保留直接替身文本的占位——非契约面。
 * 链解析是 O(会话段行数) 的内存遍历（无解压）——相对被消掉的 zstd 全量
 * 重解压小数个量级，README「规模边界」如实标注。
 */
export function projectSessionIncremental(
  newEvents: readonly DecodedEvent[],
  prior: ProjectionPrior,
  options: ProjectionOptions,
): SessionIncrementDelta {
  const dirId = options.dirId
  const sessionId = options.sessionId ?? prior.summary.sessionId
  const counter = options.exactCounter
  const countOne = (text: string): number => counter?.(text) ?? Math.ceil(text.length / CHARS_PER_TOKEN)

  // 先验 token 索引：新替换对覆盖旧 seq 时 aTokens 求和的回退面（无段行的
  // 事件在全量投影里 tokens 恒 0，缺行=0 同语义）。
  const priorTokensBySeq = new Map<number, number>()
  for (const row of prior.segments) priorTokensBySeq.set(row.seq, row.tokens)

  // 第一遍：新事件 tokens/text 索引。
  const tokensBySeq = new Map<number, number>()
  const textBySeq = new Map<number, string>()
  for (const event of newEvents) {
    const blocks = modelTextBlocks(event)
    let tokens = 0
    for (const block of blocks) tokens += countOne(block)
    tokensBySeq.set(event.seq, tokens)
    textBySeq.set(event.seq, blocks.join('\n'))
  }

  // 第二遍：新替换对 + 新 covered 集；turn/step 从水位滚动值续算。
  const replaces: ProjectionReplace[] = []
  const covered = new Set<number>()
  const pointerBySeq = new Map<number, { seq: number; turn: number; step: number }>()
  let scanTurn = prior.rollTurn
  let scanStep = prior.rollStep
  for (const event of newEvents) {
    const data = isRecord(event.data) ? (event.data as { turn?: unknown; step?: unknown }) : undefined
    if (event.type === 'step/start' && data !== undefined) {
      if (typeof data.turn === 'number') scanTurn = data.turn
      if (typeof data.step === 'number') scanStep = data.step
    }
    const range = parseSurfaceOp(event)
    if (range === undefined) continue
    let a = 0
    for (let seq = range.start; seq <= range.end; seq += 1) {
      a += tokensBySeq.get(seq) ?? priorTokensBySeq.get(seq) ?? 0
    }
    const b = tokensBySeq.get(event.seq) ?? 0
    replaces.push({
      seq: event.seq,
      startSeq: range.start,
      endSeq: range.end,
      aTokens: a,
      bTokens: b,
      kind: b > a ? 'recall' : 'compress',
      turn: scanTurn,
      step: scanStep,
      live: 1,
    })
    for (let seq = range.start; seq <= range.end; seq += 1) {
      covered.add(seq)
      pointerBySeq.set(seq, { seq: event.seq, turn: scanTurn, step: scanStep })
    }
  }

  // 新段行：onSurface/compressed 只由新 covered 决定（旧覆盖够不到新 seq）。
  // turn/step 归属：单遍滚动 map（全量投影 :406-424 同款，初值取水位滚动）。
  const turnStepBySeq = new Map<number, { turn: number; step: number }>()
  {
    let rollTurn = prior.rollTurn
    let rollStep = prior.rollStep
    for (const event of newEvents) {
      const data = isRecord(event.data) ? (event.data as { turn?: unknown; step?: unknown }) : undefined
      if (event.type === 'step/start' && data !== undefined) {
        if (typeof data.turn === 'number') rollTurn = data.turn
        if (typeof data.step === 'number') rollStep = data.step
      }
      turnStepBySeq.set(event.seq, { turn: rollTurn, step: rollStep })
    }
  }
  const segments: ProjectionSegment[] = []
  for (const event of newEvents) {
    const text = textBySeq.get(event.seq) ?? ''
    const searchText = stripInjectedBlocks(extractSearchEventText(event))
    if (text === '' && searchText === '') continue
    const pointer = pointerBySeq.get(event.seq)
    const at = turnStepBySeq.get(event.seq)
    const row: ProjectionSegment = {
      seq: event.seq,
      turn: at !== undefined ? at.turn : prior.rollTurn,
      step: at !== undefined ? at.step : prior.rollStep,
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
  }

  // 旧行翻转：新覆盖范围 ∩ 先验段/对。单向 1→0；surface 指针先置直接替身，
  // 链解析后精化。同批多对覆盖同一 seq：后对为最新替身（pointerBySeq 覆写语义）。
  const priorRowBySeq = new Map<number, PriorSegmentView>()
  for (const row of prior.segments) priorRowBySeq.set(row.seq, row)
  const priorReplaceBySeq = new Map<number, PriorReplaceView>()
  for (const pair of prior.replaces) priorReplaceBySeq.set(pair.seq, pair)
  const priorSegmentUpdates = new Map<number, IncrementSegmentUpdate>()
  const priorReplaceLiveOff: number[] = []
  const liveOffSeen = new Set<number>()
  let surfaceTokensDelta = 0
  let grossSavedDelta = 0
  for (const pair of replaces) {
    for (let seq = pair.startSeq; seq <= pair.endSeq; seq += 1) {
      const priorRow = priorRowBySeq.get(seq)
      if (priorRow !== undefined) {
        const existing = priorSegmentUpdates.get(seq)
        if (existing === undefined) {
          if (priorRow.onSurface === 1) surfaceTokensDelta -= priorRow.tokens
          priorSegmentUpdates.set(seq, {
            seq, onSurface: 0, compressed: 1,
            surfaceTokens: pair.bTokens, replacedBy: pair.seq,
          })
        } else {
          existing.surfaceTokens = pair.bTokens
          existing.replacedBy = pair.seq
        }
      }
      const priorPair = priorReplaceBySeq.get(seq)
      if (priorPair !== undefined && priorPair.live === 1 && !liveOffSeen.has(seq)) {
        liveOffSeen.add(seq)
        priorReplaceLiveOff.push(seq)
        if (priorPair.kind === 'compress') grossSavedDelta -= priorPair.aTokens - priorPair.bTokens
      }
    }
  }

  // 指针链解析（组合视图 = 先验行翻转后值 + 新行初值；全量投影 :385-400 同款，
  // hop undefined=悬空保留原值；幂等——终替未变时结果不变）。
  const combinedBySeq = new Map<number, {
    seq: number; tokens: number; compressed: number
    replacedBy: number | null; surfaceTokens: number | null
  }>()
  for (const row of prior.segments) {
    const flip = priorSegmentUpdates.get(row.seq)
    combinedBySeq.set(row.seq, flip !== undefined
      ? { seq: row.seq, tokens: row.tokens, compressed: flip.compressed, replacedBy: flip.replacedBy, surfaceTokens: flip.surfaceTokens }
      : { seq: row.seq, tokens: row.tokens, compressed: row.compressed, replacedBy: row.replacedBy, surfaceTokens: row.surfaceTokens })
  }
  for (const row of segments) {
    combinedBySeq.set(row.seq, {
      seq: row.seq, tokens: row.tokens, compressed: row.compressed,
      replacedBy: row.replacedBy, surfaceTokens: row.surfaceTokens,
    })
  }
  for (const row of combinedBySeq.values()) {
    if (row.compressed !== 1 || row.replacedBy === null) continue
    let hop = combinedBySeq.get(row.replacedBy)
    let guard = 0
    while (hop !== undefined && hop.compressed === 1 && hop.replacedBy !== null && guard < 64) {
      const next = combinedBySeq.get(hop.replacedBy)
      if (next === undefined || next === hop) break
      hop = next
      guard += 1
    }
    if (hop !== undefined) {
      row.surfaceTokens = hop.tokens
      row.replacedBy = hop.seq
    }
  }
  // 新行回写链解析终值；surfaceText 只在终替是新行时精化（先验行文本不在
  // 纯函数视界内——非契约面，读侧经 blocks 链派生）。
  const newRowBySeq = new Map<number, ProjectionSegment>()
  for (const row of segments) newRowBySeq.set(row.seq, row)
  for (const row of segments) {
    const final = combinedBySeq.get(row.seq)
    if (final === undefined) continue
    row.surfaceTokens = final.surfaceTokens
    row.replacedBy = final.replacedBy
    const terminal = newRowBySeq.get(final.replacedBy ?? -1)
    if (terminal !== undefined) row.surfaceText = terminal.text
  }
  // 先验行终值回写：翻转行 + 链尾连带行（终替被新覆盖 → 指向它的行续跳）。
  for (const row of prior.segments) {
    const final = combinedBySeq.get(row.seq)
    if (final === undefined) continue
    const flipped = priorSegmentUpdates.get(row.seq) !== undefined
    const changed = flipped
      || final.surfaceTokens !== row.surfaceTokens
      || final.replacedBy !== row.replacedBy
    if (!changed) continue
    priorSegmentUpdates.set(row.seq, {
      seq: row.seq,
      onSurface: flipped ? 0 : (row.onSurface as 0 | 1),
      compressed: flipped ? 1 : (row.compressed as 0 | 1),
      surfaceTokens: final.surfaceTokens,
      replacedBy: final.replacedBy,
    })
  }

  // 汇总合并：可加字段直接加；surfaceTokens/grossSaved 带翻转修正。
  let segmentTokens = prior.summary.segmentTokens
  let surfaceTokens = prior.summary.surfaceTokens + surfaceTokensDelta
  let grossSaved = prior.summary.grossSaved + grossSavedDelta
  let recallTokens = prior.summary.recallTokens
  let compressPairs = prior.summary.compressPairs
  let recallPairs = prior.summary.recallPairs
  let turnCount = prior.summary.turnCount
  for (const row of segments) {
    segmentTokens += row.tokens
    if (row.onSurface === 1) surfaceTokens += row.tokens
    if (row.turn > turnCount) turnCount = row.turn
  }
  for (const pair of replaces) {
    if (pair.kind === 'recall') {
      recallTokens += pair.bTokens
      recallPairs += 1
    } else {
      compressPairs += 1
      if (pair.live === 1) grossSaved += pair.aTokens - pair.bTokens
    }
  }
  let lastTimeMs = prior.summary.lastTimeMs
  let maxSeq = prior.summary.maxSeq
  for (const event of newEvents) {
    if (typeof event.time === 'number' && event.time > lastTimeMs) lastTimeMs = event.time
    if (event.seq > maxSeq) maxSeq = event.seq
  }
  // 标题按"最后一帧"语义：新帧有标题事件则新标题，否则保留先验标题。
  const freshTitle = extractTitleFromEvents(newEvents)
  const summary: SessionSummary = {
    sessionId,
    dirId,
    title: freshTitle !== '' ? freshTitle : prior.summary.title,
    cwd: prior.summary.cwd,
    eventCount: prior.summary.eventCount + newEvents.length,
    maxSeq,
    turnCount,
    segmentTokens,
    surfaceTokens,
    grossSaved,
    recallTokens,
    compressPairs,
    recallPairs,
    basis: prior.summary.basis,
    lastTimeMs,
    formatGeneration: prior.summary.formatGeneration,
  }
  return {
    newSegments: segments,
    newReplaces: replaces,
    priorSegmentUpdates: [...priorSegmentUpdates.values()],
    priorReplaceLiveOff,
    summary,
    // pass-2 滚动终值 = 新批之后的归属状态（空批=先验水位值原样续存）。
    rollTurn: scanTurn,
    rollStep: scanStep,
  }
}
