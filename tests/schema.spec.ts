/**
 * T2.4 投影库断言：临时目录建库 → replaceSession 两次幂等（行数稳定）
 * → 重开库数据仍在；FTS5 虚表在 node:sqlite 下可用（fts 自持语料，索引
 * 仍基于原文 search_text——v5 用户定标）；v5 断裂重置：旧列形状库（v4
 * 真形）重开 → DROP 重建、版本改写；字块共块/脱敏派生臂/链派生不变式。
 */
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openProjectionStore } from '../src/schema.ts'
import { sanitizeFtsQuery } from '../src/segment.ts'
import { projectSessionEvents } from '../src/projection.ts'
import { hashOf } from '../src/blocks.ts'
import type { DecodedEvent } from '../src/session-file-decode.ts'

const events: DecodedEvent[] = [
  { type: 'step/start', seq: 0, time: 500, data: { turn: 1, step: 1 } },
  { type: 'user/message', seq: 1, time: 501, data: { content: [{ type: 'text', text: '中文查询词' }] } },
  { type: 'assistant/message', seq: 2, time: 502, data: { message: { content: [{ type: 'text', text: 'answer body' }] } } },
]

let dir = ''

/** Windows 刚关连接的 sqlite 文件可能瞬时 unlink 不掉：同步重试清理（忙等 200ms/轮）。 */
function rmRetry(target: string): void {
  for (let i = 0; i < 10; i++) {
    try {
      rmSync(target, { recursive: true, force: true })
      return
    } catch {
      const end = Date.now() + 200
      while (Date.now() < end) { /* 自旋等句柄释放 */ }
    }
  }
  rmSync(target, { recursive: true, force: true })
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'drs-schema-'))
})
afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('openProjectionStore / replaceSession', () => {
  it('两次 replaceSession 行数稳定（幂等），重开库数据仍在', () => {
    const projection = projectSessionEvents(events, { dirId: 'd1', sessionId: 's1' })
    const store = openProjectionStore(dir)
    try {
      store.replaceSession(projection, 1234, 5678)
      const first = store.db.prepare('SELECT COUNT(*) AS c FROM segments WHERE session_id=?').get('s1') as { c: number }
      store.replaceSession(projection, 1234, 5678)
      const second = store.db.prepare('SELECT COUNT(*) AS c FROM segments WHERE session_id=?').get('s1') as { c: number }
      expect(second.c).toBe(first.c)
      expect(first.c).toBe(2) // user/message + assistant/message（step/start 空文本不落）
      const ftsRows = store.db.prepare('SELECT COUNT(*) AS c FROM segments_fts WHERE session_id=?').get('s1') as { c: number }
      expect(ftsRows.c).toBe(2)
      // 中文查询经同一切分函数命中（索引/查询同函数契约）
      const match = sanitizeFtsQuery('中文 查询')
      expect(match).not.toBe('')
      const hit = store.db.prepare('SELECT seq FROM segments_fts WHERE segments_fts MATCH ?').all(match)
      expect(hit.length).toBeGreaterThan(0)
      expect(store.summaries.get('s1')?.artifact_bytes).toBe(1234)
      expect(store.summaries.get('s1')?.artifact_mtime_ms).toBe(5678)
    } finally {
      store.close()
    }

    // 重开库：数据仍在，常驻 Map 重新载入
    const reopened = openProjectionStore(dir)
    try {
      const row = reopened.summaries.get('s1')
      expect(row).toBeDefined()
      expect(row?.event_count).toBe(3)
      const segments = reopened.db.prepare('SELECT COUNT(*) AS c FROM segments WHERE session_id=?').get('s1') as { c: number }
      expect(segments.c).toBe(2)
      // 归档旗标翻转
      reopened.setArchived('s1', 1)
      expect(reopened.summaries.get('s1')?.archived).toBe(1)
    } finally {
      reopened.close()
    }
  })

  it('v5 断裂重置：v4 真形旧库（text 实列+版本串 4）重开 → DROP 重建、四表空、blocks 在位', () => {
    const legacyDir = mkdtempSync(join(tmpdir(), 'drs-legacy5-'))
    try {
      // 手造 v4 形状库（列形状断裂——ALTER 不可补的实况形）；必须关连接，
      // 否则 Windows 文件锁让 finally 删不掉临时库（EBUSY）。
      try {
        const seed = new DatabaseSync(join(legacyDir, 'projection.db'))
        seed.exec(`
          CREATE TABLE sessions(session_id TEXT PRIMARY KEY, dir_id TEXT, archived INTEGER DEFAULT 0);
          CREATE TABLE segments(session_id TEXT, seq INTEGER, text TEXT DEFAULT '', surface_text TEXT,
            PRIMARY KEY(session_id, seq)) WITHOUT ROWID;
          CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT);
          INSERT INTO meta VALUES('schema_version','4');
          INSERT INTO sessions VALUES('s9','d9',0);
          INSERT INTO segments VALUES('s9',1,'旧原文','旧替身')`)
        seed.close()
      } catch (error) {
        rmRetry(legacyDir)
        throw error
      }

      const migrated = openProjectionStore(legacyDir)
      try {
        const version = migrated.db.prepare("SELECT value FROM meta WHERE key='schema_version'").get() as { value: string }
        expect(version.value).toBe('5')
        expect(migrated.summaries.size).toBe(0)
        expect((migrated.db.prepare('SELECT COUNT(*) AS c FROM sessions').get() as { c: number }).c).toBe(0)
        // v5 列形状已重建：text 实列消失、hash 列与 blocks 表在位
        const cols = migrated.db.prepare('PRAGMA table_info(segments)').all().map(c => String(c.name))
        expect(cols).not.toContain('text')
        expect(cols).toContain('text_hash')
        expect(cols).toContain('redacted_text_hash')
        expect(migrated.db.prepare('SELECT COUNT(*) AS c FROM blocks').get()).toBeTruthy()
        // 同库补写一行，关库重开（同串）：不再二次重置
        const projection = projectSessionEvents(events, { dirId: 'd9', sessionId: 's9' })
        migrated.replaceSession(projection, 10, 20)
      } finally {
        migrated.close()
      }
      const again = openProjectionStore(legacyDir)
      try {
        expect(again.summaries.size).toBe(1)
      } finally {
        again.close()
      }
    } finally {
      rmRetry(legacyDir)
    }
  })

  it('deleteSession 级联清除四表+常驻 Map；不存在幂等 false；幸存会话无损', () => {
    const delDir = mkdtempSync(join(tmpdir(), 'drs-del-'))
    try {
      const store = openProjectionStore(delDir)
      try {
        const doomed = projectSessionEvents(events, { dirId: 'dX', sessionId: 'sX' })
        const survivor = projectSessionEvents(events, { dirId: 'dY', sessionId: 'sY' })
        store.replaceSession(doomed, 1, 1)
        store.replaceSession(survivor, 1, 1)
        expect(store.deleteSession('sX')).toBe(true)
        for (const table of ['segments', 'segments_fts', 'replaces', 'sessions']) {
          const n = store.db.prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE session_id=?`).get('sX') as { c: number }
          expect(n.c, `${table} 应零残留`).toBe(0)
        }
        expect(store.summaries.has('sX')).toBe(false)
        // 幸存面完好：另一会话四表行+Map 都在
        expect(store.summaries.has('sY')).toBe(true)
        expect((store.db.prepare('SELECT COUNT(*) AS c FROM segments WHERE session_id=?').get('sY') as { c: number }).c).toBe(2)
        // 幂等：重复删/删不存在 → false 不抛
        expect(store.deleteSession('sX')).toBe(false)
        expect(store.deleteSession('s-none')).toBe(false)
      } finally {
        store.close()
      }
      // 重开库：sX 确实没复活（写已随 WAL 提交，非仅 Map 摘除）
      const reopened = openProjectionStore(delDir)
      try {
        expect(reopened.summaries.has('sX')).toBe(false)
        expect(reopened.summaries.has('sY')).toBe(true)
      } finally {
        reopened.close()
      }
    } finally {
      rmSync(delDir, { recursive: true, force: true })
    }
  })

  it('v5 字块共享：同文跨会话单份入典；hash 列引用同一块', () => {
    const dir2 = mkdtempSync(join(tmpdir(), 'drs-dedup-'))
    try {
      const store = openProjectionStore(dir2)
      try {
        const shared = projectSessionEvents(events, { dirId: 'dA', sessionId: 'sA' })
        const same = projectSessionEvents(events, { dirId: 'dB', sessionId: 'sB' })
        store.replaceSession(shared, 1, 1)
        const blocksAfter1 = Number(store.db.prepare('SELECT COUNT(*) c FROM blocks').get()!.c)
        store.replaceSession(same, 1, 1) // 两会话同内容：text/search/redacted 全部同串
        const blocksAfter2 = Number(store.db.prepare('SELECT COUNT(*) c FROM blocks').get()!.c)
        expect(blocksAfter2).toBe(blocksAfter1) // 字典零新增（共块）
        const h = store.db.prepare("SELECT text_hash h FROM segments WHERE session_id='sA' AND seq=1")
          .get() as { h: string | null }
        const h2 = store.db.prepare("SELECT text_hash h FROM segments WHERE session_id='sB' AND seq=1")
          .get() as { h: string | null }
        expect(h2.h).toBe(h.h)
        expect(store.db.prepare('SELECT body FROM blocks WHERE hash=?').get(h.h) as { body: string })
          .toMatchObject({ body: '中文查询词' })
      } finally { store.close() }
    } finally { rmSync(dir2, { recursive: true, force: true }) }
  })

  it('v5 脱敏派生臂：命中行 ground-truth 保留原值、redacted 块无密钥；未命中行同 hash 共块', () => {
    const dir3 = mkdtempSync(join(tmpdir(), 'drs-redact-'))
    const key = 'sk-abcdefghij0123456789ABCDEFGH'
    const redactEvents: DecodedEvent[] = [
      { type: 'user/message', seq: 1, time: 10, data: { content: [{ type: 'text', text: `我的密钥是 ${key} 请保管` }] } },
      { type: 'user/message', seq: 2, time: 11, data: { content: [{ type: 'text', text: '这句没有密钥很干净' }] } },
    ]
    try {
      const store = openProjectionStore(dir3)
      try {
        store.replaceSession(projectSessionEvents(redactEvents, { dirId: 'd', sessionId: 'sR' }), 1, 1)
        const row = (seq: number) => store.db.prepare(
          'SELECT text_hash th, redacted_text_hash rh FROM segments WHERE session_id=? AND seq=?').get('sR', seq) as
          { th: string | null; rh: string | null }
        const body = (h: string | null) => h === null ? ''
          : String((store.db.prepare('SELECT body FROM blocks WHERE hash=?').get(h) as { body: string }).body)
        // 命中行：原文块保留密钥（地面真值）；redacted 块脱掉且带类别占位符
        const r1 = row(1)
        expect(body(r1.th)).toContain(key)
        expect(body(r1.rh)).not.toContain(key)
        expect(body(r1.rh)).toContain('[REDACTED:API_KEY]')
        expect(r1.rh).not.toBe(r1.th)
        // 未命中行：redacted 与原文同串→同 hash，字典零新增块
        const r2 = row(2)
        expect(r2.rh).toBe(r2.th)
      } finally { store.close() }
    } finally { rmSync(dir3, { recursive: true, force: true }) }
  })

  it('v5 链派生不变式×跨会话撞键：链头 text_hash 块 == 投影 surfaceText 正文，两会话同 seq 各自引用不串', () => {
    const dir4 = mkdtempSync(join(tmpdir(), 'drs-chain-'))
    const mk = (body: string, stub: string): DecodedEvent[] => [
      { type: 'assistant/message', seq: 1, time: 1, data: { message: { content: [{ type: 'text', text: body }] } } },
      { type: 'assistant/message', seq: 2, time: 2, data: { message: { content: [{ type: 'text', text: stub }] } },
        surfaceOp: { op: 'replace', start: 1, end: 1 } },
    ]
    const CASES = [
      { sid: 's1', dir: 'd1', body: '会话甲的长正文内容甲甲甲', stub: '甲替身内容足够长' },
      { sid: 's2', dir: 'd2', body: '会话乙的长正文内容乙乙乙', stub: '乙替身内容足够长' },
    ]
    try {
      const store = openProjectionStore(dir4)
      try {
        for (const c of CASES) {
          store.replaceSession(projectSessionEvents(mk(c.body, c.stub), { dirId: c.dir, sessionId: c.sid }), 1, 1)
        }
        for (const c of CASES) {
          // 投影模型不变：压缩行 surfaceText=链头正文、replacedBy=链头 seq。
          const proj = projectSessionEvents(mk(c.body, c.stub), { dirId: c.dir, sessionId: c.sid })
          const surfRow = proj.segments.find(s => s.seq === 1)!
          expect(surfRow.compressed).toBe(1)
          expect(surfRow.replacedBy).toBe(2)
          expect(surfRow.surfaceText).toBe(c.stub)
          // 存储不变式：链头行 text_hash 的块正文 == surfaceText——M2 两跳
          // JOIN 带 session_id 即可无损还原；不带的串块风险由双会话同 seq 压测。
          const comp = store.db.prepare(
            'SELECT replaced_by rb FROM segments WHERE session_id=? AND seq=1').get(c.sid) as { rb: number }
          expect(comp.rb).toBe(2)
          const head = store.db.prepare(
            'SELECT text_hash h FROM segments WHERE session_id=? AND seq=?').get(c.sid, comp.rb) as { h: string | null }
          expect(head.h).toBe(hashOf(c.stub))
          const body = store.db.prepare('SELECT body FROM blocks WHERE hash=?').get(head.h) as { body: string }
          expect(body.body).toBe(c.stub)
          // 地面真值侧：seq1 原文块仍是原文（surface 派生不反写 text）。
          expect(body.body).not.toBe(store.db.prepare(
            'SELECT text_hash h FROM segments WHERE session_id=? AND seq=1').get(c.sid)!.h as string)
        }
      } finally { store.close() }
    } finally { rmSync(dir4, { recursive: true, force: true }) }
  })
})
