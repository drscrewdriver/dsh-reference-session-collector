/**
 * DRS 同步引擎(L3):会话目录发现 → watermark 预查 → 解码 → 投影落库 → interval 调度。
 *
 * **依赖倒置(里程碑 L3 mock 开发策略)**:本模块对 projection/schema 只依赖
 * {@link ProjectionPort} 与 {@link SyncStorePort} 两个结构化接口——宿主接线
 * (T5.1)时绑定 L1 真身,单测注入 mock。接口字段与 plan spec §纯投影核心
 * 逐字对齐,L1 落地时不得改形。
 *
 * 只读纪律:readFileSync 是唯一触碰会话文件的调用;插件自身的写只落
 * projection.db(经 store 端口)。归档集只读 ~/.dsh/storages/workspace.json
 * 的 global.archivedSessionIds(坏文件=无归档;对齐 steward archive-source
 * 语义,T7.0 对照表复核)。每会话处理后 setImmediate 让路(CCI 回填同款);
 * syncing 旗标防重入;interval 轮 stat 全命中即零解码零重写。
 *
 * @module dsh-reference-session-collector/sync
 */
import { existsSync, readdirSync, readFileSync, type Dirent } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  classifySessionHeader,
  decodeSessionLogBytes,
  readSessionGenerations,
  type DecodedEvent,
  type GenerationArtifact,
} from './session-file-decode.ts'
import { deepSeekV4TokenizerForModel } from './deepseek-v4-tokenizer.ts'
import type { CanonicalTextTokenCounter } from './token-count.ts'

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
}

/** replaceSession 附带元数据:水位 + 本轮归档态。 */
export interface SyncReplaceMeta {
  artifactBytes: number
  artifactMtimeMs: number
  archived: number
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
  }
}

export interface ProjectionSyncOptions {
  store: SyncStorePort
  project: ProjectionPort
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
  private readonly log: SyncLog
  private readonly counterMode: 'auto' | 'off'
  private syncing = false
  private lastResult: SyncResult | undefined
  /** 软跳 warn 一次性:sessionId+state 为键,重复轮不再刷屏。 */
  private readonly warnedSoftSkips = new Set<string>()

  constructor(options: ProjectionSyncOptions) {
    this.store = options.store
    this.project = options.project
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
  async syncAll(input: { dshHome?: string; limit?: number } = {}): Promise<SyncResult> {
    if (this.syncing) {
      return this.lastResult ?? emptyResult(true, 'unprobed')
    }
    this.syncing = true
    const startedAt = Date.now()
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
      }
      for (const found of discovered) {
        try {
          this.syncOne(found, { archivedSet, exact, result, dictEvicted })
        } catch (error) {
          result.failures.push({
            sessionId: found.dirSessionId,
            error: String((error as Error)?.message ?? error),
          })
        }
        // 让路(回填同款):每会话一片,宿主主线程可插话。
        await new Promise<void>(resolve => { setImmediate(resolve) })
      }
      // 删除剪枝(2026-10-20 用户定标):被宿主删掉的会话目录=UUID 级联清除
      // 对应投影,WAL 事务里删 segments/segments_fts/replaces/sessions 四表。
      // 守护:sessions 根缺失(整目录被搬走/挂盘故障)或发现被 limit 截断时
      // 不动手——宁可留陈旧行,绝不误删全集。
      const sessionsRootExists = existsSync(join(dshHome, 'sessions'))
      const discoveryTruncated = discovered.length >= limit
      if (sessionsRootExists && !discoveryTruncated) {
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
      this.store.setBlocksWatermark(this.store.blocksWatermark().current)
      this.lastResult = result
      return result
    } finally {
      this.syncing = false
    }
  }

  private syncOne(found: DiscoveredSessionLog, ctx: SyncOneContext): void {
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
    // readFileSync:唯一触碰会话文件的调用,永远没有写对偶。
    const log = decodeSessionLogBytes(readFileSync(found.artifact.path))
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
    const projection = this.project(log.events, {
      dirId: found.dirSessionId,
      ...(log.header === undefined ? {} : { header: log.header }),
      ...(ctx.exact === undefined ? {} : { exactCounter: ctx.exact }),
    })
    this.store.replaceSession(projection, {
      artifactBytes: found.artifact.bytes,
      artifactMtimeMs: found.artifact.mtimeMs,
      archived,
    })
    ctx.result.updated += 1
  }
}

// ─────────────────────────── interval 调度 ───────────────────────────

/** interval 轮缺省周期:steward 二期新鲜度(≤1 分钟)靠它,不靠手动 POST。 */
export const DEFAULT_SYNC_INTERVAL_MS = 30_000

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
