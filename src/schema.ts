/**
 * 投影库装配（spec §DDL）：node:sqlite 五表一虚表（sessions/segments/replaces/
 * blocks/meta + segments_fts）+ WAL/mmap 缓存层 1 + sessions 汇总常驻 Map
 * （缓存层 2）。写纪律：每 session 全量重写式替换（事务内 DELETE+INSERT），
 * 幂等；字块一律走 blocks 字典 hash 引用（v5），脱敏派生臂同源生成。
 *
 * 本库只落在 ~/.dsh-reference-session-collector/projection.db ——绝不触碰会话文件。
 */
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { SessionIncrementDelta, SessionProjection, SessionSummary } from './projection.ts'
import { segmentForIndex } from './segment.ts'
import { BlocksStore, BLOCKS_DDL } from './blocks.ts'
import { redactSecrets } from './redact.ts'

/** schema 版本（meta 表；断裂式迁移的比对基线）。
 * v2=加 sessions.format_generation；
 * v3=search_text 视界变更（剥离宿主注入样板段）；
 * v4=账目双修（data.content 双臂 + replaces.live）；
 * v5=字块共享 + 脱敏派生臂（2026-10-20 用户定标）：text/search_text/
 *   surface_text 实列退役→blocks 字典 hash 引用（surface 经 replaced_by
 *   链派生）；新 redacted_text_hash/redacted_search_text_hash（redactSecrets
 *   派生臂，CCI 口径 text 的 token 数学不动）；旧库列形状断裂→DROP 重建
 *   + VACUUM（投影可重建，丢行无损）。
 * v6=帧级增量水位（issue #3）：sessions 加 frame_* 六列——frame_offset
 *   （下一帧字节偏移，-1=无水位）、frame_consumed（已投影事件数，seq 稠密
 *   基线）、frame_roll_turn/step（滚动归属续算状态）、frame_basis（token
 *   口径档，变化即回退全量）、frame_artifact（水位所属产物文件名，换代=
 *   新文件=旧偏移作废）。旧库 DROP 重建→首轮全量重建投影并立水位。 */
export const PROJECTION_SCHEMA_VERSION = '6'

/** sessions 表原始行（snake_case 与 DDL 一致）。 */
export interface SessionRow {
  session_id: string
  dir_id: string
  title: string
  cwd: string
  event_count: number
  max_seq: number
  turn_count: number
  segment_tokens: number
  surface_tokens: number
  gross_saved: number
  recall_tokens: number
  compress_pairs: number
  recall_pairs: number
  basis: string
  artifact_bytes: number
  artifact_mtime_ms: number
  last_time_ms: number
  format_generation: number
  archived: number
  synced_at: string
  frame_offset: number
  frame_consumed: number
  frame_roll_turn: number
  frame_roll_step: number
  frame_basis: string
  frame_artifact: string
}

/**
 * 帧级增量水位（v6，issue #3）：记录"已消费到哪个字节偏移"。
 * 不变式：frame_offset 恰落在帧边界（或 torn 区域起点）；frame_consumed
 * 与投影内容严格一致（含 torn 抢救行——宿主重写区按 seq 前缀去重）。
 */
export interface FrameWatermark {
  /** 下一帧的字节偏移；-1 = 无水位（明文产物/未建立）。 */
  frame_offset: number
  /** 已投影事件数（事件 seq 稠密 0..consumed-1）。 */
  frame_consumed: number
  /** 水位处的 turn/step 滚动归属（下一帧续算初值）。 */
  frame_roll_turn: number
  frame_roll_step: number
  /** token 口径档（'chars/4'|'ds-token'）；与本轮口径不一致→回退全量。 */
  frame_basis: string
  /** 水位所属产物文件名；换代=新文件=旧偏移作废。 */
  frame_artifact: string
}

