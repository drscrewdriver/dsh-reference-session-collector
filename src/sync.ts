/**
 * DRS 同步引擎(L3):会话目录发现 → watermark 预查 → 解码 → 投影落库 → interval 调度。
 *
 * **依赖倒置(里程碑 L3 mock 开发策略)**:本模块对 projection/schema 只依赖
 * {@link ProjectionPort} 与 {@link SyncStorePort} 两个结构化接口——宿主接线
 * (T5.1)时绑定 L1 真身,单测注入 mock。接口字段与 plan spec §纯投影核心
 * 逐字对齐,L1 落地时不得改形。
 *
 * 只读纪律:读会话文件是本模块唯一触碰宿主数据的动作(`fs/promises.readFile`,
 * issue #2 起改为异步);插件自身的写只落 projection.db(经 store 端口)。
 * 归档集只读 ~/.dsh/storages/workspace.json 的 global.archivedSessionIds
 * (坏文件=无归档;对齐 steward archive-source 语义,T7.0 对照表复核)。
 * **让路在两处**:每会话处理完一次(CCI 回填同款),以及单会话内部
 * (异步解码的帧/行批间 + 投影与落库前——issue #2,大会话不再占死主线程)。
 * syncing 旗标防重入;interval 轮 stat 全命中即零解码零重写。
 *
 * @module dsh-reference-session-collector/sync
 */
import { existsSync, readdirSync, readFileSync, type Dirent } from 'node:fs'
import { open, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  classifySessionHeader,
  readSessionGenerations,
  type DecodedEvent,
  type GenerationArtifact,
} from './session-file-decode.ts'
import { decodeSessionLogBytesAsync, decodeSessionLogTailAsync, finalRollState } from './session-decode-async.ts'
import { deepSeekV4TokenizerForModel } from './deepseek-v4-tokenizer.ts'
import type { CanonicalTextTokenCounter } from './token-count.ts'

/** 让一次事件循环（宏任务边界，宿主请求得以插话）。 */
function yieldToLoop(): Promise<void> {
  return new Promise<void>(resolve => { setImmediate(resolve) })
}

/**
 * 只读文件尾段（issue #3）：从字节偏移读到 EOF——增量路径 O(新增) 读取面
 * （对比 readFile 全量）。调用方保证 offset 落在帧边界（水位语义）。
 */
async function readLogTail(path: string, offset: number): Promise<Buffer> {
  const handle = await open(path, 'r')
  try {
    const { size } = await handle.stat()
    const length = size - offset
    if (length <= 0) return Buffer.alloc(0)
    const buf = Buffer.alloc(length)
    let read = 0
    while (read < length) {
      const { bytesRead } = await handle.read(buf, read, length - read, offset + read)
      if (bytesRead === 0) break
      read += bytesRead
    }
    return read === length ? buf : buf.subarray(0, read)
  } finally {
    await handle.close()
  }
}

/**
 * DRS 放行代次集（按文件头自声明 version 判，不猜宿主版本）。
 * 农场实锤（2026-10-20）：0.1.0-0.1.2 宿主自写代次=0，原 {3,4} 集
 * 在老线整库软跳（36/32/4 文件不投）。迁移包证据：v0→v1 恒等边，
 * 事件 type 体系 v0..v4 同形；v2→v3/v3→v4 才是字段级重写（迁移是
 * 宿主职责，DRS 只读不迁移）——故老代放行后内容块形状对不上时
 * text/search_text 自然为空不落行，**永不伪造**；generation 随会话
 * 如实入库可查。>4 未知代仍 fail-soft 软跳+一次性 warn。
 */
export const ACCEPTED_FORMAT_GENERATIONS: ReadonlySet<number> = new Set([0, 1, 2, 3, 4])

// ─────────────────────────── 目录发现 ───────────────────────────

/** 一个会话目录的发现事实:目录名 + 当前代产物。 */
export interface DiscoveredSessionLog {
  dirSessionId: string
  dir: string
  artifact: GenerationArtifact
}

/** 单轮发现的目录上限(walk 兜底,防异常目录树拖死主线程)。 */
export const DISCOVERY_LIMIT = 5000

/**
 * 单轮同步的时间预算缺省 20s(< interval 30s):一轮必须落在两次触发之间,
 * 否则轮轮相撞——syncAll 撞旗标直接 busy,等于什么都没做。
 */
export const DEFAULT_SYNC_BUDGET_MS = 20_000

