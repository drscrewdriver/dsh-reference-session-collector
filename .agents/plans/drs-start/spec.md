# Spec: dsh-reference-session (DRS) —— 会话原文投影同步器

> 名字三关:`dsh-reference-session` 缩写 DRS,同时是 drscrewdriver 前三字母。
> npm(未加 scope)E404 可注册;GitHub 无一字不差同名仓库(21 条命中全为
> `dsh-session-ref*` 家族,语义不同——那是 ctx.sessionReferences 跨会话引用)。

## 需求

- R1 **投影同步器**:增量扫描 `~/.dsh/sessions/**`(walk 代次目录→当前代产物),
  解码(zstd 多帧/撕裂帧,复用 vendored 叶子),按 watermark(bytes+mtime)增量
  落投影库。**只读纪律**:绝不写会话文件;插件自己的写只落在
  `~/.dsh-reference-session/projection.db`。
- R2 **投影库**:SQLite(node:sqlite)四表一虚表:.sessions / .segments /
  .replaces / .meta + segments_fts(fts5 普通表,索引**分词后**的 index_text)。
  每 session 全量重写式替换(事务内 DELETE+INSERT),幂等。
  segments 另携 time(事件 epoch ms)/ search_text(检索视界= steward 抽取超集)/
  on_surface(surface 重放);sessions 另携 last_time_ms / archived
  (随 ~/.dsh/storages/workspace.json global.archivedSessionIds 只读跟随)。
- R3 **surface 标记辅助识别**(供 CCI):segments 行携带 compressed 标记 +
  surface_text / surface_tokens / replaced_by 指针——"当前表面上是什么、
  被谁替换"免解码可查。
- R4 **surface 召回指针辅助统计**(供 CCI):replaces 按 b>a 分类 kind='recall'
  (扩写=全文读回=回吐),kind='compress'(b≤a);每对给原区间 [start..end]
  寻址指针;会话级 Σb(回吐)/ Σ(a−b)(毛节省)可直接对账 CCI claims。
- R5 **DS token 口径**:vendored deepseek-v4-tokenizer(flash/pro,资产带
  SHA-256 验证)精确计数;资产缺席降级 chars/4 且 sessions.basis 如实标注,
  与 CCI verify 同一公式与同一词表。
- R6 **HTTP 查询面**:单条 fenced 路由 `GET/POST /api/dsh-reference-session`,
  op 分发:status / sessions / session / surface / recall / search / sync。
  webServer 缺席时插件本体照常同步,仅 HTTP 面缺失(fail-soft)。
- R7 **内存缓存与效率**:三层策略(见技术方案 §缓存),杜绝每次请求全表扫。
- R8 **消费方接入分期**:一期 CCI 对账接线(只读 HTTP)→ 二期 steward 内容
  搜索语料源切换(search_text/time/on_surface + title/last_time_ms/archived
  满足 steward 命中面全部字段,其自有分词与 fts 面不动)→ 三期 memory
  **历史投影只读**:l0 写路径不迁 DRS(清洗/脱敏/record_id/实时 hook 职责留
  memory,与全量重写式替换语义互斥),DRS 仅提供 op=session&turn= 区间查询
  供历史行 turn/step 锚点回填与历史语料。向量层(BGE-M3 int8,与 prime-memory
  同权重)独立为可选批任务,与任何一期解耦。

## 技术方案

### 架构

```
~/.dsh/sessions/**(只读)──→ ProjectionSync(增量,watermark)
                                   │ projectSessionEvents(纯核心)
                                   ▼
                          projection.db(四表+fts5,+缓存三层)
                                   │
              ┌────────────────────┼───────────────────┐
   /api/dsh-reference-session     CCI(一期)      steward(二期)/memory(三期)
   (status/surface/recall/…)     monitor 对账      语料源/写路径
```

### DDL(spec 级完整定义;实现在 `src/schema.ts`)