/** replaceSession 的产物 watermark 附加项。 */
export interface ReplaceSessionExtra {
  /** 归档集标志（sync 侧按 workspace.json 只读跟随）。 */
  archived?: 0 | 1
  /** 预置标题（steward 切料同款，缺省用 projection.summary.title）。 */
  title?: string
  /** 帧级水位（全量同步成功后建立；明文产物不写=下次仍全量）。 */
  frame?: FrameWatermark
}

/** 增量落库的先验行视图（applyIncrement/getSessionState 的存储侧窄投影）。 */
export interface StoredSegmentView {
  seq: number
  tokens: number
  on_surface: number
  compressed: number
  replaced_by: number | null
  surface_tokens: number | null
}

export interface StoredReplaceView {
  seq: number
  start_seq: number
  end_seq: number
  a_tokens: number
  b_tokens: number
  kind: 'compress' | 'recall'
  live: number
}

/** 一个会话的先验状态（增量投影的折叠基座；由 getSessionState 产出）。 */
export interface SessionPriorState {
  row: SessionRow
  segments: StoredSegmentView[]
  replaces: StoredReplaceView[]
}

/** 投影库句柄。 */
export interface ProjectionStore {
  db: DatabaseSync
  /** 缓存层 2：sessions 全表常驻（~百行级），status/sessions 列表 0 SQL。 */
  summaries: Map<string, SessionRow>
  /** 事务式全量重写一个会话；提交后增量更新常驻行。 */
  replaceSession(projection: SessionProjection, artifactBytes: number, artifactMtimeMs: number, extra?: ReplaceSessionExtra): void
  /**
   * 先验状态读取（帧级增量投影的折叠基座，issue #3）：sessions 行 + 全量
   * segments/replaces 窄视图。O(会话行数) 的纯 SQL 读，无解压——相对被
   * 消掉的 zstd 重解压是数量级更小的成本（README「规模边界」已标注）。
   */
  getSessionState(sessionId: string): SessionPriorState | undefined
  /**
   * 事务式增量落库（issue #3）：INSERT 新段/对/FTS + UPDATE 旧行翻转与链尾
   * 重解析 + sessions 行聚合合并 + 水位推进 + 常驻 Map 同步。与 replaceSession
   * 同一 WAL 事务纪律；任何失败整体回滚，调用方回退全量。
   */
  applyIncrement(
    sessionId: string,
    delta: SessionIncrementDelta,
    artifactBytes: number,
    artifactMtimeMs: number,
    extra?: ReplaceSessionExtra,
  ): void
  /** 翻转归档旗标（不动投影内容）。 */
  setArchived(sessionId: string, archived: 0 | 1): void
  /**
   * 级联清除一个会话的全部投影（删除剪枝专用，2026-10-20 用户定标）：
   * WAL 事务内删 segments/segments_fts/replaces/sessions 四表，提交后摘
   * 常驻 Map；会话不存在返回 false（幂等，不抛）。投影可重建，删行无损。
   */
  deleteSession(sessionId: string): boolean
  close(): void
}

