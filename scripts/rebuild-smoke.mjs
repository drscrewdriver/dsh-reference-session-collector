// 真语料重建冒烟（v5 task_15）：临时目录全新建库 → 对真实 ~/.dsh/sessions
// 跑一轮 syncAll（只读，绝不碰会话文件与装机目录）→ 体积/倍率对账 ≤3.5×。
// 口径：原契约 ≤3×（预估 15.5MB）；实测 20.25MB=3.22× 且 freelist=0/VACUUM
// 无效——超标为结构性（blocks 9.64MB + fts 自持与倒排 5-6MB），用户拍板
// 2026-10-20 校准到实测地板并留余量。对照 v4 同语料 115MB(≈18×)。
// 跑法：pnpm build && pnpm smoke:real
import { mkdtempSync, rmSync, readdirSync, statSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
const m = await import('../lib/index.js')

const RATIO_CEILING = 3.5

/** Windows 刚关连接的 sqlite 文件（mmap 句柄）可能短时 unlink 不掉：同步重试，
 * 仍失败则顺延（下轮开局清扫）——清理竞态绝不遮蔽冒烟结论。 */
function rmRetry(target, rounds = 10) {
  for (let i = 0; i < rounds; i += 1) {
    try {
      rmSync(target, { recursive: true, force: true })
      return true
    } catch {
      const end = Date.now() + 200
      while (Date.now() < end) { /* 忙等句柄释放 */ }
    }
  }
  try {
    rmSync(target, { recursive: true, force: true })
    return true
  } catch {
    return false
  }
}

/** 开局清扫历史残留的 drs-rebuild-* 临时库（上轮 EBUSY 顺延项）。 */
function sweepStale() {
  for (const entry of readdirSync(tmpdir())) {
    if (!entry.startsWith('drs-rebuild-')) continue
    try {
      rmSync(join(tmpdir(), entry), { recursive: true, force: true })
    } catch { /* 仍被占用的交给下一轮 */ }
  }
}

/** 语料域：会话目录全部文件的字节和（压缩域整体，与 findings 6.28MB 口径一致）。 */
function corpusBytes(root) {
  let total = 0
  let files = 0
  const walk = dir => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name)
      if (entry.isDirectory()) walk(p)
      else {
        total += statSync(p).size
        files += 1
      }
    }
  }
  walk(root)
  return { total, files }
}

const dshHome = join(homedir(), '.dsh')
sweepStale()
const dir = mkdtempSync(join(tmpdir(), 'drs-rebuild-'))
try {
  const store = m.openProjectionStore(dir)
  const port = m.createStorePort(store)
  const sync = new m.ProjectionSync({
    store: port,
    project: (events, options) => m.projectSessionEvents(events, {
      dirId: options.dirId,
      ...(options.header === undefined ? {} : { header: options.header }),
      ...(options.exactCounter === undefined ? {} : {
        exactCounter: (text) => {
          const count = options.exactCounter?.(text)
          return count !== undefined && count.kind === 'exact-tokenizer'
            ? count.tokens
            : Math.ceil(text.length / 4)
        },
      }),
    }),
  })
  const result = await sync.syncAll({ dshHome })
  if (result.failures.length > 0) throw new Error(`rebuild failures: ${JSON.stringify(result.failures)}`)
  const second = await sync.syncAll({ dshHome })
  if (!(second.updated === 0 && second.skipped === result.updated)) {
    throw new Error(`二轮未 stat 全命中: updated=${second.updated} skipped=${second.skipped}`)
  }
  const meta = port.blocksWatermark()
  const segments = store.db.prepare('SELECT COUNT(*) AS c FROM segments').get()
  store.close() // 干净关库=WAL checkpoint——db 文件大小即全量占用
  const dbSize = statSync(join(dir, 'projection.db')).size
  const { total, files } = corpusBytes(join(dshHome, 'sessions'))
  const ratio = total > 0 ? dbSize / total : 0
  console.log(`REBUILD sessions=${result.updated} segments=${Number(segments.c)} basis=${result.basis} dict-max-rowid=${meta.current} persisted=${meta.last}`)
  console.log(`corpus=${files} files ${(total / 1048576).toFixed(2)}MB | v5 db=${(dbSize / 1048576).toFixed(2)}MB | ratio=${ratio.toFixed(2)}x (ceiling ${RATIO_CEILING}x)`)
  if (total === 0) throw new Error('真语料为空——冒烟无对账面')
  if (ratio > RATIO_CEILING) throw new Error(`倍率 ${ratio.toFixed(2)}x 超上限 ${RATIO_CEILING}x`)
  console.log('REBUILD_SMOKE_OK')
} finally {
  if (!rmRetry(dir)) console.log('DEFERRED_CLEANUP（句柄未释放，下轮开局清扫）')
}