export const SYNC_BUDGET_ENV = 'DSH_REFERENCE_SESSION_COLLECTOR_SYNC_BUDGET_MS'

/**
 * 解析单轮预算:env 缺省 20s;**0 = 不限**(首轮建全库用——注意它与 interval 的
 * 0=关闭语义相反);负数/非法 → 回落缺省(不把笔误变成失效)。
 */
export function resolveSyncBudgetMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[SYNC_BUDGET_ENV]
  if (raw === undefined || raw.trim() === '') return DEFAULT_SYNC_BUDGET_MS
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_SYNC_BUDGET_MS
  return Math.floor(parsed)
}

/**
 * 走 `~/.dsh/sessions` 发现会话目录(与 CCI discoverBackfillSessionLogs 同构):
 * 目录内无任何代次产物与暂存残留 → 视为路径中间层继续下钻;有当前代产物 →
 * 收录。上限截断,不抛。
 */
export function discoverSessionLogs(dshHome: string, limit: number = DISCOVERY_LIMIT): DiscoveredSessionLog[] {
  const root = join(dshHome, 'sessions')
  const out: DiscoveredSessionLog[] = []
  if (!existsSync(root)) return out
  const stack: string[] = [root]
  while (stack.length > 0 && out.length < limit) {
    const dir = stack.pop()
    if (dir === undefined) continue
    let entries: Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      if (out.length >= limit) break
      const path = join(dir, entry.name)
      const generations = readSessionGenerations(path)
      if (generations.canonical.length === 0 && generations.staging.length === 0) {
        stack.push(path)
        continue
      }
      const current = generations.current
      if (current === undefined) continue
      out.push({ dirSessionId: entry.name, dir: path, artifact: current })
    }
  }
  return out
}

/** DSH home 解析:显式入参 > DSH_HOME 环境变量 > ~/.dsh。 */
export function resolveDshHome(explicit?: string, env: NodeJS.ProcessEnv = process.env): string {
  if (explicit !== undefined && explicit !== '') return explicit
  const fromEnv = env['DSH_HOME']
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv
  return join(homedir(), '.dsh')
}

/** 投影库目录解析:显式入参 > DSH_REFERENCE_SESSION_COLLECTOR_DIR > ~/.dsh-reference-session-collector。 */
export function resolveIndexDir(explicit?: string, env: NodeJS.ProcessEnv = process.env): string {
  if (explicit !== undefined && explicit !== '') return explicit
  const fromEnv = env['DSH_REFERENCE_SESSION_COLLECTOR_DIR']
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv
  return join(homedir(), '.dsh-reference-session-collector')
}

// ─────────────────────────── 归档集(只读跟随) ───────────────────────────

/**
 * 读归档会话 id 集:~/.dsh/storages/workspace.json 的
 * `global.archivedSessionIds`。任何形状不符/文件不可读 → 空集(无归档),
 * 绝不抛——归档只是检索域标志,不配阻塞同步。
 */
export function readArchivedSessionIds(dshHome: string): ReadonlySet<string> {
  const path = join(dshHome, 'storages', 'workspace.json')
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown
  } catch {
    return new Set()
  }
  if (typeof parsed !== 'object' || parsed === null) return new Set()
  const globalSection = (parsed as Record<string, unknown>)['global']
  if (typeof globalSection !== 'object' || globalSection === null) return new Set()
  const ids = (globalSection as Record<string, unknown>)['archivedSessionIds']
  if (!Array.isArray(ids)) return new Set()
  const out = new Set<string>()
  for (const id of ids) {
    if (typeof id === 'string' && id !== '') out.add(id)
  }
  return out
}

// ─────────────────────────── 依赖端口(L1 接线面) ───────────────────────────

/** 投影核心调用选项(与 L1 projectSessionEvents 第二参逐字对齐)。 */
export interface ProjectionCallOptions {
  dirId: string
  header?: Record<string, unknown>
  exactCounter?: CanonicalTextTokenCounter
}

/**
 * 投影端口:同步引擎把解码事件交给投影核心,产物对 sync 不透明
 * (由 store 端口解释)。L1 落地后由 index.ts 绑定 projectSessionEvents。
 */
export type ProjectionPort = (
  events: readonly DecodedEvent[],
  options: ProjectionCallOptions,
) => unknown

