/**
 * issue #2 回归：同步引擎不得把主线程整段占死。
 *
 * 报告人的 CPU profile 显示约 79% 时间耗在 `syncAll`，且 `syncOne` 内部
 * `readFileSync` / decode / project / `replaceSession` 全程同步不可中断，
 * 一个 62MB 会话就能让宿主消息 RPC 排队几十秒。
 *
 * 这里守三件事：
 * 1. **异步解码与同步解码等价** —— 异步版是新增文件（vendored 的
 *    `session-file-decode.ts` 不能分叉），两者结果必须逐字段相同；
 * 2. **会话内可让路** —— 单个大会话处理期间，事件循环至少被交还一次
 *    （改动前是 0 次，只有会话之间才让路）；
 * 3. **可观测** —— `durationMs` 是真值、`slowest` 指向最大会话、每轮有日志。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  decodeSessionLogBytes,
  generationLogFilename,
  type DecodedEvent,
} from '../src/session-file-decode.ts'
import {
  DEFAULT_YIELD_EVERY_FRAMES,
  DEFAULT_YIELD_EVERY_LINES,
  decodeSessionLogBytesAsync,
} from '../src/session-decode-async.ts'
import { ProjectionSync, type SyncReplaceMeta, type SyncStorePort } from '../src/sync.ts'

const HEADER = { type: 'session', id: 'sess-a', version: 3, cwd: '/tmp/proj' }

const dirs: string[] = []

function makeDshHome(): string {
  const dir = mkdtempSync(join(tmpdir(), 'drs-yield-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** 造一个含 `lines` 条消息的明文会话（行数多 = 单会话耗时长）。 */
function writeSession(dshHome: string, dirId: string, lines: number): string {
  const dir = join(dshHome, 'sessions', dirId)
  mkdirSync(dir, { recursive: true })
  const rows = [JSON.stringify({ ...HEADER, id: dirId })]
  for (let i = 0; i < lines; i += 1) {
    rows.push(JSON.stringify({
      type: 'user/message', seq: i, time: 1_000 + i,
      data: { message: { role: 'user', content: [{ type: 'text', text: `msg ${i}` }] } },
    }))
  }
  writeFileSync(join(dir, generationLogFilename(0, 'none')), `${rows.join('\n')}\n`, 'utf8')
  return dir
}

function createStore(): SyncStorePort & { byDir: Map<string, { sessionId: string; artifactBytes: number; artifactMtimeMs: number; archived: number }>; replaces: Array<{ projection: unknown; meta: SyncReplaceMeta }> } {
  const byDir = new Map<string, { sessionId: string; artifactBytes: number; artifactMtimeMs: number; archived: number }>()
  const replaces: Array<{ projection: unknown; meta: SyncReplaceMeta }> = []
  return {
    byDir,
    replaces,
    getSessionByDir(dirId) { return byDir.get(dirId) },
    // v6 帧级增量端口:mock 面缺省无先验(增量路径自动回退全量)。
    getSessionState() { return undefined },
    applyIncrement() { /* 本 spec 不走增量 */ },
    replaceSession(projection, meta) {
      replaces.push({ projection, meta })
      const summary = (projection as { summary: { sessionId: string; dirId: string } }).summary
      byDir.set(summary.dirId, {
        sessionId: summary.sessionId,
        artifactBytes: meta.artifactBytes,
        artifactMtimeMs: meta.artifactMtimeMs,
        archived: meta.archived,
      })
    },
    setSessionArchived() {},
    listProjectedDirs() { return [...byDir.values()].map(r => ({ dirId: r.sessionId, sessionId: r.sessionId })) },
    deleteSession() {},
    blocksWatermark() { return { current: 0, last: 0 } },
    setBlocksWatermark() {},
  }
}

function projectOf(events: readonly DecodedEvent[], options: { dirId: string }) {
  return { summary: { sessionId: options.dirId, dirId: options.dirId, lastTimeMs: events.length }, segments: [], replaces: [] }
}

// ─────────────────────── 1. 同步 / 异步解码等价 ───────────────────────

describe('decodeSessionLogBytesAsync equals the synchronous decoder', () => {
  function fixtureBytes(): Buffer {
    const rows = [JSON.stringify(HEADER)]
    for (let i = 0; i < 200; i += 1) {
      rows.push(JSON.stringify({
        type: 'user/message', seq: i, time: 1_000 + i,
        data: { message: { role: 'user', content: [{ type: 'text', text: `line ${i}` }] } },
      }))
    }
    return Buffer.from(`${rows.join('\n')}\n`, 'utf8')
  }

  it('produces an identical result for a plaintext log', async () => {
    const bytes = fixtureBytes()
    const syncRead = decodeSessionLogBytes(bytes)
    const asyncRead = await decodeSessionLogBytesAsync(bytes)
    expect(asyncRead).toEqual(syncRead)
    expect(asyncRead.events).toHaveLength(200)
  })

  it('produces an identical result when yielding every line', async () => {
    const bytes = fixtureBytes()
    const syncRead = decodeSessionLogBytes(bytes)
    // yieldEveryLines=1 / yieldEveryFrames=1: 最大让路密度,结果必须不变。
    const asyncRead = await decodeSessionLogBytesAsync(bytes, undefined, 1, 1)
    expect(asyncRead).toEqual(syncRead)
  })

  it('matches the synchronous decoder on a torn / malformed tail', async () => {
    const bytes = Buffer.from(`${JSON.stringify(HEADER)}\n{"type":"user/message","seq":0`, 'utf8')
    const syncRead = decodeSessionLogBytes(bytes)
    const asyncRead = await decodeSessionLogBytesAsync(bytes)
    expect(asyncRead).toEqual(syncRead)
    expect(asyncRead.issues.length).toBeGreaterThan(0)
  })

  it('matches the synchronous decoder on an empty buffer', async () => {
    const syncRead = decodeSessionLogBytes(Buffer.alloc(0))
    const asyncRead = await decodeSessionLogBytesAsync(Buffer.alloc(0))
    expect(asyncRead).toEqual(syncRead)
  })

  it('exposes sane default yield intervals', () => {
    expect(DEFAULT_YIELD_EVERY_FRAMES).toBeGreaterThan(0)
    expect(DEFAULT_YIELD_EVERY_LINES).toBeGreaterThan(0)
  })
})

