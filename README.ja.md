# dsh-reference-session-collector (DRS) — セッション原文プロジェクション同期器

**DeepSeek Harness (DSH) プラグイン**: `~/.dsh/sessions/**` のセッション
ログを**読み取り専用**で走査し、復号後に独自 SQLite プロジェクション
（segments / replaces / FTS5）へ投影。単一の fenced HTTP ルート
`GET/POST /api/dsh-reference-session-collector` で surface マーク・リコール照合・
中文対応の全文検索面を提供します。**セッションファイルへは一切書き込みません。**

## ステータス

**納品済み（v0.1.0）**: ホスト側全体——純投影コア、SQLite プロジェクション
ストア（node:sqlite / FTS5）、増分同期エンジン（watermark 事前チェック /
アーカイブ追従 / interval スケジューリング）、3層キャッシュ照会面、fenced
HTTP ルート。ゲートチェーン `pnpm check` 全緑（9スイート / 66テスト + dist
スモーク）。**残作業**: コンシューマー配線（第1期 CCI 照合 / 第2期 steward
コーパス切替 / 第3期 memory アンカー補填）と効率ベンチマーク T9.1。

## アーキテクチャ

```
~/.dsh/sessions/**（読み取り専用）──→ ProjectionSync（増分、watermark=bytes+mtime）
                                   │ projectSessionEvents（純コア）
                                   ▼
        ~/.dsh-reference-session-collector/projection.db（4テーブル + fts5 + 3層キャッシュ）
                                   │
              ┌────────────────────┼───────────────────┐
   /api/dsh-reference-session-collector     CCI(第1期)   steward(第2期)/memory(第3期)
```

## HTTP ルート表

| op | パラメータ | 戻り値 |
|---|---|---|
| `status` | — | ストア自己診断 + キャッシュ統計 + 直近同期 |
| `sessions` | `offset/limit` | セッション一覧（常駐 Map、0 SQL） |
| `session` | `session=<id>`、任意 `turn=` / `fields=search` | segments 明細（検索面フィールド） |
| `surface` | `session=<id>` | surface テーブル（現在の表面 + 置換ポインタ） |
| `recall` | `session=<id>` | 置換ペア分類（Σb / Σ(a−b)） |
| `search` | `q=<query>`、任意 `session=` | FTS5 BM25 ヒット（中日同形分割） |
| `sync`（POST） | `{op:'sync'}` | accepted + 直近結果 |

## 読み取り専用規律

- セッションファイルと `workspace.json` は常時読み取り専用;
- 本プラグインの全書き込みは `~/.dsh-reference-session-collector/projection.db` にのみ;
- セッション単位の全量書換式置換（トランザクション内 DELETE+INSERT）、冪等;
- **マスキング責任は DRS にない**: 原文を保存、露出面=セッションファイル自体。

## 環境変数

| 変数 | 既定値 | 意味 |
|---|---|---|
| `DSH_HOME` | `~/.dsh` | セッションログルート |
| `DSH_REFERENCE_SESSION_COLLECTOR_DIR` | `~/.dsh-reference-session-collector` | プロジェクションDBディレクトリ |
| `DSH_REFERENCE_SESSION_COLLECTOR_SYNC_INTERVAL_MS` | `30000` | 同期間隔; `0`=手動のみ |

## インストール / 開発

```
dsh plugin --profile web add dsh-reference-session-collector
pnpm install && pnpm check   # typecheck→lint→test→build→smoke
```

Node ≥ 22 必須（`zlib.zstdDecompressSync` + `node:sqlite`）。

## ライセンス

MIT