/** sync 关心的 store 水位行(真身 schema 的窄投影)。 */
export interface SyncWatermark {
  sessionId: string
  artifactBytes: number
  artifactMtimeMs: number
  archived: number
  /** 帧级增量水位面(issue #3,真身=sessions 行 frame_* 列);undefined=旧 mock/无水位。 */
  frameOffset?: number
  frameConsumed?: number
  frameRollTurn?: number
  frameRollStep?: number
  frameBasis?: string
  frameArtifact?: string
  /** 建水位时的 header 自声明代次(与产物文件名版本对照,漂移=回退全量)。 */
  formatGeneration?: number
}

/** 帧级增量水位(sync 侧形状;真身=FrameWatermark 列值,经端口适配)。 */
export interface SyncFrameWatermark {
  /** 下一帧字节偏移(绝对);torn 起点或 EOF。 */
  frameOffset: number
  /** 已投影事件数(seq 稠密 0..consumed-1,含全量路径的 torn 抢救行)。 */
  frameConsumed: number
  /**
   * 水位处 turn/step 滚动归属。全量路径直接给值;增量路径省略(-)
   * ——由投影 delta 携带终值,端口适配层合并。
   */
  frameRollTurn?: number
  frameRollStep?: number
  /** token 口径档('chars/4'|'ds-token'),与本轮不一致→回退全量。 */
  frameBasis: string
  /** 水位所属产物文件名(换代=新文件=旧偏移作废)。 */
  frameArtifact: string
}

/** replaceSession 附带元数据:水位 + 本轮归档态。 */
export interface SyncReplaceMeta {
  artifactBytes: number
  artifactMtimeMs: number
  archived: number
  /** 帧级水位(全量成功后建立;明文产物/失败不写=undefined→下次仍全量)。 */
  frame?: SyncFrameWatermark
}

/**
 * 投影库端口。真身 = schema.ts 的 ProjectionStore(L1);单测注入内存 mock。
 * 七个方法恰好是 sync 需要的全部写/读面——真身实现不得要求更多。
 */
export interface SyncStorePort {
  /** 目录水位预查(stat 命中免解码的关键);无记录返回 undefined。 */
  getSessionByDir(dirId: string): SyncWatermark | undefined
  /** 全会话重写式落库(事务内 DELETE+INSERT,真身职责);projection 不透明。 */
  replaceSession(projection: unknown, meta: SyncReplaceMeta): void
  /** 仅翻归档旗标(stat 命中的会话随归档集变更走这里,免解码)。 */
  setSessionArchived(sessionId: string, archived: number): void
  /** 已投影名册枚举(删除剪枝对照面):dirId=发现键,sessionId=删除键。 */
  listProjectedDirs(): { dirId: string; sessionId: string }[]
  /** 级联清除一个会话的投影(WAL 事务内 segments/fts/replaces/sessions 四表+常驻 Map)。 */
  deleteSession(sessionId: string): void
  /**
   * R5(v5 字块字典水位):current=blocks 现 max(rowid, 空典=0),
   * last=上轮持久化值(meta 缺失=0)。current<last=字典被清/换——
   * hash 引用悬空,stat 命中也不得 skip(防静默缺块)。
   */
  blocksWatermark(): { current: number; last: number }
  /** 轮尾持久化本轮字典水位(下轮 skip 判定基线)。 */
  setBlocksWatermark(value: number): void
  /**
   * 帧级增量先验状态(issue #3):会话现状不透明载荷(sessions 行窄投影 +
   * 全量 segments/replaces 窄视图 + 水位滚动值),经 projectIncremental 消费。
   * O(会话行数) 纯 SQL 读,无解压。无行=undefined。
   */
  getSessionState(sessionId: string): unknown | undefined
  /** 帧级增量落库:delta 与 prior 同族不透明(真身=schema applyIncrement)。 */
  applyIncrement(sessionId: string, delta: unknown, meta: SyncReplaceMeta): void
}

export type SyncLog = (level: 'info' | 'warn', message: string, ...args: unknown[]) => void

/** DS 精确计数器探测:flash → pro 逐个试;全缺席 undefined(chars/4 降级)。 */
export function resolveExactCounter(): CanonicalTextTokenCounter | undefined {
  for (const modelId of ['deepseek-v4-flash', 'deepseek-v4-pro']) {
    const tokenizer = deepSeekV4TokenizerForModel(modelId)
    if (tokenizer !== undefined) return (text: string) => tokenizer.countText(text)
  }
  return undefined
}