const DDL = `
CREATE TABLE IF NOT EXISTS sessions(
  session_id TEXT PRIMARY KEY, dir_id TEXT NOT NULL, title TEXT DEFAULT '',
  cwd TEXT DEFAULT '', event_count INTEGER DEFAULT 0, max_seq INTEGER DEFAULT -1,
  turn_count INTEGER DEFAULT 0, segment_tokens INTEGER DEFAULT 0,
  surface_tokens INTEGER DEFAULT 0, gross_saved INTEGER DEFAULT 0,
  recall_tokens INTEGER DEFAULT 0, compress_pairs INTEGER DEFAULT 0,
  recall_pairs INTEGER DEFAULT 0, basis TEXT DEFAULT 'chars/4',
  artifact_bytes INTEGER DEFAULT 0, artifact_mtime_ms INTEGER DEFAULT 0,
  last_time_ms INTEGER DEFAULT 0,
  format_generation INTEGER DEFAULT -1,
  archived INTEGER DEFAULT 0,
  synced_at TEXT DEFAULT (datetime('now')),
  frame_offset INTEGER DEFAULT -1,
  frame_consumed INTEGER DEFAULT 0,
  frame_roll_turn INTEGER DEFAULT 0,
  frame_roll_step INTEGER DEFAULT 0,
  frame_basis TEXT DEFAULT '',
  frame_artifact TEXT DEFAULT '');
CREATE INDEX IF NOT EXISTS idx_sessions_dir ON sessions(dir_id);
CREATE TABLE IF NOT EXISTS segments(
  session_id TEXT NOT NULL, seq INTEGER NOT NULL, turn INTEGER DEFAULT 0,
  step INTEGER DEFAULT 0, kind TEXT NOT NULL, role TEXT DEFAULT '',
  time INTEGER DEFAULT 0,
  text_hash TEXT, tokens INTEGER DEFAULT 0,
  search_text_hash TEXT,
  redacted_text_hash TEXT, redacted_search_text_hash TEXT,
  on_surface INTEGER DEFAULT 1,
  compressed INTEGER DEFAULT 0,
  surface_tokens INTEGER, replaced_by INTEGER,
  PRIMARY KEY(session_id, seq)) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_segments_turn ON segments(session_id, turn, step);
CREATE TABLE IF NOT EXISTS replaces(
  session_id TEXT NOT NULL, seq INTEGER NOT NULL, start_seq INTEGER NOT NULL,
  end_seq INTEGER NOT NULL, a_tokens INTEGER NOT NULL, b_tokens INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('compress','recall')),
  turn INTEGER DEFAULT 0, step INTEGER DEFAULT 0,
  live INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY(session_id, seq)) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_replaces_range ON replaces(session_id, start_seq);
CREATE VIRTUAL TABLE IF NOT EXISTS segments_fts USING fts5(
  index_text, session_id UNINDEXED, seq UNINDEXED, kind UNINDEXED,
  tokenize='unicode61');
CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT);
${BLOCKS_DDL}
`

function summaryToRow(s: SessionSummary, artifactBytes: number, artifactMtimeMs: number, extra?: ReplaceSessionExtra): SessionRow {
  return {
    session_id: s.sessionId,
    dir_id: s.dirId,
    title: extra?.title !== undefined && extra.title !== '' ? extra.title : s.title,
    cwd: s.cwd,
    event_count: s.eventCount,
    max_seq: s.maxSeq,
    turn_count: s.turnCount,
    segment_tokens: s.segmentTokens,
    surface_tokens: s.surfaceTokens,
    gross_saved: s.grossSaved,
    recall_tokens: s.recallTokens,
    compress_pairs: s.compressPairs,
    recall_pairs: s.recallPairs,
    basis: s.basis,
    artifact_bytes: artifactBytes,
    artifact_mtime_ms: artifactMtimeMs,
    last_time_ms: s.lastTimeMs,
    format_generation: s.formatGeneration,
    archived: extra?.archived ?? 0,
    synced_at: new Date().toISOString(),
    frame_offset: extra?.frame?.frame_offset ?? -1,
    frame_consumed: extra?.frame?.frame_consumed ?? 0,
    frame_roll_turn: extra?.frame?.frame_roll_turn ?? 0,
    frame_roll_step: extra?.frame?.frame_roll_step ?? 0,
    frame_basis: extra?.frame?.frame_basis ?? '',
    frame_artifact: extra?.frame?.frame_artifact ?? '',
  }
}

/**
 * 打开（或创建）投影库。
 * @param dir - 库目录（缺省布局 ~/.dsh-reference-session-collector；env 覆盖在 sync 侧解析）。
 * @returns {@link ProjectionStore}，已载入 sessions 常驻 Map。
 */
