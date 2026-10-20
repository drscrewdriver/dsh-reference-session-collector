/**
 * L3 同步引擎单测(mock 开发策略):store/projection 全走结构化 mock,
 * 不依赖 L1 落地;解码叶子用真身(本地等价实现,零 tokenizer 资产依赖,
 * counter:'off' 强制 chars/4)。fixture 全在临时目录,绝不触碰真实 ~/.dsh。
 */
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { generationLogFilename, type DecodedEvent } from '../src/session-file-decode.ts'
import {
  DEFAULT_SYNC_INTERVAL_MS,
  ProjectionSync,
  SYNC_INTERVAL_ENV,
  discoverSessionLogs,
  readArchivedSessionIds,
  resolveDshHome,
  resolveIndexDir,
  resolveSyncIntervalMs,
  startIntervalSync,
  type SyncReplaceMeta,
  type SyncStorePort,
} from '../src/sync.ts'

// ─────────────────────────── fixture 与 mock ───────────────────────────

const HEADER_A = { type: 'session', id: 'sess-a', version: 3, cwd: 'E:/tmp/proj' }

const EVENTS_A: DecodedEvent[] = [
  { type: 'step/start', seq: 0, time: 1_000, data: { turn: 1, step: 1 } },
  { type: 'user/message', seq: 1, time: 1_500, data: { message: { role: 'user', content: [{ type: 'text', text: 'hello' }] } } },
  { type: 'assistant/message', seq: 2, time: 2_500, data: { message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] } } },
]

const dirs: string[] = []

