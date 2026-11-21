/**
 * 帧级增量水位契约测试（issue #3，v0.2.12）：
 *
 * 核心验收②——「分段同步 vs 全量同步投影逐字节一致」：同一事件流按多轮
 * 追加节奏分段同步（真实 zstd 多帧文件 + 真库 + createStorePort 全链路），
 * 最终库内容（sessions/segments/replaces/segments_fts 四表 + 水位列）必须与
 * 一次性全量同步的参考库逐字节一致。
 *
 * 覆盖面：普通追加多轮、翻转（新帧 checkpoint 覆盖旧 seq → onSurface/live
 * 1→0 + grossSaved/surfaceTokens 修正）、悬空链尾补齐（终替被新覆盖 → 指向
 * 它的行续跳）、torn 重写区 seq 前缀去重、回缩/口径漂移回退全量、O(新增)
 * 断言（增量轮只见新增事件）。
 */
import { mkdtempSync, rmSync, writeFileSync, appendFileSync, mkdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { generationLogFilename, type DecodedEvent } from '../src/session-file-decode.ts'
import { openProjectionStore, type ProjectionStore, type SessionRow } from '../src/schema.ts'
import { projectSessionEvents, projectSessionIncremental, type ProjectionPrior } from '../src/projection.ts'
import { ProjectionSync } from '../src/sync.ts'
import { createStorePort } from '../src/index.ts'
import { decodeSessionLogTailAsync } from '../src/session-decode-async.ts'

const dirs: string[] = []
const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'drs-inc-'))
  dirs.push(dir)
  return dir
}
afterAll(() => {
  // Windows + SQLite WAL：失败用例跳过 close 会锁住 db 文件——清理失败不掩盖测试结论。
  for (const dir of dirs.splice(0)) {
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* 锁住即留给系统临时目录 */ }
  }
})

// ─────────────────────────── fixture ───────────────────────────

// 投影会话身份 = 发现目录名（dirId）；header.id 与目录名一致（e2e 同构）。
const mkHeader = (dirId: string): string => JSON.stringify({ type: 'session', version: 4, id: dirId, cwd: '/tmp/inc' })
const row = (seq: number, type: string, data: unknown, extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ seq, type, time: 1_700_000_000_000 + seq * 1000, data, ...extra })

/** 一个事件批 = 一帧（宿主 appendLines 同构：每批一个自包含 zstd frame）。 */
function frame(lines: readonly string[]): Buffer {
  return zstdCompressSync(Buffer.from(`${lines.join('\n')}\n`, 'utf8'))
}

function sessionDir(home: string, dirId: string): { dir: string; path: string } {
  const dir = join(home, 'sessions', dirId)
  mkdirSync(dir, { recursive: true })
  const path = join(dir, generationLogFilename(0, 'zstd'))
  return { dir, path }
}

interface Rig {
  store: ProjectionStore
  sync: ProjectionSync
  applySpy: ReturnType<typeof vi.fn>
  replaceSpy: ReturnType<typeof vi.fn>
  incProjectSpy: ReturnType<typeof vi.fn>
}

function makeRig(libDir: string): Rig {
  const store = openProjectionStore(libDir)
  const base = createStorePort(store)
  // 委托型 spy：默认透传真身（DB 状态照常演进），测试按 calls 计数断言路由面。
  const applySpy = vi.fn(((sessionId: string, delta: unknown, meta: Parameters<typeof base.applyIncrement>[2]) =>
    base.applyIncrement(sessionId, delta, meta)) as typeof base.applyIncrement)
  const replaceSpy = vi.fn(((projection: unknown, meta: Parameters<typeof base.replaceSession>[1]) =>
    base.replaceSession(projection, meta)) as typeof base.replaceSession)
  const incProjectSpy = vi.fn((newEvents: readonly DecodedEvent[], prior: unknown, options: { dirId: string }) =>
    projectSessionIncremental(newEvents, prior as ProjectionPrior, { dirId: options.dirId }))
  const sync = new ProjectionSync({
    store: { ...base, applyIncrement: applySpy, replaceSession: replaceSpy },
    project: (events, options) => projectSessionEvents(events, {
      dirId: options.dirId,
      ...(options.header === undefined ? {} : { header: options.header }),
    }),
    projectIncremental: incProjectSpy,
    counter: 'off',
  })
  return { store, sync, applySpy, replaceSpy, incProjectSpy }
}