export function openProjectionStore(dir: string): ProjectionStore {
  mkdirSync(dir, { recursive: true })
  const db = new DatabaseSync(join(dir, 'projection.db'))
  db.exec(`
PRAGMA journal_mode=WAL;
PRAGMA synchronous=NORMAL;
PRAGMA temp_store=MEMORY;
PRAGMA cache_size=-32000;
PRAGMA mmap_size=268435456;
PRAGMA application_id=0x44525343;
`)
  // 断裂式重置（v5 起）：旧库版本串不符 → 先 DROP 全建再跑 DDL（segments 列
  // 形状断裂，ALTER 不可补；若先 DDL，legacy 旧表会让 CREATE INDEX 引用缺失列
  // 直接炸）。重建后 VACUUM 一次回收碎片。投影可重建，丢行无损。
  let previous: { value: string } | undefined
  try {
    previous = db.prepare("SELECT value FROM meta WHERE key='schema_version'").get() as { value: string } | undefined
  } catch {
    previous = undefined // 新库：meta 尚未存在
  }
  if (previous !== undefined && previous.value !== PROJECTION_SCHEMA_VERSION) {
    db.exec(`DROP TABLE IF EXISTS segments_fts;
             DROP TABLE IF EXISTS segments;
             DROP TABLE IF EXISTS replaces;
             DROP TABLE IF EXISTS sessions;
             DROP TABLE IF EXISTS blocks;
             DROP TABLE IF EXISTS meta`)
  }
  db.exec(DDL)
  if (previous !== undefined && previous.value !== PROJECTION_SCHEMA_VERSION) db.exec('VACUUM')
  db.prepare('INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
    .run('schema_version', PROJECTION_SCHEMA_VERSION)

  const summaries = new Map<string, SessionRow>()
  const loadAll = () => {
    summaries.clear()
    const rows = db.prepare('SELECT * FROM sessions').all() as unknown as SessionRow[]
    for (const row of rows) summaries.set(row.session_id, row)
  }
  loadAll()

  const insertSegment = db.prepare(`INSERT INTO segments(
    session_id, seq, turn, step, kind, role, time, text_hash, tokens, search_text_hash,
    redacted_text_hash, redacted_search_text_hash,
    on_surface, compressed, surface_tokens, replaced_by)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
  const blocks = new BlocksStore(db)
  const insertReplace = db.prepare(`INSERT INTO replaces(
    session_id, seq, start_seq, end_seq, a_tokens, b_tokens, kind, turn, step, live)
    VALUES(?,?,?,?,?,?,?,?,?,?)`)
  const insertFts = db.prepare(`INSERT INTO segments_fts(index_text, session_id, seq, kind) VALUES(?,?,?,?)`)
  const upsertSession = db.prepare(`INSERT INTO sessions(
    session_id, dir_id, title, cwd, event_count, max_seq, turn_count, segment_tokens,
    surface_tokens, gross_saved, recall_tokens, compress_pairs, recall_pairs, basis,
    artifact_bytes, artifact_mtime_ms, last_time_ms, format_generation, archived, synced_at,
    frame_offset, frame_consumed, frame_roll_turn, frame_roll_step, frame_basis, frame_artifact)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(session_id) DO UPDATE SET
      dir_id=excluded.dir_id, title=excluded.title, cwd=excluded.cwd,
      event_count=excluded.event_count, max_seq=excluded.max_seq,
      turn_count=excluded.turn_count, segment_tokens=excluded.segment_tokens,
      surface_tokens=excluded.surface_tokens, gross_saved=excluded.gross_saved,
      recall_tokens=excluded.recall_tokens, compress_pairs=excluded.compress_pairs,
      recall_pairs=excluded.recall_pairs, basis=excluded.basis,
      artifact_bytes=excluded.artifact_bytes, artifact_mtime_ms=excluded.artifact_mtime_ms,
      last_time_ms=excluded.last_time_ms, format_generation=excluded.format_generation,
      archived=excluded.archived,
      synced_at=excluded.synced_at,
      frame_offset=excluded.frame_offset, frame_consumed=excluded.frame_consumed,
      frame_roll_turn=excluded.frame_roll_turn, frame_roll_step=excluded.frame_roll_step,
      frame_basis=excluded.frame_basis, frame_artifact=excluded.frame_artifact`)
  // 增量面（v6,issue #3）：旧行翻转与链尾重解析的定点 UPDATE。
  const updateSegmentSurface = db.prepare(`UPDATE segments SET
    on_surface=?, compressed=?, surface_tokens=?, replaced_by=?
    WHERE session_id=? AND seq=?`)
  const updateReplaceLive = db.prepare(`UPDATE replaces SET live=0 WHERE session_id=? AND seq=?`)

  return {
    db,
    summaries,
    replaceSession(projection, artifactBytes, artifactMtimeMs, extra) {
      const { summary, segments, replaces } = projection
      const row = summaryToRow(summary, artifactBytes, artifactMtimeMs, extra)
      db.exec('BEGIN')
      try {
        db.prepare('DELETE FROM segments WHERE session_id=?').run(row.session_id)
        db.prepare('DELETE FROM replaces WHERE session_id=?').run(row.session_id)
        db.prepare('DELETE FROM segments_fts WHERE session_id=?').run(row.session_id)
        for (const seg of segments) {
          // v5 写路径：原文/检索文入典（地面真值不动）；redacted 臂同源
          // redactSecrets 派生——未命中行与原文同串同 hash，字典自动共块。
          const redText = redactSecrets(seg.text).text
          const redSearch = redactSecrets(seg.searchText).text
          insertSegment.run(row.session_id, seg.seq, seg.turn, seg.step, seg.kind, seg.role,
            seg.time, blocks.ensure(seg.text), seg.tokens, blocks.ensure(seg.searchText),
            blocks.ensure(redText), blocks.ensure(redSearch),
            seg.onSurface, seg.compressed, seg.surfaceTokens, seg.replacedBy)
        }
        for (const rep of replaces) {
          insertReplace.run(row.session_id, rep.seq, rep.startSeq, rep.endSeq,
            rep.aTokens, rep.bTokens, rep.kind, rep.turn, rep.step, rep.live)
        }
        for (const seg of segments) {
          if (seg.searchText === '') continue
          insertFts.run(segmentForIndex(seg.searchText), row.session_id, seg.seq, seg.kind)
        }
        upsertSession.run(
          row.session_id, row.dir_id, row.title, row.cwd, row.event_count, row.max_seq,
          row.turn_count, row.segment_tokens, row.surface_tokens, row.gross_saved,
          row.recall_tokens, row.compress_pairs, row.recall_pairs, row.basis,
          row.artifact_bytes, row.artifact_mtime_ms, row.last_time_ms, row.format_generation,
          row.archived, row.synced_at)
        db.exec('COMMIT')
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
      // 缓存层 2：事务提交后增量更新常驻行。
      summaries.set(row.session_id, row)
    },
    getSessionState(sessionId) {
      const row = summaries.get(sessionId)
      if (row === undefined) return undefined
      const segments = db.prepare(`SELECT seq, tokens, on_surface, compressed, replaced_by, surface_tokens
        FROM segments WHERE session_id=? ORDER BY seq`).all(sessionId) as unknown as StoredSegmentView[]
      const replaces = db.prepare(`SELECT seq, start_seq, end_seq, a_tokens, b_tokens, kind, live
        FROM replaces WHERE session_id=? ORDER BY seq`).all(sessionId) as unknown as StoredReplaceView[]
      return { row, segments, replaces }
    },
    applyIncrement(sessionId, delta, artifactBytes, artifactMtimeMs, extra) {
      const prior = summaries.get(sessionId)
      if (prior === undefined) throw new Error(`applyIncrement: no prior session row ${sessionId}`)
      const { summary, newSegments, newReplaces } = delta
      const row = summaryToRow(summary, artifactBytes, artifactMtimeMs, extra)
      db.exec('BEGIN')
      try {
        // 新段/对/FTS：与全量路径同一插入面（blocks 字典、脱敏派生臂同源）。
        for (const seg of newSegments) {
          const redText = redactSecrets(seg.text).text
          const redSearch = redactSecrets(seg.searchText).text
          insertSegment.run(sessionId, seg.seq, seg.turn, seg.step, seg.kind, seg.role,
            seg.time, blocks.ensure(seg.text), seg.tokens, blocks.ensure(seg.searchText),
            blocks.ensure(redText), blocks.ensure(redSearch),
            seg.onSurface, seg.compressed, seg.surfaceTokens, seg.replacedBy)
        }
        for (const rep of newReplaces) {
          insertReplace.run(sessionId, rep.seq, rep.startSeq, rep.endSeq,
            rep.aTokens, rep.bTokens, rep.kind, rep.turn, rep.step, rep.live)
        }
        for (const seg of newSegments) {
          if (seg.searchText === '') continue
          insertFts.run(segmentForIndex(seg.searchText), sessionId, seg.seq, seg.kind)
        }
        // 旧行翻转/链尾重解析：定点 UPDATE（纯函数已算好终值，这里只落库）。
        for (const upd of delta.priorSegmentUpdates) {
          updateSegmentSurface.run(upd.onSurface, upd.compressed, upd.surfaceTokens, upd.replacedBy,
            sessionId, upd.seq)
        }
        for (const seq of delta.priorReplaceLiveOff) {
          updateReplaceLive.run(sessionId, seq)
        }
        upsertSession.run(
          row.session_id, row.dir_id, row.title, row.cwd, row.event_count, row.max_seq,
          row.turn_count, row.segment_tokens, row.surface_tokens, row.gross_saved,
          row.recall_tokens, row.compress_pairs, row.recall_pairs, row.basis,
          row.artifact_bytes, row.artifact_mtime_ms, row.last_time_ms, row.format_generation,
          row.archived, row.synced_at,
          row.frame_offset, row.frame_consumed, row.frame_roll_turn, row.frame_roll_step,
          row.frame_basis, row.frame_artifact)
        db.exec('COMMIT')
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
      // 缓存层 2：提交后增量更新常驻行。
      summaries.set(sessionId, row)
    },
    setArchived(sessionId, archived) {
      const current = summaries.get(sessionId)
      if (current !== undefined && current.archived === archived) return
      db.prepare('UPDATE sessions SET archived=? WHERE session_id=?').run(archived, sessionId)
      if (current !== undefined) summaries.set(sessionId, { ...current, archived })
    },
    deleteSession(sessionId) {
      const existed = summaries.has(sessionId)
      db.exec('BEGIN')
      try {
        db.prepare('DELETE FROM segments WHERE session_id=?').run(sessionId)
        db.prepare('DELETE FROM segments_fts WHERE session_id=?').run(sessionId)
        db.prepare('DELETE FROM replaces WHERE session_id=?').run(sessionId)
        const head = db.prepare('DELETE FROM sessions WHERE session_id=?').run(sessionId)
        // v5 纪律：blocks 只增不删（共享块归属不可知；字典体积有上界=语料 distinct 集）。
        db.exec('COMMIT')
        if (!existed && Number(head.changes ?? 0) === 0) return false
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
      // 缓存层 2：提交后摘常驻行；LRU 台账由 synced_at 代际键自然失效（查不到会话=不再命中）。
      summaries.delete(sessionId)
      return true
    },
    close() {
      db.close()
    },
  }
}

/** 重新打开时同步常驻 Map（内部工具；openProjectionStore 已在构造时载入）。 */
export function reloadSummaries(store: ProjectionStore): void {
  const rows = store.db.prepare('SELECT * FROM sessions').all() as unknown as SessionRow[]
  store.summaries.clear()
  for (const row of rows) store.summaries.set(row.session_id, row)
}