// ─────────────────────────── 同步引擎 ───────────────────────────

/** 长度口径:ds-token=精确词表;chars/4=如实降级;unprobed=本轮未探测(busy 空转)。 */
export type SyncBasis = 'ds-token' | 'chars/4' | 'unprobed'

export interface SyncFailure {
  sessionId: string
  error: string
}

export interface SyncSoftSkip {
  sessionId: string
  state: string
}

export interface SyncResult {
  ok: boolean
  /** true=本轮撞上 syncing 旗标,直接返回(不计入进度)。 */
  busy: boolean
  totalDiscovered: number
  updated: number
  skipped: number
  softSkips: SyncSoftSkip[]
  failures: SyncFailure[]
  /**
   * 本轮被删除剪枝的 sessionId 列表:宿主删会话=磁盘目录消失,投影绝不
   * 留陈旧行(真身 deleteSession 走 WAL 事务级联清四表)。守护条件见
   * syncAll 剪枝段——sessions 根缺失或发现截断时**不动手**。
   */
  pruned: string[]
  basis: SyncBasis
  durationMs: number
  /**
   * 本轮因时间预算耗尽而提前收手 ⇒ **不完整轮**。`totalDiscovered` 仍是全集,
   * 实际处理了 `updated+skipped+softSkips+failures` 个,其余在 `deferred`。
   * 不完整轮**禁止剪枝**(没扫到 ≠ 已被删除),并靠 `resumeCursor` 下轮续扫。
   */
  budgetExhausted: boolean
  /** 本轮未处理的会话数(0 = 本轮扫完);下轮从断点续。 */
  deferred: number
  /**
   * 本轮最慢的一个会话(issue #2 诉求 3:定位卡顿)。只统计真正解码的会话,
   * stat 命中跳过的不参与;整轮零解码时为 undefined。
   */
  slowest?: { sessionId: string; bytes: number; ms: number }
}

function emptyResult(busy: boolean, basis: SyncBasis): SyncResult {
  return {
    ok: true,
    busy,
    totalDiscovered: 0,
    updated: 0,
    skipped: 0,
    softSkips: [],
    failures: [],
    pruned: [],
    basis,
    durationMs: 0,
    budgetExhausted: false,
    deferred: 0,
  }
}

export interface ProjectionSyncOptions {
  store: SyncStorePort
  project: ProjectionPort
  /**
   * 帧级增量投影端口(issue #3):先验不透明载荷 + 新事件 → 落库载荷(不透明,
   * 真身=projectSessionIncremental)。缺席=增量面整体停用(全量路径照旧)。
   */
  projectIncremental?: (newEvents: readonly DecodedEvent[], prior: unknown, options: ProjectionCallOptions) => unknown
  /** 缺省 console.warn 单臂(info 静默——宿主半另有 logger 接线面)。 */
  log?: SyncLog
  /** 'auto'(缺省)=探测 DS 精确计数器;'off'=强制 chars/4(单测/省资产加载)。 */
  counter?: 'auto' | 'off'
}

interface SyncOneContext {
  archivedSet: ReadonlySet<string>
  exact: CanonicalTextTokenCounter | undefined
  result: SyncResult
  /** R5:本轮字典水位倒退(清/换)——stat 命中也强制重投。 */
  dictEvicted: boolean
}

export class ProjectionSync {
  private readonly store: SyncStorePort
  private readonly project: ProjectionPort
  private readonly projectIncremental: ProjectionSyncOptions['projectIncremental']
  private readonly log: SyncLog
  private readonly counterMode: 'auto' | 'off'
  private syncing = false
  private lastResult: SyncResult | undefined
  /** 软跳 warn 一次性:sessionId+state 为键,重复轮不再刷屏。 */
  private readonly warnedSoftSkips = new Set<string>()
  /**
   * 预算中断的续扫游标(discovered 下标)。只在内存:重启归零天然复位,
   * 不需要持久化——它是调度优化,不是事实源。
   */
  private resumeCursor = 0

  constructor(options: ProjectionSyncOptions) {
    this.store = options.store
    this.project = options.project
    this.projectIncremental = options.projectIncremental
    this.counterMode = options.counter ?? 'auto'
    this.log = options.log ?? (() => {})
  }

  get isSyncing(): boolean {
    return this.syncing
  }

  /** 最近一轮完整结果(busy 空转轮不覆盖它);POST sync 响应体用它。 */
  get lastSyncResult(): SyncResult | undefined {
    return this.lastResult
  }

