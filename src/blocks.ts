/**
 * 字块字典（schema v5，2026-10-20 用户定标「整条一起存相同字块」）：
 * segments 的 text/search_text/redacted_* 一律以 sha256 全串等值 hash 入
 * 本字典，行内只存引用；同文=同 hash=单份存储（INSERT OR IGNORE 幂等）。
 *
 * 选型依据（真机实测）：surface_text 1768 行仅 23 distinct（99.2%）；
 * text 11% / search_text 12% 整段重复；重复组字节跨度大→前缀键/分块切分
 * 会撕裂等值判定，全串 hash 是唯一可靠粒度。hash 用 node:crypto sha256
 * （零新增依赖；弃 blake3）。
 *
 * 纪律：字典只增不删（deleteSession 清行不清块——共享块归属不可知），
 * 投影可重建、体积有上界（语料 distinct 集）；GC 属明示不做项。
 */
import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'

/** blocks 表 DDL（单一事实源：schema.ts 与测试拼库都引本常量）。 */
export const BLOCKS_DDL = `CREATE TABLE IF NOT EXISTS blocks(
  hash TEXT PRIMARY KEY, body TEXT NOT NULL, bytes INTEGER NOT NULL,
  created_at TEXT DEFAULT (datetime('now')));`

/** sha256 hex（64 字符）——全串等值键。 */
export function hashOf(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

export class BlocksStore {
  private readonly insert: ReturnType<DatabaseSync['prepare']>

  constructor(db: DatabaseSync) {
    this.insert = db.prepare('INSERT OR IGNORE INTO blocks(hash, body, bytes) VALUES(?,?,?)')
  }

  /**
   * 入字典并返回引用 hash；空文本不入典返回 null（hash 列存 NULL，读侧还原
   * 为 ''——「未落行文本」与「空文本」在 v4 就靠此区分，语义不变）。
   * 幂等：同文重复 ensure 只落一份（INSERT OR IGNORE + hash 主键）。
   */
  ensure(text: string): string | null {
    if (text === '') return null
    const hash = hashOf(text)
    this.insert.run(hash, text, Buffer.byteLength(text, 'utf8'))
    return hash
  }
}
