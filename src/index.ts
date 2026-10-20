/**
 * dsh-reference-session 宿主半（T5.1）。
 *
 * - `export const inject = ['webServer']`（唯一声明；webStartup 不列，老线兼容
 *   ——trustedHosts 经 ctx.get 双名回退链 best-effort 读取）。
 * - 单条 fenced 路由 `GET/POST /api/dsh-reference-session`，op 分发
 *   status / sessions / session / surface / recall / search / sync。
 * - 双通道注册（direct `ctx.get` + `ctx.inject` 迟到臂），duplicate-route
 *   容错（同 lib 双挂载 = 成功），`ctx.effect` 注销。
 * - webServer 缺席时插件本体照常同步，仅 HTTP 面缺失（fail-soft）。
 * - 启动延迟 2.5s 首轮 syncAll + interval 轮（缺省 30s，env 可关）；
 *   dispose 关库清定时器。
 *
 * 只读纪律：本文件不直接触碰会话文件——全部经 ProjectionSync 端口。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  createQueryContext,
  listSessions,
  recallReport,
  search,
  searchGrouped,
  sessionDetail,
  status,
  surfaceLedger,
  type QueryContext,
} from './surface.ts'
import { openProjectionStore, type ProjectionStore } from './schema.ts'
import { projectSessionEvents } from './projection.ts'
import type { SessionProjection } from './projection.ts'

// steward 式导出面：库/投影/切词/查询/同步 API 对消费方（与单测）可导入。
export { openProjectionStore, reloadSummaries, PROJECTION_SCHEMA_VERSION,
  type ProjectionStore, type SessionRow } from './schema.ts'
export { projectSessionEvents, extractSearchEventText, extractTitleFromEvents,
  type SessionProjection, type ProjectionSegment, type ProjectionReplace,
  type SessionSummary, type ProjectionOptions, type ExactCounter } from './projection.ts'
export { segmentForIndex, segmentQueryTerm, sanitizeFtsQuery } from './segment.ts'
export { stripInjectedBlocks, INJECTED_BLOCK_TAGS } from './strip-injected.ts'
export { createQueryContext, status, listSessions, sessionDetail, surfaceLedger,
  recallReport, search, searchGrouped, buildSearchSnippet, LedgerCache, LEDGER_LRU_CAP,
  type QueryContext, type GroupedSearchRequest, type GroupedSearchHit } from './surface.ts'
export { ProjectionSync, discoverSessionLogs, resolveDshHome, resolveIndexDir,
  resolveExactCounter, readArchivedSessionIds, startIntervalSync, resolveSyncIntervalMs,
  DEFAULT_SYNC_INTERVAL_MS, SYNC_INTERVAL_ENV, DISCOVERY_LIMIT,
  type SyncResult, type SyncStorePort, type ProjectionPort } from './sync.ts'
export { decodeSessionLogBytes, decodeSessionLogFile, classifySessionHeader,
  readSessionGenerations, generationLogFilename,
  type DecodedEvent, type SessionLogRead } from './session-file-decode.ts'
import {
  ProjectionSync,
  resolveIndexDir,
  startIntervalSync,
  type SyncReplaceMeta,
  type SyncStorePort,
  type SyncWatermark,
} from './sync.ts'

/** 本插件声明的宿主服务（唯一声明；webStartup 走 ctx.get 回退臂）。 */
export const inject = ['webServer']

/** API 路由前缀（fenced 单条）。 */
export const DRS_API_PATH = '/api/dsh-reference-session'

/** 启动首轮同步延迟（ms）——让路给宿主冷启动。 */
export const BOOT_SYNC_DELAY_MS = 2_500

/** webServer 服务面（结构化镜像，零 value import）。 */
interface WebServerLike {
  register(route: {
    kind: 'exact' | 'prefix'
    path: string
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
  }): (() => void) | void
}

/** web runtime 服务面：绑定派生的可信 authority。 */
interface WebStartupLike {
  trustedHosts: readonly string[]
}

/** `webServer.register` 对同串 exact 路由抛 duplicate——双挂载视为成功（CCI 同款）。 */
const isDuplicateRouteError = (error: unknown): boolean =>
  String((error as Error)?.message ?? error).includes('duplicate exact route')

function asWebServer(value: unknown): WebServerLike | undefined {
  if (value === null || typeof value !== 'object') return undefined
  return typeof (value as WebServerLike).register === 'function' ? (value as WebServerLike) : undefined
}

function writeJson(res: ServerResponse, code: number, body: unknown): void {
  try {
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-cache' })
  } catch { /* 已发头的 mock res（单测面）忽略 */ }
  res.end(JSON.stringify(body))
}