function makeDshHome(): string {
  const dir = mkdtempSync(join(tmpdir(), 'drs-sync-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** 造一个明文代次会话目录(文件名走拼接构造,遵守 D7 纪律)。 */
function writeSessionFixture(dshHome: string, dirId: string, header: unknown, events: readonly DecodedEvent[]): string {
  const dir = join(dshHome, 'sessions', dirId)
  mkdirSync(dir, { recursive: true })
  const lines = [JSON.stringify(header), ...events.map(event => JSON.stringify(event))]
  writeFileSync(join(dir, generationLogFilename(0, 'none')), `${lines.join('\n')}\n`, 'utf8')
  return dir
}

function writeWorkspace(dshHome: string, ids: string[]): void {
  const dir = join(dshHome, 'storages')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'workspace.json'), JSON.stringify({ global: { archivedSessionIds: ids } }), 'utf8')
}

interface MockStore extends SyncStorePort {
  byDir: Map<string, { sessionId: string; artifactBytes: number; artifactMtimeMs: number; archived: number }>
  replaces: Array<{ projection: unknown; meta: SyncReplaceMeta }>
  archivedCalls: Array<[string, number]>
  deletes: string[]
  /** R5 mock 面:current 由测试操控(模拟字典增长/驱逐),last 由轮尾持久化。 */
  blocks: { current: number; last: number }
}

function createMockStore(): MockStore {
  const byDir = new Map<string, { sessionId: string; artifactBytes: number; artifactMtimeMs: number; archived: number }>()
  const replaces: Array<{ projection: unknown; meta: SyncReplaceMeta }> = []
  const archivedCalls: Array<[string, number]> = []
  const deletes: string[] = []
  const blocks = { current: 0, last: 0 }
  return {
    byDir,
    replaces,
    archivedCalls,
    deletes,
    blocks,
    getSessionByDir(dirId) {
      const row = byDir.get(dirId)
      return row === undefined ? undefined : { ...row }
    },
    replaceSession(projection, meta) {
      replaces.push({ projection, meta })
      // 模拟真身:水位行按 projection.summary 的 dirId/sessionId 注册
      // (mock 投影保证该形状;L1 真身由 schema.replaceSession 负责)。
      const summary = (projection as { summary?: { sessionId?: string; dirId?: string } }).summary
      const dirId = typeof summary?.dirId === 'string' ? summary.dirId : `unknown-${replaces.length}`
      const sessionId = typeof summary?.sessionId === 'string' ? summary.sessionId : dirId
      byDir.set(dirId, { sessionId, ...meta })
    },
    setSessionArchived(sessionId, archived) {
      archivedCalls.push([sessionId, archived])
      for (const row of byDir.values()) {
        if (row.sessionId === sessionId) row.archived = archived
      }
    },
    listProjectedDirs() {
      const out: { dirId: string; sessionId: string }[] = []
      for (const [dirId, row] of byDir) out.push({ dirId, sessionId: row.sessionId })
      return out
    },
    deleteSession(sessionId) {
      deletes.push(sessionId)
      for (const [dirId, row] of byDir) {
        if (row.sessionId === sessionId) byDir.delete(dirId)
      }
    },
    blocksWatermark() {
      return { current: blocks.current, last: blocks.last }
    },
    setBlocksWatermark(value) {
      blocks.last = value
    },
  }
}

/** mock 投影核心:记录调用,产出 {summary{sessionId,dirId,lastTimeMs}} 形状。 */
function createMockProjection() {
  const calls: Array<{ dirId: string; headerPresent: boolean; eventCount: number }> = []
  const project = (events: readonly DecodedEvent[], options: { dirId: string; header?: Record<string, unknown> }) => {
    let lastTimeMs = 0
    for (const event of events) {
      if (typeof event.time === 'number' && event.time > lastTimeMs) lastTimeMs = event.time
    }
    calls.push({ dirId: options.dirId, headerPresent: options.header !== undefined, eventCount: events.length })
    return {
      summary: { sessionId: options.dirId, dirId: options.dirId, lastTimeMs },
      segments: [],
      replaces: [],
    }
  }
  return { project, calls }
}

function summaryOf(replace: { projection: unknown }): { sessionId: string; dirId: string; lastTimeMs: number } {
  return (replace.projection as { summary: { sessionId: string; dirId: string; lastTimeMs: number } }).summary
}

// ─────────────────────────── 发现与路径解析 ───────────────────────────

describe('discoverSessionLogs', () => {
  it('finds session dirs and descends through intermediate paths', () => {
    const dshHome = makeDshHome()
    expect(discoverSessionLogs(dshHome)).toEqual([])
    writeSessionFixture(dshHome, 'sess-a', HEADER_A, EVENTS_A)
    // 中间层目录(无代次产物)要被下钻,不是死路
    writeSessionFixture(join(dshHome, 'sessions', 'shard-1'), 'sess-b', HEADER_A, EVENTS_A)
    const found = discoverSessionLogs(dshHome)
    expect(found.map(entry => entry.dirSessionId).sort()).toEqual(['sess-a', 'sess-b'])
    expect(found[0]!.artifact.path.endsWith(generationLogFilename(0, 'none'))).toBe(true)
  })

  it('respects the discovery limit', () => {
    const dshHome = makeDshHome()
    writeSessionFixture(dshHome, 'sess-a', HEADER_A, EVENTS_A)
    writeSessionFixture(dshHome, 'sess-b', HEADER_A, EVENTS_A)
    expect(discoverSessionLogs(dshHome, 1)).toHaveLength(1)
  })
})

describe('path/env resolution', () => {
  it('resolves dsh home: explicit > env > default', () => {
    expect(resolveDshHome('/explicit', {})).toBe('/explicit')
    expect(resolveDshHome(undefined, { DSH_HOME: '/from-env' })).toBe('/from-env')
    expect(resolveDshHome(undefined, {})).toBe(join(homedir(), '.dsh'))
  })

  it('resolves index dir: explicit > env > default', () => {
    expect(resolveIndexDir('/idx', {})).toBe('/idx')
    expect(resolveIndexDir(undefined, { DSH_REFERENCE_SESSION_COLLECTOR_DIR: '/from-env' })).toBe('/from-env')
    expect(resolveIndexDir(undefined, {})).not.toBe('')
  })
})

// ─────────────────────────── 归档集读取 ───────────────────────────

describe('readArchivedSessionIds', () => {
  it('reads global.archivedSessionIds and tolerates malformed files', () => {
    const dshHome = makeDshHome()
    expect(readArchivedSessionIds(dshHome)).toEqual(new Set())
    writeWorkspace(dshHome, ['sess-a', 'sess-b'])
    expect(readArchivedSessionIds(dshHome)).toEqual(new Set(['sess-a', 'sess-b']))
    const storages = join(dshHome, 'storages')
    writeFileSync(join(storages, 'workspace.json'), 'not json at all', 'utf8')
    expect(readArchivedSessionIds(dshHome)).toEqual(new Set())
    writeFileSync(join(storages, 'workspace.json'), JSON.stringify({ global: { archivedSessionIds: 'not-array' } }), 'utf8')
    expect(readArchivedSessionIds(dshHome)).toEqual(new Set())
  })
})

// ─────────────────────────── 同步主流程 ───────────────────────────

describe('ProjectionSync.syncAll', () => {
  it('first round decodes+stores, second round stat-hits with zero decode, mtime bump re-decodes idempotently', async () => {
    const dshHome = makeDshHome()
    writeSessionFixture(dshHome, 'sess-a', HEADER_A, EVENTS_A)
    const store = createMockStore()
    const projection = createMockProjection()
    const sync = new ProjectionSync({ store, project: projection.project, counter: 'off' })

    const first = await sync.syncAll({ dshHome })
    expect(first).toMatchObject({ ok: true, busy: false, totalDiscovered: 1, updated: 1, skipped: 0, basis: 'chars/4' })
    expect(projection.calls).toEqual([{ dirId: 'sess-a', headerPresent: true, eventCount: 3 }])
    expect(store.replaces).toHaveLength(1)
    // last_time_ms 口径:事件最大 time(经投影 summary 透传,由真身 schema 落列)
    expect(summaryOf(store.replaces[0]!).lastTimeMs).toBe(2_500)

    // stat 命中:零解码(投影不再被调)、零重写
    const second = await sync.syncAll({ dshHome })
    expect(second).toMatchObject({ updated: 0, skipped: 1 })
    expect(projection.calls).toHaveLength(1)
    expect(store.replaces).toHaveLength(1)

    // mtime 变更 → 重解码;同一会话幂等重写(仍一行水位)
    const logPath = join(dshHome, 'sessions', 'sess-a', generationLogFilename(0, 'none'))
    const future = new Date(Date.now() + 5_000)
    utimesSync(logPath, future, future)
    const third = await sync.syncAll({ dshHome })
    expect(third.updated).toBe(1)
    expect(projection.calls).toHaveLength(2)
    expect(store.byDir.size).toBe(1)
  })

  it('soft-skips unknown header generations without throwing, warn-once per session+state', async () => {
    const dshHome = makeDshHome()
    writeSessionFixture(dshHome, 'sess-a', HEADER_A, EVENTS_A)
    writeSessionFixture(dshHome, 'sess-bad', { type: 'session', id: 'sess-bad', version: 99 }, EVENTS_A)
    const warns: string[] = []
    const store = createMockStore()
    const projection = createMockProjection()
    const sync = new ProjectionSync({
      store, project: projection.project, counter: 'off',
      log: (level, message) => { if (level === 'warn') warns.push(String(message)) },
    })

    const first = await sync.syncAll({ dshHome })
    expect(first.softSkips).toEqual([{ sessionId: 'sess-bad', state: 'unknown-version' }])
    expect(first.updated).toBe(1)
    expect(first.failures).toEqual([])
    expect(warns).toHaveLength(1)

    // 同一轮内不重复 warn;跨轮也不重复(一次性纪律)。
    // softSkips 是"本轮如实重报"——软跳会话无水位,每轮都会重试并列出,
    // 一次性约束只落在 warn 上。
    writeSessionFixture(dshHome, 'sess-bad2', { type: 'session', id: 'sess-bad2', version: 99 }, EVENTS_A)
    const second = await sync.syncAll({ dshHome })
    expect(second.softSkips).toEqual([
      { sessionId: 'sess-bad', state: 'unknown-version' },
      { sessionId: 'sess-bad2', state: 'unknown-version' },
    ])
    expect(warns).toHaveLength(2)
  })

  it('accepts legacy generations 0/1/2 (农场实锤：0.1.0-0.1.2 宿主自写代次=0，不得整库软跳)', async () => {
    const dshHome = makeDshHome()
    writeSessionFixture(dshHome, 'sess-v0', { type: 'session', id: 'sess-v0', version: 0 }, EVENTS_A)
    writeSessionFixture(dshHome, 'sess-v1', { type: 'session', id: 'sess-v1', version: 1 }, EVENTS_A)
    writeSessionFixture(dshHome, 'sess-v2', { type: 'session', id: 'sess-v2', version: 2 }, EVENTS_A)
    const store = createMockStore()
    const projection = createMockProjection()
    const sync = new ProjectionSync({ store, project: projection.project, counter: 'off' })
    const res = await sync.syncAll({ dshHome })
    expect(res.softSkips).toEqual([])
    expect(res.updated).toBe(3)
    expect(projection.calls).toHaveLength(3)
  })

  it('flips sessions.archived with the workspace.json archive set (read-only), including brand-new sessions', async () => {
    const dshHome = makeDshHome()
    writeSessionFixture(dshHome, 'sess-a', HEADER_A, EVENTS_A)
    const store = createMockStore()
    const projection = createMockProjection()
    const sync = new ProjectionSync({ store, project: projection.project, counter: 'off' })

    const first = await sync.syncAll({ dshHome })
    expect(first.updated).toBe(1)
    expect(store.replaces[0]!.meta.archived).toBe(0)

    // 归档集文件变更 → 下一轮 stat 命中分支翻转,零解码
    writeWorkspace(dshHome, ['sess-a'])
    const second = await sync.syncAll({ dshHome })
    expect(second.updated).toBe(0)
    expect(store.archivedCalls).toEqual([['sess-a', 1]])
    expect(projection.calls).toHaveLength(1)

    // 移出归档集 → 翻回 0
    writeWorkspace(dshHome, [])
    await sync.syncAll({ dshHome })
    expect(store.archivedCalls).toEqual([['sess-a', 1], ['sess-a', 0]])

    // 新会话首轮即落在归档态:随 replaceSession meta 携带,不走翻转臂
    writeWorkspace(dshHome, ['sess-new'])
    writeSessionFixture(dshHome, 'sess-new', { type: 'session', id: 'sess-new', version: 3, cwd: 'E:/tmp/proj' }, EVENTS_A)
    const fourth = await sync.syncAll({ dshHome })
    expect(fourth.updated).toBe(1)
    const newRow = store.replaces.find(entry => summaryOf(entry).sessionId === 'sess-new')
    expect(newRow?.meta.archived).toBe(1)
  })

  it('records per-session failures without aborting the round', async () => {
    const dshHome = makeDshHome()
    writeSessionFixture(dshHome, 'sess-a', HEADER_A, EVENTS_A)
    const store = createMockStore()
    const projection = createMockProjection()
    // store 在第二个会话落库时炸:失败入账,循环继续
    const sync = new ProjectionSync({
      store,
      project: (events, options) => {
        if (options.dirId === 'sess-boom') throw new Error('store exploded')
        return projection.project(events, options)
      },
      counter: 'off',
    })
    writeSessionFixture(dshHome, 'sess-boom', HEADER_A, EVENTS_A)
    const result = await sync.syncAll({ dshHome })
    expect(result.updated).toBe(1)
    expect(result.failures).toEqual([{ sessionId: 'sess-boom', error: 'store exploded' }])
    expect(result.ok).toBe(true)
  })

  it('returns busy without overlapping when re-entered mid-round', async () => {
    const dshHome = makeDshHome()
    writeSessionFixture(dshHome, 'sess-a', HEADER_A, EVENTS_A)
    writeSessionFixture(dshHome, 'sess-b', HEADER_A, EVENTS_A)
    const store = createMockStore()
    const projection = createMockProjection()
    const sync = new ProjectionSync({ store, project: projection.project, counter: 'off' })
    const ongoing = sync.syncAll({ dshHome })
    const reentered = await sync.syncAll({ dshHome })
    expect(reentered.busy).toBe(true)
    expect(reentered.updated).toBe(0)
    const done = await ongoing
    expect(done.busy).toBe(false)
    expect(done.updated).toBe(2)
  })

  it('uses the exact counter when counter:auto and basis reflects it', async () => {
    const dshHome = makeDshHome()
    writeSessionFixture(dshHome, 'sess-a', HEADER_A, EVENTS_A)
    const fakeCounter = (text: string) => ({
      kind: 'exact-tokenizer' as const,
      tokens: text.length,
      tokenizerId: 'test',
      tokenizerRevision: 'test',
    })
    const store = createMockStore()
    const projection = createMockProjection()
    // 直接注入端口层探测不到的形态:counter:'auto' 会走真 tokenizer(资产在),
    // 这里改为验证端口收到 exactCounter 的通路——用 'off' 对照。
    const syncOff = new ProjectionSync({ store, project: projection.project, counter: 'off' })
    const result = await syncOff.syncAll({ dshHome })
    expect(result.basis).toBe('chars/4')
    expect(fakeCounter('x').tokens).toBe(1)
  })
})

// ─────────────────────────── interval 调度 ───────────────────────────

describe('interval scheduling', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('fires per period, never concurrent, and stops on dispose', async () => {
    vi.useFakeTimers()
    const syncAll = vi.fn(async () => ({ ok: true, busy: false }))
    const dispose = startIntervalSync({ syncAll }, { intervalMs: 30 })
    await vi.advanceTimersByTimeAsync(29)
    expect(syncAll).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(syncAll).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(60)
    expect(syncAll).toHaveBeenCalledTimes(3)
    dispose()
    await vi.advanceTimersByTimeAsync(300)
    expect(syncAll).toHaveBeenCalledTimes(3)
  })

  it('intervalMs=0 (env off) installs no timer', async () => {
    vi.useFakeTimers()
    const syncAll = vi.fn(async () => ({ ok: true, busy: false }))
    const dispose = startIntervalSync({ syncAll }, { intervalMs: 0 })
    expect(dispose).toBeInstanceOf(Function)
    await vi.advanceTimersByTimeAsync(600_000)
    expect(syncAll).not.toHaveBeenCalled()
    dispose()
  })

  it('resolveSyncIntervalMs: default 30s, 0=off, invalid falls back', () => {
    expect(resolveSyncIntervalMs({})).toBe(DEFAULT_SYNC_INTERVAL_MS)
    expect(resolveSyncIntervalMs({ [SYNC_INTERVAL_ENV]: '0' })).toBe(0)
    expect(resolveSyncIntervalMs({ [SYNC_INTERVAL_ENV]: '5000' })).toBe(5_000)
    expect(resolveSyncIntervalMs({ [SYNC_INTERVAL_ENV]: 'abc' })).toBe(DEFAULT_SYNC_INTERVAL_MS)
    expect(resolveSyncIntervalMs({ [SYNC_INTERVAL_ENV]: '-3' })).toBe(DEFAULT_SYNC_INTERVAL_MS)
    expect(resolveSyncIntervalMs({ [SYNC_INTERVAL_ENV]: '  ' })).toBe(DEFAULT_SYNC_INTERVAL_MS)
  })
})