/** 库内容全量导出（除 synced_at 时钟面）——分段 vs 全量的逐字节对拍基面。 */
function dump(store: ProjectionStore, sessionId: string): string {
  const row = { ...(store.summaries.get(sessionId) as SessionRow) } as Record<string, unknown>
  // 时钟/文件系统面非契约：synced_at（落库时刻）与 artifact_mtime_ms（rig 与
  // 参考库是两个分别写入的物理文件，mtime 天然不同）不对拍。
  delete row.synced_at
  delete row.artifact_mtime_ms
  const segments = store.db.prepare('SELECT * FROM segments WHERE session_id=? ORDER BY seq').all(sessionId)
  const replaces = store.db.prepare('SELECT * FROM replaces WHERE session_id=? ORDER BY seq').all(sessionId)
  const fts = store.db.prepare('SELECT index_text, seq, kind FROM segments_fts WHERE session_id=? ORDER BY seq').all(sessionId)
  return JSON.stringify({ sessionRow: row, segments, replaces, fts })
}

const textOf = (seq: number, body: string) => row(seq, 'user/message', { content: [{ type: 'text', text: body }] })
const ckOf = (seq: number, body: string, start: number, end: number) =>
  row(seq, 'user/message', { content: [{ type: 'text', text: body }] }, { surfaceOp: { op: 'replace', startSeq: start, endSeq: end } })

// ─────────────────────────── 场景 1：普通多轮追加 ───────────────────────────