/** Host 头信任门（steward isTrustedApiRequest 同款简化）：trustedHosts 缺席=放行。 */
function isTrustedRequest(req: IncomingMessage, trustedHosts: readonly string[] | undefined): boolean {
  if (trustedHosts === undefined || trustedHosts.length === 0) return true
  const host = req.headers['host']
  if (typeof host !== 'string') return false
  return trustedHosts.some(trusted => trusted.toLowerCase() === host.toLowerCase())
}

/** sync 端口 → ProjectionStore 真身适配（dir 水位经常驻 Map 扫描）。 */
export function createStorePort(store: ProjectionStore): SyncStorePort {
  return {
    getSessionByDir(dirId: string): SyncWatermark | undefined {
      for (const row of store.summaries.values()) {
        if (row.dir_id !== dirId) continue
        return {
          sessionId: row.session_id,
          artifactBytes: row.artifact_bytes,
          artifactMtimeMs: row.artifact_mtime_ms,
          archived: row.archived,
        }
      }
      return undefined
    },
    replaceSession(projection: unknown, meta: SyncReplaceMeta): void {
      store.replaceSession(projection as SessionProjection, meta.artifactBytes, meta.artifactMtimeMs, {
        archived: meta.archived === 1 ? 1 : 0,
      })
    },
    setSessionArchived(sessionId: string, archived: number): void {
      store.setArchived(sessionId, archived === 1 ? 1 : 0)
    },
    listProjectedDirs(): { dirId: string; sessionId: string }[] {
      const out: { dirId: string; sessionId: string }[] = []
      for (const row of store.summaries.values()) {
        out.push({ dirId: row.dir_id, sessionId: row.session_id })
      }
      return out
    },
    deleteSession(sessionId: string): void {
      store.deleteSession(sessionId)
    },
  }
}

/** 请求处理依赖（导出面便于路由单测直调）。 */
export interface DrsHandlerDeps {
  query: QueryContext
  sync: { syncAll: () => Promise<unknown>; lastSyncResult: unknown; isSyncing: boolean }
  trustedHosts?: readonly string[]
}

/**
 * 省参自解析（CCI 无参臂契约）：max(last_time_ms) 的最活跃会话；
 * 同刻按 synced_at 新者；空库返回 undefined（调用侧 400）。
 */
function resolveLatestSessionId(query: QueryContext): string | undefined {
  let bestId: string | undefined
  let bestTime = -1
  let bestSync = ''
  for (const row of query.store.summaries.values()) {
    if (row.last_time_ms > bestTime || (row.last_time_ms === bestTime && row.synced_at > bestSync)) {
      bestId = row.session_id
      bestTime = row.last_time_ms
      bestSync = row.synced_at
    }
  }
  return bestId
}

/**
 * op 分发：GET `?op=…`；POST `{op:'sync'}` 触发后台同步。
 * 未知 op / 缺参 → 400（不留空壳）。
 */