  /**
   * 一轮增量同步:发现 → 逐会话(水位预查/软跳/投影/落库/让路)。
   * 重入直接返回 busy(不排队——下一轮 interval 自然补上)。
   */
  async syncAll(input: { dshHome?: string; limit?: number; budgetMs?: number } = {}): Promise<SyncResult> {
    if (this.syncing) {
      return this.lastResult ?? emptyResult(true, 'unprobed')
    }
    this.syncing = true
    const startedAt = Date.now()
    const budgetMs = input.budgetMs ?? resolveSyncBudgetMs()
    // 0 = 不限:用 Infinity 而不是 0,避开"0 毫秒预算立刻超时"的写法歧义
    const deadline = budgetMs > 0 ? startedAt + budgetMs : Number.POSITIVE_INFINITY
    try {
      const dshHome = resolveDshHome(input.dshHome)
      const archivedSet = readArchivedSessionIds(dshHome)
      const limit = input.limit ?? DISCOVERY_LIMIT
      const discovered = discoverSessionLogs(dshHome, limit)
      const exact = this.counterMode === 'off' ? undefined : resolveExactCounter()
      const basis: SyncBasis = exact !== undefined ? 'ds-token' : 'chars/4'
      // R5 水位对照:字典条目比上轮持久化时少=发生过驱逐(清典/换典)，
      // 而 artifact 的 size/mtime 未变——纯 stat skip 会留下悬空 hash 引用。
      const dict = this.store.blocksWatermark()
      const dictEvicted = dict.current < dict.last
      const result: SyncResult = {
        ok: true, busy: false, totalDiscovered: discovered.length,
        updated: 0, skipped: 0, softSkips: [], failures: [], pruned: [], basis, durationMs: 0,
        budgetExhausted: false, deferred: 0,
      }
      // 环状起扫:上轮断在 resumeCursor,本轮从那里继续。不轮转的话预算总在 walk
      // 头部耗尽 ⇒ 尾部会话永远轮不到,而头部每轮 stat-skip 全命中 —— 表面上
      // "同步一直在跑、一直 ok",实际是活锁。
      const start = discovered.length === 0 ? 0 : this.resumeCursor % discovered.length
      const order = discovered.length === 0 ? [] : [...discovered.slice(start), ...discovered.slice(0, start)]
      let handled = 0
      for (const found of order) {
        /**
         * 预算只拦"尚未开始"的会话,而且**第一个会话总是放行**:预算在会话**边界**
         * 检查,单会话内部不会被打断(异步分片让路只是把控制权交还事件循环,
         * 不改变"这一轮要不要开始这个会话"的判断);若连第一个也拦,预算小于单
         * 会话耗时时会出现零进度轮——游标不前进,又是一种活锁。
         */
        if (handled > 0 && Date.now() >= deadline) {
          result.budgetExhausted = true
          break
        }
        try {
          await this.syncOne(found, { archivedSet, exact, result, dictEvicted })
        } catch (error) {
          result.failures.push({
            sessionId: found.dirSessionId,
            error: String((error as Error)?.message ?? error),
          })
        }
        handled += 1
        // 让路(回填同款):每会话一片,宿主主线程可插话。
        await yieldToLoop()
      }
      if (discovered.length > 0) this.resumeCursor = (start + handled) % discovered.length
      result.deferred = result.budgetExhausted ? discovered.length - handled : 0
      // 删除剪枝(2026-10-20 用户定标):被宿主删掉的会话目录=UUID 级联清除
      // 对应投影,WAL 事务里删 segments/segments_fts/replaces/sessions 四表。
      // 守护:sessions 根缺失(整目录被搬走/挂盘故障)或发现被 limit 截断时
      // 不动手——宁可留陈旧行,绝不误删全集。
      const sessionsRootExists = existsSync(join(dshHome, 'sessions'))
      const discoveryTruncated = discovered.length >= limit
      // 预算中断同样是**不完整轮**:discovered 只走过一部分,"这轮没扫到"绝不等于
      // "宿主已删除"。误删不可逆,所以宁可不剪枝、留陈旧行。
      if (sessionsRootExists && !discoveryTruncated && !result.budgetExhausted) {
        const aliveDirs = new Set(discovered.map(found => found.dirSessionId))
        for (const projected of this.store.listProjectedDirs()) {
          if (aliveDirs.has(projected.dirId)) continue
          try {
            this.store.deleteSession(projected.sessionId)
            result.pruned.push(projected.sessionId)
            this.log('info', 'drs sync: pruned deleted session %s (dir %s gone)',
              projected.sessionId, projected.dirId)
          } catch (error) {
            result.failures.push({
              sessionId: projected.sessionId,
              error: `prune failed: ${String((error as Error)?.message ?? error)}`,
            })
          }
        }
      }
      result.durationMs = Date.now() - startedAt
      // R5:轮尾持久化水位(重投已使字典增长;取循环后的现值写入)。
      // 预算中断也要写:跳过它会让下一轮把"自己没扫完"误判成"字典被驱逐"而全量重投。
      this.store.setBlocksWatermark(this.store.blocksWatermark().current)
      // issue #2 诉求 3:每轮耗时与最慢会话可观测。只在真正动过手的轮次打,
      // 全 stat 命中的空转轮不刷屏。
      if (result.updated > 0 || result.budgetExhausted || result.failures.length > 0) {
        const slowest = result.slowest === undefined
          ? 'none'
          : `${result.slowest.sessionId}(${result.slowest.bytes}B,${result.slowest.ms}ms)`
        this.log('info', 'drs sync: round updated=%d skipped=%d deferred=%d dur=%dms slowest=%s',
          result.updated, result.skipped, result.deferred, result.durationMs, slowest)
      }
      this.lastResult = result
      return result
    } finally {
      this.syncing = false
    }
  }