describe('帧级增量水位（真库全链路）', () => {
  it('场景1 普通 5 轮追加：最终库与一次性全量逐字节一致，增量轮只见新增事件', async () => {
    const home = tempDir()
    const lib = tempDir()
    const ref = tempDir()
    const { path } = sessionDir(home, 'slug-a')
    // 12 事件 5 轮节奏（4/3/2/1/2），无替换对——纯追加基线。
    const batches: string[][] = [
      [row(0, 'step/start', { turn: 1, step: 1 }), textOf(1, 'alpha 第一轮'), textOf(2, 'beta body text'), textOf(3, 'gamma 尾批')],
      [textOf(4, 'delta 第四事件'), textOf(5, 'epsilon 第五事件'), textOf(6, 'zeta 第六事件')],
      [textOf(7, 'eta 第七事件'), textOf(8, 'theta 第八事件')],
      [textOf(9, 'iota 第九事件')],
      [textOf(10, 'kappa 第十事件'), textOf(11, 'lambda 尾事件')],
    ]
    const rig = makeRig(lib)
    const reference = makeRig(ref)
    appendFileSync(path, frame([mkHeader('slug-a'), ...batches[0]!]))
    const r1 = await rig.sync.syncAll({ dshHome: home })
    expect(r1.updated).toBe(1)
    expect(rig.replaceSpy).toHaveBeenCalledTimes(1)
    expect(rig.applySpy).toHaveBeenCalledTimes(0) // 首轮走全量建水位
    appendFileSync(path, frame(batches[1]!))
    expect((await rig.sync.syncAll({ dshHome: home })).updated).toBe(1)
    appendFileSync(path, frame(batches[2]!))
    expect((await rig.sync.syncAll({ dshHome: home })).updated).toBe(1)
    appendFileSync(path, frame(batches[3]!))
    expect((await rig.sync.syncAll({ dshHome: home })).updated).toBe(1)
    appendFileSync(path, frame(batches[4]!))
    expect((await rig.sync.syncAll({ dshHome: home })).updated).toBe(1)

    // 增量口径：4 个增量轮各只见当轮新增（O(新增) 投影面）。
    expect(rig.incProjectSpy).toHaveBeenCalledTimes(4)
    const sizes = [3, 2, 1, 2]
    rig.incProjectSpy.mock.calls.forEach((call, i) => {
      expect((call[0] as readonly DecodedEvent[]).length, `增量轮 ${i + 2} 事件数`).toBe(sizes[i])
      expect((call[0] as readonly DecodedEvent[])[0]!.seq).toBe([4, 7, 9, 10][i])
    })
    // 水位停靠 EOF（无 torn）：offset == 文件终长，consumed == 12 事件。
    const wmRow = rig.store.summaries.get('slug-a')!
    expect(wmRow.frame_consumed).toBe(12)
    expect(wmRow.frame_offset).toBe(statSync(path).size)

    // 参考库：同一完整文件一次性全量。
    const refPath = sessionDir(ref, 'slug-a').path
    const full = Buffer.concat([frame([mkHeader('slug-a'), ...batches[0]!]), ...batches.slice(1).map(b => frame(b))])
    writeFileSync(refPath, full)
    expect((await reference.sync.syncAll({ dshHome: ref })).updated).toBe(1)
    expect(dump(rig.store, 'slug-a')).toBe(dump(reference.store, 'slug-a'))
    rig.store.close()
    reference.store.close()
  })

  it('场景2 翻转：新帧 checkpoint 覆盖旧 seq → onSurface/live 1→0 + 聚合修正，逐字节一致', async () => {
    const home = tempDir()
    const lib = tempDir()
    const ref = tempDir()
    const { path } = sessionDir(home, 'slug-b')
    const rig = makeRig(lib)
    const reference = makeRig(ref)
    // R1：seq3 的 checkpoint 覆盖 [1..2]（表面行 seq1/seq2 进阴影，pair live=1）。
    appendFileSync(path, frame([
      mkHeader('slug-b'),
      row(0, 'step/start', { turn: 1, step: 1 }),
      textOf(1, 'alpha surface body'),
      textOf(2, 'beta surface body'),
      ckOf(3, 'ck1 摘要替身', 1, 2),
    ]))
    expect((await rig.sync.syncAll({ dshHome: home })).updated).toBe(1)
    // 翻转前事实：seq1/seq2 onSurface=0、pair(seq3) live=1。
    expect(rig.store.db.prepare('SELECT on_surface FROM segments WHERE session_id=? AND seq=1').get('slug-b')).toMatchObject({ on_surface: 0 })
    expect(rig.store.db.prepare('SELECT live FROM replaces WHERE session_id=? AND seq=3').get('slug-b')).toMatchObject({ live: 1 })
    // R2：seq4 checkpoint 覆盖 [1..3] → seq1/2/3 onSurface→0、pair(seq3) live→0、
    // grossSaved 扣回 (a−b)、surfaceTokens 减 seq3.tokens。
    appendFileSync(path, frame([ckOf(4, 'ck2 收敛摘身', 1, 3)]))
    expect((await rig.sync.syncAll({ dshHome: home })).updated).toBe(1)
    expect(rig.applySpy).toHaveBeenCalledTimes(1)
    expect(rig.store.db.prepare('SELECT live FROM replaces WHERE session_id=? AND seq=3').get('slug-b')).toMatchObject({ live: 0 })
    expect(rig.store.db.prepare('SELECT on_surface FROM segments WHERE session_id=? AND seq=3').get('slug-b')).toMatchObject({ on_surface: 0 })
    // 参考对拍：同终态全量。
    const refPath = sessionDir(ref, 'slug-b').path
    writeFileSync(refPath, Buffer.concat([
      frame([mkHeader('slug-b'), row(0, 'step/start', { turn: 1, step: 1 }), textOf(1, 'alpha surface body'), textOf(2, 'beta surface body'), ckOf(3, 'ck1 摘要替身', 1, 2)]),
      frame([ckOf(4, 'ck2 收敛摘身', 1, 3)]),
    ]))
    expect((await reference.sync.syncAll({ dshHome: ref })).updated).toBe(1)
    expect(dump(rig.store, 'slug-b')).toBe(dump(reference.store, 'slug-b'))
    rig.store.close()
    reference.store.close()
  })

  it('场景3 悬空链尾补齐：终替被新覆盖 → 指向它的旧行续跳到新终替，逐字节一致', async () => {
    const home = tempDir()
    const lib = tempDir()
    const ref = tempDir()
    const { path } = sessionDir(home, 'slug-c')
    const rig = makeRig(lib)
    const reference = makeRig(ref)
    // R1：seq3 替 seq2（seq2 的 surface 指针停在 3）。
    appendFileSync(path, frame([
      mkHeader('slug-c'),
      row(0, 'step/start', { turn: 1, step: 1 }),
      textOf(1, 'chain head body'),
      textOf(2, 'chain mid body'),
      ckOf(3, 'chain ck1', 2, 2),
    ]))
    expect((await rig.sync.syncAll({ dshHome: home })).updated).toBe(1)
    expect(rig.store.db.prepare('SELECT replaced_by, surface_tokens FROM segments WHERE session_id=? AND seq=2').get('slug-c'))
      .toMatchObject({ replaced_by: 3 })
    // R2：seq5 替 seq3（seq3 进阴影 → seq2 的链尾必须续跳到 5）。
    appendFileSync(path, frame([textOf(4, 'chain bridge'), ckOf(5, 'chain ck2', 3, 3)]))
    expect((await rig.sync.syncAll({ dshHome: home })).updated).toBe(1)
    expect(rig.store.db.prepare('SELECT replaced_by, surface_tokens FROM segments WHERE session_id=? AND seq=2').get('slug-c'))
      .toMatchObject({ replaced_by: 5 })
    // 参考对拍。
    const refPath = sessionDir(ref, 'slug-c').path
    writeFileSync(refPath, Buffer.concat([
      frame([mkHeader('slug-c'), row(0, 'step/start', { turn: 1, step: 1 }), textOf(1, 'chain head body'), textOf(2, 'chain mid body'), ckOf(3, 'chain ck1', 2, 2)]),
      frame([textOf(4, 'chain bridge'), ckOf(5, 'chain ck2', 3, 3)]),
    ]))
    expect((await reference.sync.syncAll({ dshHome: ref })).updated).toBe(1)
    expect(dump(rig.store, 'slug-c')).toBe(dump(reference.store, 'slug-c'))
    rig.store.close()
    reference.store.close()
  })

  it('场景4 torn 重写区 seq 前缀去重：重写回放的历史事件被丢弃，fresh 稠密续起，逐字节一致', async () => {
    const home = tempDir()
    const lib = tempDir()
    const ref = tempDir()
    const { path } = sessionDir(home, 'slug-d')
    const rig = makeRig(lib)
    const reference = makeRig(ref)
    const b1 = frame([mkHeader('slug-d'), row(0, 'step/start', { turn: 1, step: 1 }), textOf(1, 'torn alpha'), textOf(2, 'torn beta')])
    const b2 = frame([textOf(3, 'torn gamma'), textOf(4, 'torn delta')])
    const tornBatch = [textOf(5, 'torn echo'), textOf(6, 'torn foxtrot')]
    const torn = frame(tornBatch)
    const tornStart = b1.length + b2.length
    // R1：完整帧 + 截断帧（模拟宿主崩溃残留）→ 全量同步，水位停 torn 前。
    writeFileSync(path, Buffer.concat([b1, b2, torn.subarray(0, Math.floor(torn.length * 0.6))]))
    expect((await rig.sync.syncAll({ dshHome: home })).updated).toBe(1)
    expect(rig.store.summaries.get('slug-d')!.frame_offset).toBe(tornStart)
    // R2：模拟宿主 truncateTornTail + 重写（截掉 torn 字节，原批完整帧重写）+ 新帧追加。
    const b3full = frame(tornBatch)
    const b4 = frame([textOf(7, 'torn golf'), textOf(8, 'torn hotel')])
    writeFileSync(path, Buffer.concat([b1, b2, b3full, b4]))
    expect((await rig.sync.syncAll({ dshHome: home })).updated).toBe(1)
    expect(rig.applySpy).toHaveBeenCalledTimes(1)
    // 参考对拍：终态文件一次性全量。
    const refPath = sessionDir(ref, 'slug-d').path
    writeFileSync(refPath, Buffer.concat([
      frame([mkHeader('slug-d'), row(0, 'step/start', { turn: 1, step: 1 }), textOf(1, 'torn alpha'), textOf(2, 'torn beta')]),
      frame([textOf(3, 'torn gamma'), textOf(4, 'torn delta')]),
      b3full, b4,
    ]))
    expect((await reference.sync.syncAll({ dshHome: ref })).updated).toBe(1)
    expect(dump(rig.store, 'slug-d')).toBe(dump(reference.store, 'slug-d'))
    rig.store.close()
    reference.store.close()
  })

  it('场景5 回缩守卫：文件短于水位 → 回退全量重建（replaceSession 面，applyIncrement 零调用）', async () => {
    const home = tempDir()
    const lib = tempDir()
    const { path } = sessionDir(home, 'slug-e')
    const rig = makeRig(lib)
    appendFileSync(path, frame([mkHeader('slug-e'), row(0, 'step/start', { turn: 1, step: 1 }), textOf(1, 'shrink alpha'), textOf(2, 'shrink beta'), textOf(3, 'shrink gamma')]))
    expect((await rig.sync.syncAll({ dshHome: home })).updated).toBe(1)
    expect(rig.store.summaries.get('slug-e')!.frame_consumed).toBe(4)
    // 模拟宿主 rollbackAppend：文件回缩（保留合法前缀形状——header+3 事件）。
    writeFileSync(path, frame([mkHeader('slug-e'), row(0, 'step/start', { turn: 1, step: 1 }), textOf(1, 'shrink alpha'), textOf(2, 'shrink beta')]))
    const applyBefore = rig.applySpy.mock.calls.length
    const replaceBefore = rig.replaceSpy.mock.calls.length
    expect((await rig.sync.syncAll({ dshHome: home })).updated).toBe(1)
    expect(rig.applySpy.mock.calls.length - applyBefore).toBe(0)
    expect(rig.replaceSpy.mock.calls.length - replaceBefore).toBe(1)
    // 回退全量后水位重建（回缩文件的 EOF）。
    expect(rig.store.summaries.get('slug-e')!.frame_consumed).toBe(3)
    rig.store.close()
  })

  it('场景6 口径漂移守卫：水位 basis 与本轮不一致 → 回退全量（不混算 token）', async () => {
    const home = tempDir()
    const lib = tempDir()
    const { path } = sessionDir(home, 'slug-f')
    const rig = makeRig(lib)
    appendFileSync(path, frame([mkHeader('slug-f'), row(0, 'step/start', { turn: 1, step: 1 }), textOf(1, 'basis alpha body'), textOf(2, 'basis beta body')]))
    expect((await rig.sync.syncAll({ dshHome: home })).updated).toBe(1)
    // 直接改水位口径档（等价"换计数器"）→ 下轮必须走全量。改缓存层 2 的
    // Map（端口读取源；生产等价路径=重启后 Map 从 DB 重载）。
    ;(rig.store.summaries.get('slug-f') as SessionRow).frame_basis = 'other-basis'
    const applyBefore = rig.applySpy.mock.calls.length
    const replaceBefore = rig.replaceSpy.mock.calls.length
    appendFileSync(path, frame([textOf(3, 'basis gamma body')]))
    expect((await rig.sync.syncAll({ dshHome: home })).updated).toBe(1)
    expect(rig.applySpy.mock.calls.length - applyBefore).toBe(0)
    expect(rig.replaceSpy.mock.calls.length - replaceBefore).toBe(1)
    // 全量重建后口径恢复为本轮口径。
    expect(rig.store.summaries.get('slug-f')!.frame_basis).toBe('chars/4')
    rig.store.close()
  })

  it('场景7 增量轮水位逐轮推进（O(新增) 读取面：offset 增量 == 追加帧字节）', async () => {
    const home = tempDir()
    const lib = tempDir()
    const { path } = sessionDir(home, 'slug-g')
    const rig = makeRig(lib)
    appendFileSync(path, frame([mkHeader('slug-g'), row(0, 'step/start', { turn: 1, step: 1 }), textOf(1, 'ofs alpha body')]))
    expect((await rig.sync.syncAll({ dshHome: home })).updated).toBe(1)
    const off1 = rig.store.summaries.get('slug-g')!.frame_offset
    const b2 = frame([textOf(2, 'ofs beta body'), textOf(3, 'ofs gamma body')])
    appendFileSync(path, b2)
    expect((await rig.sync.syncAll({ dshHome: home })).updated).toBe(1)
    const off2 = rig.store.summaries.get('slug-g')!.frame_offset
    expect(off2 - off1).toBe(b2.length) // 水位推进 == 追加帧字节（读取面 O(新增)）
    rig.store.close()
  })
})

