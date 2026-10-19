# dsh-reference-session (DRS) — 会话原文投影同步器

> 只读扫描 `~/.dsh/sessions/**` 会话日志，解码后投影进插件自有 SQLite
> （segments / replaces / FTS5），经单条 fenced HTTP 路由对外提供
> surface 标记、召回对账与中文可用的内容检索面。**绝不写会话文件。**

# Session Reference Projector (DRS) — English summary

DRS is a read-only projector over the host's session logs. It walks
`~/.dsh/sessions/**`, decodes zstd/teiled-frame logs with a vendored leaf
decoder, and rewrites per-session projections into
`~/.dsh-reference-session/projection.db` (SQLite via `node:sqlite`, four
tables + one FTS5 virtual table). A single fenced HTTP route
(`GET/POST /api/dsh-reference-session`) exposes status, session listings,
per-session segment windows, the surface ledger, recall/compress pair
accounting and full-text search. Token counts share the exact same
DeepSeek-V4 tokenizer and formula as CCI's `verify`, falling back to a
labelled `chars/4` basis when assets are absent. DRS never writes to any
session file; its only writes land in its own data directory.

## 定位 / Positioning

| 消费方 | 用 DRS 做什么 | 分期 |
|---|---|---|
| CCI（context-compression） | surface 标记（compressed/surface_text/replaced_by）、召回对账（Σb 回吐、Σ(a−b) 毛节省）、verify 免全量解码 | 一期 |
| steward（会话管家） | 内容搜索语料源切换（search_text/time/on_surface 检索面） | 二期 |
| prime-memory | 历史投影只读：`op=session&turn=` 锚点回填 l0 旧行 turn/step（l0 写路径不迁） | 三期 |

## 状态 / Status

**已交付（v0.1.0）**：宿主半身全量——纯投影核心、SQLite 投影库
（node:sqlite, FTS5）、增量同步引擎（watermark 预查/归档集跟随/interval
调度）、三层缓存查询面、fenced HTTP 路由；门禁链 `pnpm check` 全绿
（9 测试文件 / 66 测试）含 dist 冒烟。**剩余**：消费方接线（一期 CCI
对账 / 二期 steward 语料切换 / 三期 memory 锚点回填）与效率基准 T9.1。

其余 8 语文档：README.en / ja / ko / de / es / fr / ru / it。

## 架构

```
~/.dsh/sessions/**（只读）──→ ProjectionSync(增量, watermark=bytes+mtime)
                                   │ projectSessionEvents(纯核心)
                                   ▼
        ~/.dsh-reference-session/projection.db（四表 + fts5 + 缓存三层）
                                   │
              ┌────────────────────┼───────────────────┐
   /api/dsh-reference-session     CCI(一期)      steward(二期)/memory(三期)
   (status/surface/recall/…)     monitor 对账      语料源/锚点回填
```

## HTTP 路由表

单条 fenced 路由 `GET/POST /api/dsh-reference-session`，`op` 分发：

| op | 参数 | 返回 |
|---|---|---|
| `status` | — | 库自检 + 缓存统计 + 上次同步结果 |
| `sessions` | `offset/limit` | 会话汇总表分页 |
| `session` | `session=<id>`，可选 `turn=<区间>`、`fields=search` | segments 明细（`fields=search` 返 time/search_text/on_surface 检索面） |
| `surface` | `session=<id>` | surface 台账（当前表面行 + 被替换指针） |
| `recall` | `session=<id>` | 替换对分类账（compress/recall、Σb、Σ(a−b)） |
| `search` | `q=<词>`，可选 `session=` | FTS5 BM25 命中（中英同构切词） |
| `sync`（POST） | `{op:'sync'}` | accepted + 上次结果（后台增量同步） |

## 只读纪律

- 会话文件（`~/.dsh/sessions/**`）与 `workspace.json` 一律只读；
- 插件的全部写入落在 `~/.dsh-reference-session/projection.db`；
- 每 session 全量重写式替换（事务内 DELETE+INSERT），幂等可重放；
- **脱敏责任不在 DRS**：projection.db 存原文，泄露面=会话文件本身。

## 分期路线

1. **一期**：投影库 + HTTP 面 + CCI 对账接线（monitor 探针 + verify 对账列）；
2. **二期**：steward 内容搜索语料源切换（interval 同步缺省 30s 保新鲜度 ≤1 分钟）；
3. **三期**：memory 历史锚点回填（`op=session&turn=` 匹配补 l0 旧行 turn/step，
   匹配不上留 NULL 不伪造）；向量层（BGE-M3 int8 vec 列）为独立可选批任务。

## Token 口径

`deepseek-v4-tokenizer`（flash→pro 顺序解析，资产带 SHA-256 验证）与 CCI
verify 同公式同词表；资产缺席降级 `chars/4` 并在 `sessions.basis` 如实标注。

## 安装 / 运行

```
dsh plugin --profile web add dsh-reference-session
```

要求 node ≥ 22（`zlib.zstdDecompressSync` + `node:sqlite`）。
环境变量：`DSH_REFERENCE_SESSION_DIR` 覆盖库目录；
`DSH_REFERENCE_SESSION_SYNC_INTERVAL_MS` 调同步周期（0=关闭）。

## 状态与开发

**开发中(核心链路已全通)**:投影核心/落库(L1)、同步引擎(L3)、宿主半与
路由(L4)已落地,门禁全绿(typecheck/lint/build/smoke,37/37 测试);
收尾中:查询面正式测试(T4.2)、跨仓接线(cci 一期 / steward 二期 /
memory 三期)。进度簿:`.agents/plans/drs-start/`
(spec / findings / checklist / tasks)。

```bash
pnpm install && pnpm typecheck && pnpm lint && pnpm test && pnpm build
```

## Vendored

`src/session-file-decode.ts`、`src/token-count.ts`、`src/deepseek-v4-tokenizer.ts`
为 CCI 文件级回搬件（禁止分叉，头注登记 provenance 与唯一授权 diff）；
检索视界/切词逻辑为 steward 逐字同构移植。