  /**
   * 同步一个会话（issue #2：**异步分片**，不再独占主线程）。
   *
   * 旧实现是纯同步方法：`readFileSync` + 同步解码 + 同步投影 + 同步落库一气
   * 呵成，62MB 大会话期间宿主请求全部排队（issue 实测发消息要等几十秒）。
   * 现在四段各自让路：
   * 1. 读取走 `fs/promises`（线程池，不占主线程）；
   * 2. 解码走 {@link decodeSessionLogBytesAsync}（异步 zstd + 帧/行批间让路）；
   * 3. 投影前让路一次（投影端口保持同步签名，真分批留给后续的帧级增量方案）；
   * 4. 落库前让路一次（SQLite 事务必须原子，保持同步）。
   * @param found - 发现事实。
   * @param ctx - 本轮共享上下文。
   */
  private async syncOne(found: DiscoveredSessionLog, ctx: SyncOneContext): Promise<void> {
    const record = this.store.getSessionByDir(found.dirSessionId)
    const statHit = !ctx.dictEvicted
      && record !== undefined
      && record.artifactBytes === found.artifact.bytes
      && record.artifactMtimeMs === found.artifact.mtimeMs
    // 归档翻转对 stat 命中的会话照常生效(免解码;新落库会话随 meta 携带)。
    if (record !== undefined) {
      const archived = ctx.archivedSet.has(record.sessionId) ? 1 : 0
      if (record.archived !== archived) {
        this.store.setSessionArchived(record.sessionId, archived)
      }
    }
    if (statHit) {
      ctx.result.skipped += 1
      return
    }
    const sessionStartedAt = Date.now()
    // ── 帧级增量路径(issue #3):水位有效时只解尾段新帧,O(新增) 读取/解压/投影 ──
    // 守卫链任一不满足即落回全量(全量是正确性兜底,增量只是优化)。
    if (
      record !== undefined && this.projectIncremental !== undefined && !ctx.dictEvicted
      && record.frameOffset !== undefined && record.frameOffset >= 0
      && record.frameConsumed !== undefined
      && record.frameBasis === (ctx.exact !== undefined ? 'ds-token' : 'chars/4')
      && record.frameArtifact === found.artifact.name
      // 代次守卫不对照 artifact.version：gen-0 文件名无版本号而 header 自声明 v4
      // 是宿主常态（e2e fixture 同构），两者本来就不等；同文件 append-only 下
      // header 不会变，文件身份已由 frameArtifact（换代=新文件名）把守。
      && found.artifact.bytes >= record.frameOffset
    ) {
      try {
        // 守卫链已证 frameOffset/frameConsumed 有值;exactOptional 下显式收窄。
        const wm: SyncWatermark & { frameOffset: number; frameConsumed: number } = {
          ...record,
          frameOffset: record.frameOffset,
          frameConsumed: record.frameConsumed,
        }
        const handled = await this.syncOneIncremental(found, wm, ctx, sessionStartedAt)
        if (handled) return
      } catch (error) {
        this.log('warn', 'drs sync: incremental failed for %s (%s) — full resync',
          found.dirSessionId, String((error as Error)?.message ?? error))
      }
    }
    // ── 全量路径(回退兜底 + 水位建立):行为与 0.2.11 逐字一致 ──
    // 读取:唯一触碰会话文件的调用,永远没有写对偶。异步版走线程池。
    const bytes = await readFile(found.artifact.path)
    const log = await decodeSessionLogBytesAsync(bytes)
    const verdict = classifySessionHeader(log.header, ACCEPTED_FORMAT_GENERATIONS)
    if (verdict.state !== 'known') {
      const key = `${found.dirSessionId}:${verdict.state}`
      if (!this.warnedSoftSkips.has(key)) {
        this.warnedSoftSkips.add(key)
        this.log('warn', 'drs sync: skip session %s (%s)', found.dirSessionId, verdict.state)
      }
      ctx.result.softSkips.push({ sessionId: found.dirSessionId, state: verdict.state })
      return
    }
    const headerId = log.header?.['id']
    const sessionId = typeof headerId === 'string' && headerId.trim() !== '' ? headerId.trim() : found.dirSessionId
    const archived = ctx.archivedSet.has(sessionId) ? 1 : 0
    // 投影前让路:投影端口仍是同步实现,先把控制权交还宿主再进入。
    await yieldToLoop()
    const projection = this.project(log.events, {
      dirId: found.dirSessionId,
      ...(log.header === undefined ? {} : { header: log.header }),
      ...(ctx.exact === undefined ? {} : { exactCounter: ctx.exact }),
    })
    // 落库前让路:SQLite 事务必须原子,但进入事务之前不该和别的请求抢。
    await yieldToLoop()
    // 全量成功后建立帧级水位(issue #3):zstd 产物记 offset(EOF 或 torn 起点——
    // torn 区域会被宿主重写,水位停在 torn 前,重写区由增量路径按 seq 前缀去重);
    // 明文产物(frames=0)不建——下次仍全量。consumed 含 torn 抢救行(它们已投影)。
    const roll = finalRollState(log.events)
    const frame: SyncFrameWatermark | undefined = log.frames > 0 ? {
      frameOffset: log.tornStart ?? bytes.length,
      frameConsumed: log.events.length,
      frameRollTurn: roll.turn,
      frameRollStep: roll.step,
      frameBasis: ctx.exact !== undefined ? 'ds-token' : 'chars/4',
      frameArtifact: found.artifact.name,
    } : undefined
    this.store.replaceSession(projection, {
      artifactBytes: found.artifact.bytes,
      artifactMtimeMs: found.artifact.mtimeMs,
      archived,
      ...(frame !== undefined ? { frame } : {}),
    })
    ctx.result.updated += 1
    this.noteSlowest(ctx.result, found, sessionStartedAt)
  }

