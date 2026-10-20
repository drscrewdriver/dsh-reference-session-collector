/**
 * S2 换真件联调：ProjectionSync（L3 真身）× openProjectionStore（L1 真身）×
 * 明文代次文件——不经 mock，验证 createStorePort 适配与全链路：
 * 首轮 updated=1 → 二轮 stat 命中 skipped → mtime  bump 重解码幂等 →
 * 归档集翻转落到真库 sessions.archived。
 */
import { mkdtempSync, rmSync, writeFileSync, appendFileSync, utimesSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { generationLogFilename } from '../src/session-file-decode.ts'
import { openProjectionStore } from '../src/schema.ts'
import { projectSessionEvents } from '../src/projection.ts'
import { ProjectionSync } from '../src/sync.ts'
import { createStorePort } from '../src/index.ts'

let home = ''
let libDir = ''

const header = JSON.stringify({ type: 'session', version: 4, id: 'sess-e2e', cwd: '/tmp/e2e' })
const row = (seq: number, type: string, data: unknown, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ seq, type, time: 1_700_000_000_000 + seq * 1000, data, ...extra })

function logLines(): string[] {
  return [
    header,
    row(0, 'step/start', { turn: 1, step: 1 }),
    row(1, 'user/message', { content: [{ type: 'text', text: '端到端探针' }] }),
    row(2, 'assistant/message', { message: { content: [{ type: 'text', text: 'first body text' }] } }),
    // 压缩对：seq3 替 seq2
    row(3, 'assistant/message', { message: { content: [{ type: 'text', text: 'p' }] } },
      { surfaceOp: { op: 'replace', startSeq: 2, endSeq: 2 } }),
  ]
}

function writeLog(lines: string[]): string {
  const path = join(home, 'sessions', 'slug', 'sess-e2e', generationLogFilename(0, 'none'))
  writeFileSync(path, lines.join('\n') + '\n')
  return path
}

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), 'drs-e2e-home-'))
  libDir = mkdtempSync(join(tmpdir(), 'drs-e2e-lib-'))
  mkdirSync(join(home, 'sessions', 'slug', 'sess-e2e'), { recursive: true })
  mkdirSync(join(home, 'storages'), { recursive: true })
})
afterAll(() => {
  rmSync(home, { recursive: true, force: true })
  rmSync(libDir, { recursive: true, force: true })
})