export async function handleDrsRequest(deps: DrsHandlerDeps, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!isTrustedRequest(req, deps.trustedHosts)) {
    writeJson(res, 403, { ok: false, error: 'forbidden' })
    return
  }
  let url: URL
  try {
    url = new URL(req.url ?? DRS_API_PATH, 'http://localhost')
  } catch {
    writeJson(res, 400, { ok: false, error: 'bad url' })
    return
  }
  const op = url.searchParams.get('op') ?? ''
  const sessionId = url.searchParams.get('session') ?? ''
  const method = String(req.method ?? 'GET').toUpperCase()

  if (method === 'POST') {
    if (op !== 'sync') {
      writeJson(res, 400, { ok: false, error: `unknown POST op: ${op || '(missing)'}` })
      return
    }
    // 触发后台同步即回（syncing 旗标防撞轮，busy 轮自然合并到下一 interval）。
    void deps.sync.syncAll().catch(() => {})
    writeJson(res, 200, { ok: true, accepted: true, lastResult: deps.sync.lastSyncResult ?? null })
    return
  }

  switch (op) {
    case 'status': {
      writeJson(res, 200, { ok: true, ...status(deps.query, deps.sync.lastSyncResult ?? null) })
      return
    }
    case 'sessions': {
      const offset = Number(url.searchParams.get('offset') ?? '0')
      const limit = Number(url.searchParams.get('limit') ?? '50')
      writeJson(res, 200, { ok: true, ...listSessions(deps.query,
        Number.isFinite(offset) ? offset : 0,
        Number.isFinite(limit) ? limit : 50) })
      return
    }
    case 'session': {
      if (sessionId === '') {
        writeJson(res, 400, { ok: false, error: 'session parameter required' })
        return
      }
      const turn = url.searchParams.get('turn') ?? undefined
      const fields = url.searchParams.get('fields') ?? undefined
      const detail = sessionDetail(deps.query, sessionId, {
        ...(turn === undefined ? {} : { turn }),
        ...(fields === undefined ? {} : { fields }),
      })
      if (detail.session === undefined) {
        writeJson(res, 200, { ok: true, session: null, rows: [] })
        return
      }
      writeJson(res, 200, { ok: true, ...detail })
      return
    }
    case 'surface': {
      const sid = sessionId !== '' ? sessionId : resolveLatestSessionId(deps.query)
      if (sid === undefined) {
        writeJson(res, 400, { ok: false, error: 'session parameter required (no sessions to resolve)' })
        return
      }
      const ledger = surfaceLedger(deps.query, sid)
      writeJson(res, 200, sessionId !== ''
        ? { ok: true, ...ledger }
        : { ok: true, ...ledger, resolved_session_id: sid, resolved_by: 'latest' })
      return
    }
    case 'recall': {
      const sid = sessionId !== '' ? sessionId : resolveLatestSessionId(deps.query)
      if (sid === undefined) {
        writeJson(res, 400, { ok: false, error: 'session parameter required (no sessions to resolve)' })
        return
      }
      const report = recallReport(deps.query, sid)
      writeJson(res, 200, sessionId !== ''
        ? { ok: true, ...report }
        : { ok: true, ...report, resolved_session_id: sid, resolved_by: 'latest' })
      return
    }
    case 'search': {
      const q = url.searchParams.get('q') ?? ''
      if (q === '') {
        writeJson(res, 400, { ok: false, error: 'q parameter required' })
        return
      }
      // 分组臂（steward 直连）：group=session 时走 searchGrouped，参数见
      // GroupedSearchRequest；缺省仍为逐文档平铺命中（CCI/既有调用不变）。
      if (url.searchParams.get('group') === 'session') {
        const kindsRaw = url.searchParams.get('kinds') ?? ''
        const archivedRaw = url.searchParams.get('archived')
        const fromRaw = url.searchParams.get('from')
        const toRaw = url.searchParams.get('to')
        const limitRaw = url.searchParams.get('limit')
        const grouped = searchGrouped(deps.query, {
          query: q,
          ...(kindsRaw === '' ? {} : { kinds: kindsRaw.split(',').map(k => k.trim()).filter(Boolean) }),
          ...(archivedRaw === 'active' || archivedRaw === 'archived' || archivedRaw === 'all'
            ? { archived: archivedRaw } : {}),
          ...(fromRaw !== null && Number.isFinite(Number(fromRaw)) ? { from: Number(fromRaw) } : {}),
          ...(toRaw !== null && Number.isFinite(Number(toRaw)) ? { to: Number(toRaw) } : {}),
          ...(url.searchParams.get('surface') === '0' ? { surfaceOnly: false } : {}),
          ...(url.searchParams.get('sort') === 'time' ? { sortBy: 'time' as const } : {}),
          ...(limitRaw !== null && Number.isFinite(Number(limitRaw)) ? { limit: Number(limitRaw) } : {}),
        })
        writeJson(res, 200, { ok: true, ...grouped })
        return
      }
      const limitRaw = url.searchParams.get('limit')
      writeJson(res, 200, { ok: true, ...search(deps.query, q, {
        ...(sessionId === '' ? {} : { session: sessionId }),
        ...(limitRaw === null ? {} : { limit: Number(limitRaw) }),
      }) })
      return
    }
    default: {
      writeJson(res, 400, { ok: false, error: `unknown op: ${op || '(missing)'}` })
    }
  }
}

/** cordis 对未声明 inject 的服务面访问（属性读与 ctx.get）都会抛——两层安全
 * 包裹（装机实锤×2：请求期未保护读 webStartup/webRuntime → webServer 全局
 * 兑底 400 空体；Proxy 属性读臂同样需要 try）。 */
function safeReadService(ctx: Context, name: string): unknown {
  try {
    const direct = (ctx as unknown as Record<string, unknown>)[name]
    if (direct !== undefined) return direct
  } catch { /* Proxy 面：未声明服务属性读抛 */ }
  try {
    return typeof ctx.get === 'function' ? ctx.get(name) : undefined
  } catch {
    return undefined
  }
}

/**
 * 插件主体：开库 → 装配 sync（启动延迟首轮 + interval 轮）→ 双通道注册路由。
 * @param ctx - host 插件上下文（webServer 声明注入；webStartup/webRuntime 回退臂）。
 */
