/**
 * task_4 blocks 叶子断言：同文同 hash/异文异 hash/空文 null/幂等重入单份/
 * created_at 走 DDL 缺省。
 */
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { BlocksStore, BLOCKS_DDL, hashOf } from '../src/blocks.ts'

function freshStore(): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  db.exec(BLOCKS_DDL)
  return db
}

describe('hashOf', () => {
  it('确定性 sha256 hex 64：同文同 hash，异文异 hash', () => {
    expect(hashOf('hello')).toBe(hashOf('hello'))
    expect(hashOf('hello')).toHaveLength(64)
    expect(hashOf('hello')).not.toBe(hashOf('hello '))
    // 已知向量：sha256("abc")
    expect(hashOf('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  })
})

describe('BlocksStore.ensure', () => {
  it('入典返回 hash 且 body 可回读', () => {
    const db = freshStore()
    const blocks = new BlocksStore(db)
    const h = blocks.ensure('字块内容')
    expect(h).toBe(hashOf('字块内容'))
    const row = db.prepare('SELECT body, bytes FROM blocks WHERE hash=?').get(h!) as { body: string; bytes: number }
    expect(row.body).toBe('字块内容')
    expect(row.bytes).toBe(Buffer.byteLength('字块内容', 'utf8'))
  })

  it('空文本不入典返回 null（重复空也只此一形）', () => {
    const db = freshStore()
    const blocks = new BlocksStore(db)
    expect(blocks.ensure('')).toBeNull()
    expect(Number(db.prepare('SELECT COUNT(*) c FROM blocks').get()!.c)).toBe(0)
  })

  it('幂等重入：同文多次 ensure 字典恒一行；异文各行', () => {
    const db = freshStore()
    const blocks = new BlocksStore(db)
    for (let i = 0; i < 5; i++) blocks.ensure('重复段落')
    blocks.ensure('另一段落')
    const rows = db.prepare('SELECT COUNT(*) c FROM blocks').get()!
    expect(Number(rows.c)).toBe(2)
  })

  it('created_at 由 DDL 缺省填充（非 JS 时钟）', () => {
    const db = freshStore()
    const blocks = new BlocksStore(db)
    blocks.ensure('ts-block')
    const row = db.prepare('SELECT created_at FROM blocks WHERE hash=?').get(hashOf('ts-block')) as { created_at: string }
    expect(typeof row.created_at).toBe('string')
    expect(row.created_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/u)
  })
})