  /**
   * 帧级增量同步单会话(issue #3)。返回 false = 本路径放弃(调用方落回全量);
   * true = 已落库(含"零新事件仅推进水位"轮——mtime 漂移但无新帧)。
   *
   * 守卫链(syncOne 已判):水位存在/basis 同口径/产物同名/代次一致/文件未回缩。
   * 本方法内的放弃面:先验行缺失、尾段起点非帧边界、解码问题、fresh 不连续。
   */
  private async syncOneIncremental(
    found: DiscoveredSessionLog,
    wm: SyncWatermark & { frameOffset: number; frameConsumed: number },
    ctx: SyncOneContext,
    sessionStartedAt: number,
  ): Promise<boolean> {
    const sessionId = wm.sessionId
    const prior = this.store.getSessionState(sessionId)
    if (prior === undefined) return false
    // 读取:只读尾段(frame_offset 起,恰是帧边界)——O(新增) 字节,走线程池。
    const tail = await readLogTail(found.artifact.path, wm.frameOffset)
    await yieldToLoop()
    const tailRead = await decodeSessionLogTailAsync(tail)
    if (!tailRead.boundaryOk || tailRead.issues.length > 0) return false
    // 去重切分:seq < consumed = 宿主 torn 重写区的已投影回放,按 seq 前缀丢弃;
    // fresh = 真新事件。尾段事件内部稠密 ⇒ 有重复时其末尾必恰为 consumed-1,
    // fresh 必须从 consumed 稠密续起(否则 = 字节事实与水位矛盾,回退全量)。
    const consumed = wm.frameConsumed
    const fresh: DecodedEvent[] = []
    for (const event of tailRead.events) {
      if (event.seq < consumed) continue
      fresh.push(event)
    }
    if (fresh.length > 0 && fresh[0] !== undefined && fresh[0].seq !== consumed) return false
    const archived = ctx.archivedSet.has(sessionId) ? 1 : 0
    // 投影前让路:增量投影端口仍是同步实现(纯函数),先把控制权交还宿主。
    await yieldToLoop()
    const delta = this.projectIncremental!(fresh, prior, {
      dirId: found.dirSessionId,
      ...(ctx.exact === undefined ? {} : { exactCounter: ctx.exact }),
    })
    // 落库前让路:SQLite 事务必须原子。
    await yieldToLoop()
    this.store.applyIncrement(sessionId, delta, {
      artifactBytes: found.artifact.bytes,
      artifactMtimeMs: found.artifact.mtimeMs,
      archived,
      frame: {
        frameOffset: wm.frameOffset + tailRead.consumedEndOffset,
        frameConsumed: consumed + fresh.length,
        // roll 由 delta 携带(投影侧终值,端口适配层合并进 FrameWatermark)。
        frameBasis: ctx.exact !== undefined ? 'ds-token' : 'chars/4',
        frameArtifact: found.artifact.name,
      },
    })
    ctx.result.updated += 1
    this.noteSlowest(ctx.result, found, sessionStartedAt)
    return true
  }