// ─────────────────── 2. 会话内可让路（issue #2 核心） ───────────────────

describe('syncAll yields the event loop INSIDE a single session (issue #2)', () => {
  it('grants the loop many turns during one large session', async () => {
    const dshHome = makeDshHome()
    // 一个大会话：行数多 ⇒ 单会话耗时够长，让路点必然被触发。
    writeSession(dshHome, 'sess-big', 20_000)
    const store = createStore()
    const sync = new ProjectionSync({ store, project: projectOf, counter: 'off', log: () => {} })

    // 数 syncAll 期间事件循环被交还的次数。改动前这里只会得到 0~1
    // （唯一的让路在会话循环尾部，即整个会话处理完之后）。
    let turns = 0
    let pumping = true
    const pump = (): void => {
      if (!pumping) return
      turns += 1
      setImmediate(pump)
    }
    setImmediate(pump)

    const result = await sync.syncAll({ dshHome, budgetMs: 0 })
    pumping = false

    expect(result.updated).toBe(1)
    // 会话内让路：远超"只有会话间让一次"的 1 次。
    expect(turns).toBeGreaterThan(10)
  })

  it('still works when there is nothing to decode (stat hit path stays synchronous-fast)', async () => {
    const dshHome = makeDshHome()
    writeSession(dshHome, 'sess-a', 3)
    const store = createStore()
    const sync = new ProjectionSync({ store, project: projectOf, counter: 'off', log: () => {} })
    await sync.syncAll({ dshHome, budgetMs: 0 })
    const second = await sync.syncAll({ dshHome, budgetMs: 0 })
    expect(second).toMatchObject({ updated: 0, skipped: 1 })
    // 零解码轮不产生 slowest（没有会话真正被处理）。
    expect(second.slowest).toBeUndefined()
  })
})

// ─────────────────── 3. 可观测性（issue #2 诉求 3） ───────────────────

describe('syncAll reports duration and the slowest session (issue #2)', () => {
  it('fills durationMs with a real value', async () => {
    const dshHome = makeDshHome()
    writeSession(dshHome, 'sess-a', 50)
    const store = createStore()
    const sync = new ProjectionSync({ store, project: projectOf, counter: 'off', log: () => {} })
    const result = await sync.syncAll({ dshHome, budgetMs: 0 })
    expect(result.durationMs).toBeGreaterThan(0)
  })

  it('points slowest at the session that took longest', async () => {
    const dshHome = makeDshHome()
    writeSession(dshHome, 'sess-small', 5)
    writeSession(dshHome, 'sess-big', 20_000)
    const store = createStore()
    const sync = new ProjectionSync({ store, project: projectOf, counter: 'off', log: () => {} })
    const result = await sync.syncAll({ dshHome, budgetMs: 0 })
    expect(result.updated).toBe(2)
    expect(result.slowest).toBeDefined()
    expect(result.slowest?.sessionId).toBe('sess-big')
    expect(result.slowest?.ms).toBeGreaterThan(0)
    expect(result.slowest?.bytes).toBeGreaterThan(0)
  })

  it('logs one round line with the diagnostic fields', async () => {
    const dshHome = makeDshHome()
    writeSession(dshHome, 'sess-a', 50)
    const store = createStore()
    const infos: Array<{ message: unknown; args: unknown[] }> = []
    const sync = new ProjectionSync({
      store, project: projectOf, counter: 'off',
      log: (level, message, ...args) => { if (level === 'info') infos.push({ message, args }) },
    })
    await sync.syncAll({ dshHome, budgetMs: 0 })
    const round = infos.find(entry => String(entry.message).includes('round'))
    expect(round).toBeDefined()
    expect(String(round!.message)).toContain('dur=')
    expect(String(round!.message)).toContain('slowest=')
    // updated / skipped / deferred / durationMs / slowest 五个值
    expect(round!.args).toHaveLength(5)
  })

  it('does not log an idle round (all stat hits, nothing changed)', async () => {
    const dshHome = makeDshHome()
    writeSession(dshHome, 'sess-a', 3)
    const store = createStore()
    const infos: unknown[] = []
    const sync = new ProjectionSync({
      store, project: projectOf, counter: 'off',
      log: (level, message) => { if (level === 'info') infos.push(message) },
    })
    await sync.syncAll({ dshHome, budgetMs: 0 })
    infos.length = 0
    await sync.syncAll({ dshHome, budgetMs: 0 })
    expect(infos.filter(message => String(message).includes('round'))).toHaveLength(0)
  })
})