describe('ProjectionSync × 真库端到端', () => {
  it('首轮解码入库、二轮 stat 全跳过、mtime bump 重解码行数稳定、归档翻转落真库', async () => {
    const store = openProjectionStore(libDir)
    const sync = new ProjectionSync({
    store: createStorePort(store),
    project: (events, options) => projectSessionEvents(events, {
      dirId: options.dirId,
      ...(options.header === undefined ? {} : { header: options.header }),
    }),
    counter: 'off',
    })

    const logPath = writeLog(logLines())
    const first = await sync.syncAll({ dshHome: home })
    expect(first.busy).toBe(false)
    expect(first.updated).toBe(1)
    expect(first.softSkips).toHaveLength(0)
    expect(store.summaries.get('sess-e2e')?.basis).toBe('chars/4')
    expect(store.summaries.get('sess-e2e')?.format_generation).toBe(4)
    expect(store.summaries.get('sess-e2e')?.gross_saved).toBe(Math.ceil('first body text'.length / 4) - 1)
    const segCount = (store.db.prepare('SELECT COUNT(*) AS c FROM segments').get() as { c: number }).c
    expect(segCount).toBe(3)

    const second = await sync.syncAll({ dshHome: home })
    expect(second.updated).toBe(0)
    expect(second.skipped).toBe(1)

    // mtime bump → 重解码幂等（行数稳定）
    const now = new Date(Date.now() + 5_000)
    utimesSync(logPath, now, now)
    const third = await sync.syncAll({ dshHome: home })
    expect(third.updated).toBe(1)
    expect((store.db.prepare('SELECT COUNT(*) AS c FROM segments').get() as { c: number }).c).toBe(segCount)

    // 归档集翻转：workspace.json 写归档 id → 下一轮真库 archived=1
    writeFileSync(join(home, 'storages', 'workspace.json'),
      JSON.stringify({ global: { archivedSessionIds: ['sess-e2e'] } }))
    const fourth = await sync.syncAll({ dshHome: home })
    expect(fourth.skipped).toBe(1) // stat 命中免解码
    expect(store.summaries.get('sess-e2e')?.archived).toBe(1)

    // 真库检索面：中文查询命中（fts 由 replaceSession 直插）
    const { createQueryContext, search, sessionDetail } = await import('../src/surface.ts')
    const hits = search(createQueryContext(store), '端到端探针')
    expect(hits.hits.length).toBeGreaterThan(0)
    // tail 与会话文件真实尾部对拍：日志末行 seq=3（text='p'）即尾窗唯一行
    const tail = sessionDetail(createQueryContext(store), 'sess-e2e', { tail: 1 }).rows as Record<string, unknown>[]
    expect(tail).toHaveLength(1)
    expect(Number(tail[0]!['seq'])).toBe(3)
    expect(String(tail[0]!['text'])).toBe('p')
    store.close()
  })

  it('追加行改写日志 → 水位失配重投影（撕裂容忍由解码叶子负责）', async () => {
    const store2 = openProjectionStore(libDir)
    const sync2 = new ProjectionSync({
      store: createStorePort(store2),
      project: (events, options) => projectSessionEvents(events, {
        dirId: options.dirId,
        ...(options.header === undefined ? {} : { header: options.header }),
      }),
      counter: 'off',
    })
    const logPath = join(home, 'sessions', 'slug', 'sess-e2e', generationLogFilename(0, 'none'))
    appendFileSync(logPath, row(4, 'todo/write', { todos: [{ status: 'done', content: '收尾事项' }] }) + '\n')
    const res = await sync2.syncAll({ dshHome: home })
    expect(res.updated).toBe(1)
    expect(store2.summaries.get('sess-e2e')?.event_count).toBe(5)
    store2.close()
  })

  it('删除剪枝端到端（真身 store）：会话目录被删 → 下一轮四表零残留，幸存会话可检', async () => {
    const store3 = openProjectionStore(libDir)
    const sync3 = new ProjectionSync({
      store: createStorePort(store3),
      project: (events, options) => projectSessionEvents(events, {
        dirId: options.dirId,
        ...(options.header === undefined ? {} : { header: options.header }),
      }),
      counter: 'off',
    })
    // 造第二个会话并入库（带一行可检文本）
    const doomedDir = join(home, 'sessions', 'slug', 'sess-doomed')
    mkdirSync(doomedDir, { recursive: true })
    const doomedLines = [
      JSON.stringify({ type: 'session', version: 4, id: 'sess-doomed', cwd: '/tmp/e2e' }),
      row(0, 'user/message', { content: [{ type: 'text', text: '注定被删的探针文本' }] }),
    ]
    writeFileSync(join(doomedDir, generationLogFilename(0, 'none')), doomedLines.join('\n') + '\n')
    const seed = await sync3.syncAll({ dshHome: home })
    expect(seed.updated).toBe(1)
    expect(store3.summaries.has('sess-doomed')).toBe(true)

    // 宿主删会话：目录消失 → 下一轮剪枝，WAL 事务级联清四表
    rmSync(doomedDir, { recursive: true, force: true })
    const res = await sync3.syncAll({ dshHome: home })
    expect(res.pruned).toEqual(['sess-doomed'])
    expect(store3.summaries.has('sess-doomed')).toBe(false)
    for (const table of ['segments', 'segments_fts', 'replaces', 'sessions']) {
      const n = store3.db.prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE session_id=?`).get('sess-doomed') as { c: number }
      expect(n.c, `${table} 应零残留`).toBe(0)
    }
    // 幸存会话照常可检（sess-e2e 未被误伤）
    const { createQueryContext, search } = await import('../src/surface.ts')
    const hits = search(createQueryContext(store3), '端到端探针')
    expect(hits.hits.length).toBeGreaterThan(0)
    store3.close()
  })
})