export function apply(ctx: Context): void {
  const log = (level: 'info' | 'warn', message: string, ...args: unknown[]): void => {
    try {
      const logger = (ctx as unknown as { logger?: { warn?: (m: string, ...a: unknown[]) => void; info?: (m: string, ...a: unknown[]) => void } }).logger
      if (level === 'warn' && typeof logger?.warn === 'function') logger.warn(message, ...args)
      else if (level === 'info' && typeof logger?.info === 'function') logger.info(message, ...args)
      else console[level]('[dsh-reference-session]', message, ...args)
    } catch { /* 日志面永不致命 */ }
  }

  const storeDir = resolveIndexDir()
  let store: ProjectionStore
  let query: QueryContext
  try {
    store = openProjectionStore(storeDir)
    query = createQueryContext(store)
  } catch (error) {
    log('warn', 'projection store 不可用（node:sqlite 缺席/目录不可写）：插件停用—— %s',
      String((error as Error)?.message ?? error))
    return
  }

  const sync = new ProjectionSync({
    store: createStorePort(store),
    project: (events, options) => projectSessionEvents(events, {
      dirId: options.dirId,
      ...(options.header === undefined ? {} : { header: options.header }),
      // 端口计数器返 TokenCount；投影只需数值臂（CCI verify 同款降级）。
      ...(options.exactCounter === undefined ? {} : {
        exactCounter: (text: string): number => {
          const count = options.exactCounter?.(text)
          return count !== undefined && count.kind === 'exact-tokenizer'
            ? count.tokens
            : Math.ceil(text.length / 4)
        },
      }),
    }),
    log: (level, message, ...args) => log(level, message, ...args),
  })

  // 生命周期：dispose 清定时器 + 关库。
  let bootTimer: ReturnType<typeof setTimeout> | undefined
  let disposeInterval: () => void = () => {}
  ctx.effect(() => {
    bootTimer = setTimeout(() => {
      void sync.syncAll().then(result => {
        log('info', 'boot sync done: updated=%d skipped=%d basis=%s %dms',
          result.updated, result.skipped, result.basis, result.durationMs)
      }).catch((error: unknown) => log('warn', 'boot sync failed: %s', String((error as Error)?.message ?? error)))
    }, BOOT_SYNC_DELAY_MS)
    disposeInterval = startIntervalSync(sync)
    return () => {
      if (bootTimer !== undefined) clearTimeout(bootTimer)
      disposeInterval()
      store.close()
    }
  }, 'dsh-reference-session: projection lifecycle')

  // trustedHosts best-effort（双名回退链，属性/get 两层 safe；缺席=放行）。
  const readStartupFace = (): WebStartupLike | undefined => {
    const direct = safeReadService(ctx, 'webStartup') ?? safeReadService(ctx, 'webRuntime')
    return direct !== null && typeof direct === 'object' ? direct as WebStartupLike : undefined
  }

  const depsFor = (): DrsHandlerDeps => {
    const startup = readStartupFace()
    return {
      query,
      sync,
      ...(startup?.trustedHosts !== undefined ? { trustedHosts: startup.trustedHosts } : {}),
    }
  }

  let registered = false
  const register = (webServer: WebServerLike, channel: 'direct' | 'inject'): void => {
    if (registered) return
    try {
      const off = webServer.register({
        kind: 'exact',
        path: DRS_API_PATH,
        handler: (req, res) => handleDrsRequest(depsFor(), req, res),
      })
      registered = true
      if (typeof off === 'function') {
        ctx.effect(() => off, 'dsh-reference-session: /api route unregister')
      }
      log('info', 'drs api route registered (%s)', channel)
    } catch (error) {
      if (isDuplicateRouteError(error)) {
        registered = true
        log('info', 'drs api route already owned by second mount — ok')
        return
      }
      log('warn', 'drs api route registration failed (%s): %s', channel, String((error as Error)?.message ?? error))
    }
  }

  const readService = (name: string): unknown => safeReadService(ctx, name)

  const active = asWebServer(readService('webServer'))
  if (active !== undefined) {
    register(active, 'direct')
    if (registered) return
  }

  try {
    ctx.inject(['webServer'], (injected) => {
      const webServer = asWebServer((injected as { webServer?: unknown }).webServer)
      if (webServer === undefined) {
        log('warn', 'webServer exposes no register() — drs api route not registered (projection sync keeps running)')
        return
      }
      register(webServer, 'inject')
    })
  } catch (error) {
    log('warn', 'webServer inject arm unavailable: %s — HTTP 面缺席，同步本体照常', String((error as Error)?.message ?? error))
  }
}