```sql
PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;
PRAGMA temp_store=MEMORY; PRAGMA cache_size=-32000;  -- 32MB 页缓存
PRAGMA mmap_size=268435456;                          -- 256MB mmap,读=内核页缓存
PRAGMA application_id=0x44525353;                    -- 'DRSS'
CREATE TABLE sessions(       -- watermark + 汇总(全量常驻内存,见缓存层2)
  session_id TEXT PRIMARY KEY, dir_id TEXT NOT NULL, title TEXT DEFAULT '',
  cwd TEXT DEFAULT '', event_count INTEGER DEFAULT 0, max_seq INTEGER DEFAULT -1,
  turn_count INTEGER DEFAULT 0, segment_tokens INTEGER DEFAULT 0,
  surface_tokens INTEGER DEFAULT 0, gross_saved INTEGER DEFAULT 0,
  recall_tokens INTEGER DEFAULT 0, compress_pairs INTEGER DEFAULT 0,
  recall_pairs INTEGER DEFAULT 0, basis TEXT DEFAULT 'chars/4',
  artifact_bytes INTEGER DEFAULT 0, artifact_mtime_ms INTEGER DEFAULT 0,
  last_time_ms INTEGER DEFAULT 0,        -- 会话末事件时间(steward 排序/日期过滤)
  archived INTEGER DEFAULT 0,            -- 归档集标志(检索域成员资格)
  synced_at TEXT DEFAULT (datetime('now')));
CREATE INDEX idx_sessions_dir ON sessions(dir_id);
CREATE TABLE segments(       -- text/search_text 任一非空才收(chunk 空行不落)
  session_id TEXT NOT NULL, seq INTEGER NOT NULL, turn INTEGER DEFAULT 0,
  step INTEGER DEFAULT 0, kind TEXT NOT NULL, role TEXT DEFAULT '',
  time INTEGER DEFAULT 0,                -- 事件时间戳(steward hits/memory 排序)
  text TEXT DEFAULT '', tokens INTEGER DEFAULT 0,
  search_text TEXT DEFAULT '',           -- 检索视界=steward 抽取超集(见下)
  on_surface INTEGER DEFAULT 1,          -- 0=shadowed(steward 检索域过滤面)
  compressed INTEGER DEFAULT 0,          -- R3 surface 标记
  surface_text TEXT, surface_tokens INTEGER, replaced_by INTEGER,
  PRIMARY KEY(session_id, seq)) WITHOUT ROWID;
CREATE INDEX idx_segments_turn ON segments(session_id, turn, step);
CREATE TABLE replaces(       -- R4 替换对指针
  session_id TEXT NOT NULL, seq INTEGER NOT NULL, start_seq INTEGER NOT NULL,
  end_seq INTEGER NOT NULL, a_tokens INTEGER NOT NULL, b_tokens INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('compress','recall')),
  turn INTEGER DEFAULT 0, step INTEGER DEFAULT 0,
  PRIMARY KEY(session_id, seq)) WITHOUT ROWID;
CREATE INDEX idx_replaces_range ON replaces(session_id, start_seq);
CREATE VIRTUAL TABLE segments_fts USING fts5(
  index_text, session_id UNINDEXED, seq UNINDEXED, kind UNINDEXED,
  tokenize='unicode61');               -- index_text = search_text 经 Intl.Segmenter('zh')
                                       -- 词级切分(与 steward extract.ts:73-95 同构),
                                       -- DRS 自带 search 中文可用
CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT);  -- schema_version 等
```

### 纯投影核心(`src/projection.ts`)

`projectSessionEvents(events, {dirId, header?, exactCounter?}) →
{summary, segments[], replaces[]}`。两遍:第一遍建 tokensBySeq + 段行
(text/search_text 任一非空才收);第二遍扫 surfaceOp 替换对。**双形状容错**:op.startSeq/endSeq
(CCI 写入)与 op.start/end(叶子接口注释)都认。turn/step 从 step/start 滚动,
tokens 视界与 CCI verify 一致(data.message.content[] 的 text 块,富块计 0)。
**检索视界**(search_text):steward extractSessionEventText 的同构移植——
tool/call 的 name+arguments、todo/write 内容、turn/end 错误原因入面
(reasoning 不入);**on_surface**:replaySurfaceNodes 同款重放(replace 剔除
[start..end]、自身入面,从未被任何 pair 覆盖的行=1)——steward 命中的
time/type/surface 三个字段全在此产出。分词叶子 `src/segment.ts`:索引侧与
查询侧同一 Intl.Segmenter('zh') 切分函数(与 steward 同构,几行零依赖)。

### 同步引擎(`src/sync.ts`)

watermark = sessions.artifact_bytes + artifact_mtime_ms(按 dir_id 预查,
**stat 命中免解码**);未命中才 readFileSync+decode+classifySessionHeader
(仅 v3/v4 放行,未知代次软跳+一次性 warn)。每 session 处理后
`setImmediate` 让路(回填同款);`syncing` 旗标防重入(busy 即返回上次结果)。
精确计数器:resolveExactCounter() 试 flash→pro,全缺席=chars/4。
**归档集**:每轮开头只读 ~/.dsh/storages/workspace.json 的
global.archivedSessionIds(坏文件=无归档,对齐 steward archive-source.ts),
写入 sessions.archived。**调度**:interval 同步缺省 30s(env
DSH_REFERENCE_SESSION_SYNC_INTERVAL_MS,0=关闭),轮成本=目录 walk+stat
预查全命中即零解码——二期 steward 的新鲜度(≤1 分钟)靠它,不靠手动 POST。

### 缓存三层(R7,`src/schema.ts` + `src/surface.ts`)

1. **SQLite 层(常开,零代码路径)**:WAL + synchronous=NORMAL +
   cache_size=-32000 + mmap_size=256MB + temp_store=MEMORY。读路径热数据
   基本落在内核页缓存/mmap,单查询无盘 IO;写事务照常落盘。
2. **汇总常驻**:sessions 全表(~百行级)启动时载入 Map,此后
   status/sessions 列表 0 SQL;`replaceSession` 事务提交后增量更新该行。
