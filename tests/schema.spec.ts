/**
 * T2.4 投影库断言：临时目录建库 → replaceSession 两次幂等（行数稳定）
 * → 重开库数据仍在；FTS5 虚表在 node:sqlite 下可用（普通表直插）；
 * v4 断裂迁移：旧库 schema_version 异串 → 整库清空重建。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openProjectionStore } from '../src/schema.ts'
import { sanitizeFtsQuery } from '../src/segment.ts'
import { projectSessionEvents } from '../src/projection.ts'
import type { DecodedEvent } from '../src/session-file-decode.ts'

const events: DecodedEvent[] = [
  { type: 'step/start', seq: 0, time: 500, data: { turn: 1, step: 1 } },
  { type: 'user/message', seq: 1, time: 501, data: { content: [{ type: 'text', text: '中文查询词' }] } },
  { type: 'assistant/message', seq: 2, time: 502, data: { message: { content: [{ type: 'text', text: 'answer body' }] } } },
]

let dir = ''

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

  it('v3 断裂迁移：meta 旧串 v2 的库重开 → 四表清空、版本改写、常驻 Map 空', () => {
    const legacyDir = mkdtempSync(join(tmpdir(), 'drs-legacy-'))
    const projection = projectSessionEvents(events, { dirId: 'd9', sessionId: 's9' })
    const seed = openProjectionStore(legacyDir)
    seed.replaceSession(projection, 10, 20)
    // 模拟旧库：把版本串改回 v3（列结构同构，只有版本差异）
    seed.db.prepare("UPDATE meta SET value='3' WHERE key='schema_version'").run()
    seed.close()

    const migrated = openProjectionStore(legacyDir)
    try {
      const version = migrated.db.prepare("SELECT value FROM meta WHERE key='schema_version'").get() as { value: string }
      expect(version.value).toBe('4')
      expect(migrated.summaries.size).toBe(0)
      expect((migrated.db.prepare('SELECT COUNT(*) AS c FROM sessions').get() as { c: number }).c).toBe(0)
      expect((migrated.db.prepare('SELECT COUNT(*) AS c FROM segments').get() as { c: number }).c).toBe(0)
      expect((migrated.db.prepare('SELECT COUNT(*) AS c FROM segments_fts').get() as { c: number }).c).toBe(0)
      // 同库补写一行，关库重开（同串）：不再触发二次清空
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
    rmSync(legacyDir, { recursive: true, force: true })
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
})