  /** 记录本轮最慢会话（issue #2 诉求 3：可观测）。 */
  private noteSlowest(result: SyncResult, found: DiscoveredSessionLog, startedAt: number): void {
    const ms = Date.now() - startedAt
    if (result.slowest !== undefined && result.slowest.ms >= ms) return
    result.slowest = { sessionId: found.dirSessionId, bytes: found.artifact.bytes, ms }
  }
}

// ─────────────────────────── interval 调度 ───────────────────────────

/**
 * interval 轮缺省周期。
 *
 * issue #2 前是 30s,理由是「steward 二期新鲜度(≤1 分钟)靠它,不靠手动 POST」。
 * 但 30s 在大库(issue 实测 projection.db 约 3GB / 数千会话)上会把主线程反复
 * 拖进全量重扫,代价远大于那 1 分钟新鲜度收益,故缺省改为 5 分钟。
 * 需要旧行为的用户显式设 `DSH_REFERENCE_SESSION_COLLECTOR_SYNC_INTERVAL_MS=30000`
 * (issue 报告人正是用 env 调到 10 分钟规避的)。
 */
export const DEFAULT_SYNC_INTERVAL_MS = 300_000

export const SYNC_INTERVAL_ENV = 'DSH_REFERENCE_SESSION_COLLECTOR_SYNC_INTERVAL_MS'

/** 解析轮询周期:env 缺省 30s;0=关闭(纯手动);非法值回落缺省。 */
export function resolveSyncIntervalMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[SYNC_INTERVAL_ENV]
  if (raw === undefined || raw.trim() === '') return DEFAULT_SYNC_INTERVAL_MS
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_SYNC_INTERVAL_MS
  return Math.floor(parsed)
}

/**
 * interval 的目标面:结构最小型(单测可注返回部分结果的 mock;真身
 * ProjectionSync 的 syncAll 结构兼容)。轮内只调用、不解读结果。
 */
export interface IntervalSyncTarget {
  syncAll: (input?: { dshHome?: string; limit?: number }) => Promise<unknown>
}

/**
 * 启动 interval 同步,返回 dispose(清定时器)。
 * 轮与启动首轮/syncing 旗标不并发:syncAll 撞旗标返回 busy,无害。
 * 周期 0(或负/非法)→ 不建定时器,dispose 为空操作。
 */
export function startIntervalSync(
  target: IntervalSyncTarget,
  options: { intervalMs?: number } = {},
): () => void {
  const intervalMs = options.intervalMs ?? resolveSyncIntervalMs()
  if (!(intervalMs > 0)) return () => {}
  const timer = setInterval(() => {
    void target.syncAll().catch((error: unknown) => {
      console.warn('[drs] interval sync failed:', error)
    })
  }, intervalMs)
  timer.unref?.()
  return () => { clearInterval(timer) }
}