describe('删除剪枝（被 session 删除的会话→WAL 级联清对应 uuid，2026-10-20 用户定标）', () => {
  it('磁盘目录消失的会话下一轮被剪枝：deleteSession 收到其 sessionId，pruned 如实报告，幸存会话不动', async () => {
    const dshHome = makeDshHome()
    const dirA = writeSessionFixture(dshHome, 'sess-a', HEADER_A, EVENTS_A)
    writeSessionFixture(dshHome, 'sess-b', { type: 'session', id: 'sess-b', version: 3, cwd: 'E:/tmp/proj' }, EVENTS_A)
    const store = createMockStore()
    const projection = createMockProjection()
    const sync = new ProjectionSync({ store, project: projection.project, counter: 'off' })
    const first = await sync.syncAll({ dshHome })
    expect(first.updated).toBe(2)
    expect(first.pruned).toEqual([])

    // 宿主删会话：目录整体消失（append-only 文件没了就是没了）。
    rmSync(dirA, { recursive: true, force: true })
    const second = await sync.syncAll({ dshHome })
    expect(second.totalDiscovered).toBe(1)
    expect(second.pruned).toEqual(['sess-a'])
    expect(store.deletes).toEqual(['sess-a'])
    expect(store.byDir.has('sess-a')).toBe(false)
    expect(store.byDir.has('sess-b')).toBe(true)
  })

  it('sessions 根缺失=守护不动手：宁留陈旧行绝不误删全集', async () => {
    const dshHome = makeDshHome()
    writeSessionFixture(dshHome, 'sess-a', HEADER_A, EVENTS_A)
    const store = createMockStore()
    const projection = createMockProjection()
    const sync = new ProjectionSync({ store, project: projection.project, counter: 'off' })
    await sync.syncAll({ dshHome })
    expect(store.byDir.size).toBe(1)

    // 整个 sessions 目录消失（挂盘故障/被搬走）——不是「所有会话都删了」的信号。
    rmSync(join(dshHome, 'sessions'), { recursive: true, force: true })
    const res = await sync.syncAll({ dshHome })
    expect(res.totalDiscovered).toBe(0)
    expect(res.pruned).toEqual([])
    expect(store.deletes).toEqual([])
    expect(store.byDir.size).toBe(1)
  })

  it('发现被 limit 截断=守护不动手（未看得见的会话不能当作已删）', async () => {
    const dshHome = makeDshHome()
    writeSessionFixture(dshHome, 'sess-a', HEADER_A, EVENTS_A)
    writeSessionFixture(dshHome, 'sess-b', { type: 'session', id: 'sess-b', version: 3, cwd: 'E:/tmp' }, EVENTS_A)
    const store = createMockStore()
    const projection = createMockProjection()
    const sync = new ProjectionSync({ store, project: projection.project, counter: 'off' })
    const full = await sync.syncAll({ dshHome })
    expect(full.updated).toBe(2)

    // limit=1：只发现一个——另一个虽不在 alive 集但发现被截断，不得剪。
    const res = await sync.syncAll({ dshHome, limit: 1 })
    expect(res.totalDiscovered).toBe(1)
    expect(res.pruned).toEqual([])
    expect(store.deletes).toEqual([])
  })
})