3. **per-session 台账 LRU**:surface/recall 查询结果 Map 缓存(cap 32 会话),
   键含 sessions.synced_at 代际——会话重同步即自然失效,无失效风暴;
   CCI monitor 面板轮询同一活跃会话时命中内存。
   **拒绝全库内存镜像**:50MB 级库镜像一致性/双写复杂度高,mmap 已达成
   同级读效率——YAGNI,findings 留档。

### HTTP 面(`src/index.ts`)

`export const inject = ['webServer']`(唯一声明;webStartup 不列,老线兼容)。
双通道路由注册(direct `ctx.get` + `ctx.inject` 迟到臂),duplicate-route
容错,`ctx.effect` 注销。GET op 分发 + POST `{op:'sync'}` 触发后台同步
(返回 accepted + lastResult)。op→函数映射:status→store 自检+缓存统计;
sessions→汇总表分页;session/surface/recall→per-session(走 LRU);
session 支持 `turn=` 区间过滤与 `fields=search`(返回 time/search_text/
on_surface 检索面——steward 二期切料与 memory 三期回填都走这条臂);
search→fts5 MATCH(查询侧按 steward sanitizeFtsQuery 同款:切词+短语+尾
前缀,入参仅留 `"` 转义)。

### 宿主半骨架

steward 式清单:`dsh.plugin.json` components{host:lib/index.js,
client:lib/client.js};package.json main+exports(. / ./client /
./cordis.patch.yml);tsdown 双半(host ESM neverBundle node:/@deepseek-ai/*/
@huggingface/tokenizers;client CJS + ModuleLoader 横幅,占位空注册)。
v0 无 Config 声明、无 locale、无设置卡(env `DSH_REFERENCE_SESSION_DIR`
覆盖库目录)——设置面随二期消费方接线一起做,先杀跨代配置风险。

## 决策记录

| 选项 | 选择 | 理由 |
|------|------|------|
| fts5 外部内容表 vs 普通表 | 普通表直插 | 外部内容表**实际可维护**(steward engine.ts:184-224 手动 rowid/delete 同步为活证),实验台 0 命中系用法问题;选普通图为直插简单,代价=text 双份存储 |
| CJK 分词 | DRS 自带 Intl.Segmenter 切分(T2.5) | 原假设「steward 裸 unicode61 等二期救」被实证推翻:steward 早已切分;DRS 裸表反而是共享查询面的弱项,同构移植几行解决 |
| memory 三期 | 历史投影只读(锚点回填/语料),l0 写路径不迁 DRS | l0=清洗后消息(脱敏/截断/record_id 主键/实时 hook),与 DRS 原文事件+全会话 DELETE+INSERT 语义互斥;清洗责任必须留 capture 侧 |
| 向量层 | 独立可选批任务(不随任何一期) | 大设想含 embedding,但 BGE-M3(~550MB)不能做硬依赖;先 bm25+token 落库 |
| surfaceOp 形状 | startSeq/endSeq 与 start/end 双容 | CCI pruner 写前者,叶子接口注释后者;实测 fixture 两种都可能出现 |
| better-sqlite3 vs node:sqlite | node:sqlite | 宿主内置零原生依赖;CCI stats.sqlite 已验证 FTS5 可用 |
| tokenizer 依赖 CCI 包 vs vendor | vendor 三文件+资产 | 资产路径 import.meta.url 相对解析,跨包导入会把 6.3MB 资产拖进消费者;文件级 diff 回搬纪律 |
| 数据库缓存 | mmap+WAL+汇总常驻+LRU | 见上;内存镜像 YAGNI |
| Config/设置面 | v0 无 | 杀 0.1.x–0.2.x 六线配置断代风险;env 覆盖够用(sync interval 走 env) |
| 内存镜像 | 拒绝 | 见缓存层 |

## 约束

- 会话文件只读(与 CCI/steward 同一红线);插件写仅 ~/.dsh-reference-session/。
- node ≥22(zlib.zstdDecompressSync + node:sqlite);engines.dsh 抄 steward 全列表。
- client 半占位空注册:保 `window.__ModuleLoader__.load id==包名` 契约可加载。
- 9 语 locale 不适用(v0 无 UI 字符串);出现首个用户可见字符串时按规范补齐。
- vendored 三文件只做文件级回搬,不分叉(头注已声明;provenance 头注补写为
  T0.3→实际未完成,改列 T0.4;另 deepseek-v4-tokenizer.ts 的
  `./runtime/token-count.ts` 相对导入在平铺布局下断链,唯一授权改动=改指
  `./token-count.ts`,头注登记该 diff,见 T0.5)。
- 检索视界(search_text)移植=steward extractSessionEventText 逐字同构,与
  vendored 文件同一回搬纪律。**脱敏责任不在 DRS**:projection.db 存原文,
  泄露面=会话文件本身;任何「已洗语料」诉求走消费方自洗,不落 DRS。
- interval 同步缺省 30s 可 env 降 0(纯手动);空转轮成本上限=stat-only 全扫。
