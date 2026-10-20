/**
 * 投影库装配（spec §DDL）：node:sqlite 四表一虚表 + WAL/mmap 缓存层 1 +
 * sessions 汇总常驻 Map（缓存层 2）。写纪律：每 session 全量重写式替换
 * （事务内 DELETE+INSERT），幂等。
 *
 * 本库只落在 ~/.dsh-reference-session/projection.db ——绝不触碰会话文件。
 */
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { SessionProjection, SessionSummary } from './projection.ts'
import { segmentForIndex } from './segment.ts'

/** schema 版本（meta 表；断裂式迁移的比对基线）。
 * v2=加 sessions.format_generation；
 * v3=search_text 视界变更（剥离宿主注入样板段，strip-injected horizon v2）；
 * v4=账目双修（真机取证 2026-10-20）：① text/tokens 视界补 data.content 双臂
 *   （checkpoint 替身/用户消息旧视界全计 0）；② replaces 加 live 列——替身行
 *   被后续区间再覆盖时 delta 清除不入 gross（用户定标：checkpoint 只影响其后
 *   的积分）。旧行两项口径均错，整库清空重建（投影可重建，丢行无损）。 */
export const PROJECTION_SCHEMA_VERSION = '4'

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
}

/** replaceSession 的产物 watermark 附加项。 */
export interface ReplaceSessionExtra {
  /** 归档集标志（sync 侧按 workspace.json 只读跟随）。 */
  archived?: 0 | 1
  /** 预置标题（steward 切料同款，缺省用 projection.summary.title）。 */
  title?: string
}

/** 投影库句柄。 */
export interface ProjectionStore {
  db: DatabaseSync
  /** 缓存层 2：sessions 全表常驻（~百行级），status/sessions 列表 0 SQL。 */
  summaries: Map<string, SessionRow>
  /** 事务式全量重写一个会话；提交后增量更新常驻行。 */
  replaceSession(projection: SessionProjection, artifactBytes: number, artifactMtimeMs: number, extra?: ReplaceSessionExtra): void
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
  synced_at TEXT DEFAULT (datetime('now')));
CREATE INDEX IF NOT EXISTS idx_sessions_dir ON sessions(dir_id);
CREATE TABLE IF NOT EXISTS segments(
  session_id TEXT NOT NULL, seq INTEGER NOT NULL, turn INTEGER DEFAULT 0,
  step INTEGER DEFAULT 0, kind TEXT NOT NULL, role TEXT DEFAULT '',
  time INTEGER DEFAULT 0,
  text TEXT DEFAULT '', tokens INTEGER DEFAULT 0,
  search_text TEXT DEFAULT '',
  on_surface INTEGER DEFAULT 1,
  compressed INTEGER DEFAULT 0,
  surface_text TEXT, surface_tokens INTEGER, replaced_by INTEGER,
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
  }
}

/**
 * 打开（或创建）投影库。
 * @param dir - 库目录（缺省布局 ~/.dsh-reference-session；env 覆盖在 sync 侧解析）。
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
PRAGMA application_id=0x44525353;
`)
  db.exec(DDL)
  // 断裂式迁移：旧库 schema_version 存在且与新串不同 → 整库清空（投影可重建）。
  // v1→v2 时代旧库先补列再判（列检查幂等安全）。
  const cols = db.prepare('PRAGMA table_info(sessions)').all() as unknown as { name: string }[]
  if (!cols.some(c => c.name === 'format_generation')) {
    db.exec('ALTER TABLE sessions ADD COLUMN format_generation INTEGER DEFAULT -1')
  }
  // v3→v4 旧库补列（列检查幂等安全；行数据随后被版本重置清空）。
  const repCols = db.prepare('PRAGMA table_info(replaces)').all() as unknown as { name: string }[]
  if (!repCols.some(c => c.name === 'live')) {
    db.exec('ALTER TABLE replaces ADD COLUMN live INTEGER NOT NULL DEFAULT 1')
  }
  const previous = db.prepare("SELECT value FROM meta WHERE key='schema_version'").get() as { value: string } | undefined
  if (previous !== undefined && previous.value !== PROJECTION_SCHEMA_VERSION) {
    db.exec('BEGIN')
    try {
      db.prepare('DELETE FROM sessions').run()
      db.prepare('DELETE FROM segments').run()
      db.prepare('DELETE FROM replaces').run()
      db.prepare('DELETE FROM segments_fts').run()
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }
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
    session_id, seq, turn, step, kind, role, time, text, tokens, search_text,
    on_surface, compressed, surface_text, surface_tokens, replaced_by)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
  const insertReplace = db.prepare(`INSERT INTO replaces(
    session_id, seq, start_seq, end_seq, a_tokens, b_tokens, kind, turn, step, live)
    VALUES(?,?,?,?,?,?,?,?,?,?)`)
  const insertFts = db.prepare(`INSERT INTO segments_fts(index_text, session_id, seq, kind) VALUES(?,?,?,?)`)
  const upsertSession = db.prepare(`INSERT INTO sessions(
    session_id, dir_id, title, cwd, event_count, max_seq, turn_count, segment_tokens,
    surface_tokens, gross_saved, recall_tokens, compress_pairs, recall_pairs, basis,
    artifact_bytes, artifact_mtime_ms, last_time_ms, format_generation, archived, synced_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
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
      synced_at=excluded.synced_at`)

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
          insertSegment.run(row.session_id, seg.seq, seg.turn, seg.step, seg.kind, seg.role,
            seg.time, seg.text, seg.tokens, seg.searchText, seg.onSurface, seg.compressed,
            seg.surfaceText, seg.surfaceTokens, seg.replacedBy)
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