// ─────────────────────────── 尾段解码器单元面 ───────────────────────────

describe('decodeSessionLogTailAsync', () => {
  it('非魔数尾段 boundaryOk=false（明文产物/字节错位不猜）', async () => {
    const read = await decodeSessionLogTailAsync(Buffer.from('plain text, not frames\n', 'utf8'))
    expect(read.boundaryOk).toBe(false)
    expect(read.events).toHaveLength(0)
  })

  it('torn 帧不消费：consumedEndOffset 停在 torn 起点，事件只含完整帧', async () => {
    // 真实增量尾段从 frame_offset 起——首帧（含 header 行）不在尾段视界内。
const f1 = frame([row(0, 'user/message', { content: [{ type: 'text', text: '完整帧事件' }] })])
    const f2 = frame([row(1, 'user/message', { content: [{ type: 'text', text: '被截断帧事件' }] })])
    const torn = f2.subarray(0, Math.floor(f2.length * 0.5))
    const read = await decodeSessionLogTailAsync(Buffer.concat([f1, torn]))
    expect(read.boundaryOk).toBe(true)
    expect(read.frames).toBe(1)
    expect(read.consumedEndOffset).toBe(f1.length)
    expect(read.events).toHaveLength(1)
    expect(read.events[0]!.seq).toBe(0)
    expect(read.lastSeq).toBe(0)
  })

  it('干净尾段：consumedEndOffset = 尾段长度，事件稠密且 seq 为绝对值', async () => {
    const f1 = frame([row(7, 'user/message', { content: [{ type: 'text', text: 'seq7 事件' }] })])
    const f2 = frame([row(8, 'user/message', { content: [{ type: 'text', text: 'seq8 事件' }] })])
    const read = await decodeSessionLogTailAsync(Buffer.concat([f1, f2]))
    expect(read.boundaryOk).toBe(true)
    expect(read.firstSeq).toBe(7)
    expect(read.lastSeq).toBe(8)
    expect(read.consumedEndOffset).toBe(f1.length + f2.length)
    expect(read.issues).toHaveLength(0)
  })
})