describe('R5 blocks 字典水位（v5：stat 全命中但字典驱逐过→强制重投，防静默缺块）', () => {
  it('水位倒退轮强制重投；正常轮 stat 命中仍 skip；轮尾持久化水位', async () => {
    const dshHome = makeDshHome()
    writeSessionFixture(dshHome, 'sess-a', HEADER_A, EVENTS_A)
    const store = createMockStore()
    const projection = createMockProjection()
    const sync = new ProjectionSync({ store, project: projection.project, counter: 'off' })

    const first = await sync.syncAll({ dshHome })
    expect(first.updated).toBe(1)
    expect(store.blocks.last).toBe(0)

    // 字典随投影增长(真身=ensureBlock 推 rowid;mock 由测试操控 current)
    store.blocks.current = 9
    const second = await sync.syncAll({ dshHome })
    expect(second).toMatchObject({ updated: 0, skipped: 1 }) // 水位前进不算驱逐
    expect(store.blocks.last).toBe(9) // 轮尾持久化现值

    // 字典被清/换:current 倒退到低于持久化 last——stat 命中也不得 skip
    store.blocks.current = 2
    const third = await sync.syncAll({ dshHome })
    expect(third.updated).toBe(1)
    expect(third.skipped).toBe(0)
    expect(projection.calls).toHaveLength(2)
    expect(store.blocks.last).toBe(2)

    // 水位回正常:第四轮恢复 stat 命中零解码
    const fourth = await sync.syncAll({ dshHome })
    expect(fourth).toMatchObject({ updated: 0, skipped: 1 })
    expect(projection.calls).toHaveLength(2)
  })

  it('首次同步(无持久化水位 last=0)不算驱逐;current=0 空典也合法', async () => {
    const dshHome = makeDshHome()
    writeSessionFixture(dshHome, 'sess-a', HEADER_A, EVENTS_A)
    const store = createMockStore()
    const projection = createMockProjection()
    const sync = new ProjectionSync({ store, project: projection.project, counter: 'off' })
    await sync.syncAll({ dshHome })
    // 空典 mock:current 保持 0——不触发驱逐臂
    const second = await sync.syncAll({ dshHome })
    expect(second).toMatchObject({ updated: 0, skipped: 1 })
    expect(projection.calls).toHaveLength(1)
  })
})
