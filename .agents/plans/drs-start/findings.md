# Findings

## 进度对齐(截至本计划落盘)

已完成:
- 名字查重:npm `dsh-reference-session` E404(可注册);GitHub 搜索 21 条命中
  全部是 `dsh-session-ref*` 家族(官方 `@deepseek-ai/dsh-session-reference` 及
  各路 fork,语义=ctx.sessionReferences 跨会话引用),无同名仓库。名字可用,
  但投 awesome/搜索时注意与该家族的邻近混淆。
- 侦察:steward 0.5.5 已内联 search-index 引擎(`src/host/index/*`,schema=
  docs+fts5 external-content unicode61,数据源 sessionQuery+zstd 兜底,落盘
  `~/.dsh-switch-search`);prime-memory l0 写路径
  (`src/hooks/capture.ts:175,245`→`l0.ts:84`→`sqlite.ts:2394`,turn/step 已写
  但历史行多空,vec 走惰性 sqlite-vec);CCI 路由注册双通道
  (direct+inject,duplicate 容错,`asWebServer` 必须还服务本体)。
- vendor 落位:`src/session-file-decode.ts`、`src/token-count.ts`、
  `src/deepseek-v4-tokenizer.ts`(逐字拷贝)+ `assets/deepseek-v4/`
  (tokenizer.json 6,367,146B + config 801B + LICENSE + manifest)。
- 骨架侦察:node v22.22.1;zstd/node:sqlite 可用;steward 清单/tsdown/eslint
  样板已读。

未动工:package.json/清单/四 TS 主模块/client/测试/构建门禁——全在 tasks。

## 二期/三期视界补口(2026-10-19 消费方源码对勘轮)

- **steward 视界断裂**:steward 可检索文本含 tool/call name+arguments、
  todo/write、turn/end 错误原因(extract.ts:108-199),排序/日期过滤依赖
  per-doc time 与 sessions.updated_at(engine.ts:511-531),归档检索域靠
  archived flag——原 DRS 视界(message content only、无 time 列)全覆盖不住。
  处置:segments 增 search_text/time/on_surface,sessions 增
  last_time_ms/archived(T7.0 对照表为阻塞项)。
- **CJK 现状失实**:steward 早已 Intl.Segmenter 词级切分+
  external-content fts 手动同步可用(engine.ts:184-224);「一期 CJK 不救、
  等 steward 升级」前提被推翻——弱的是 DRS 自己的查询面。处置:T2.5 同构
  切分;外部内容表决策理由修正为「普通图简单+空间换复杂」。
- **新鲜度断层**:steward 现走 sessionQuery 服务面(零本地解码)+30s 轮询;
  DRS 原本只有启动 2.5s+手动 POST——二期切料后搜索新鲜度反而退化。处置:
  T3.3 interval 缺省 30s(stat 预查空转廉价)。
- **memory 三期语义互斥**:l0=清洗后消息(sanitize→脱敏→截断→
  source.kind 过滤,msg_ 前缀 record_id 主键,实时 turn/end 钩子;
  capture.ts:326-351, sqlite.ts:591-599)——与 DRS 原文事件+每 session
  DELETE+INSERT 全量重写互斥;双写行会被重同步抹掉。处置:三期改「历史
  投影只读+锚点回填」,清洗责任留 memory,vec 层解耦为独立可选任务。
- **vendored 断链(进度事实)**:deepseek-v4-tokenizer.ts 引
  `./runtime/token-count.ts`(CCI 原布局),DRS 平铺下 typecheck 必炸——
  新增 T0.5(唯一授权 diff);T0.4 头注仍未写(三文件头部无回搬声明)。
- **baseline 口径**:实验台 baseline.db 现测 57.5MB(记录值 52.67 为当时
  快照),体积预算上修至 ≤90MB。

## 架构决策

- **投影=每事件粒度 + turn/step 列**,而非按 turn/step 聚合成段:替换对以
  seq 寻址,事件粒度使 joins(区间求和、指针回跳)是主键查询;视图层再聚合。
- **segments 只收 text<>'' 事件**:chunk 事件(text-chunks 解包产物)文本视图
  为空,收进来白涨 ~10× 行数;pair 数学用内存 tokensBySeq,不依赖段行。
- **sync=文件级 watermark + 全会话重写**:宿主按代次整文件发布,事件级增量
  无处安放;stat 命中免解码是真正的成本赢家(解码不可省时账面工作全跳——
  CCI 回填同款教训)。
- **缓存三层**(spec §缓存):mmap/WAL 是"内核页缓存即缓存";sessions 汇总
  常驻消掉列表路由的 SQL;LRU 键带 synced_at 代际,重同步自然失效。
  全库内存镜像显式拒绝。

## 技术选型

- node:sqlite(DatabaseSync):宿主内置,FTS5 可用已由 CCI stats.sqlite 与
  实验台双重复证;WAL/BEGIN IMMEDIATE 手写事务(node:sqlite 无 begin 助手)。
- @huggingface/tokenizers 0.1.3(与 CCI 同版):Rust napi,tsdown neverBundle,
  运行时从自身 node_modules 解析。
- fts5 分词:index_text = Intl.Segmenter('zh') 切分后入 unicode61 索引
  (T2.5,与 steward 同构)。原「一期 CJK 不救、二期统一在 steward 侧升级」
  已按实况修正:steward 早已切分,DRS 裸 unicode61 反而是共享查询面的短板。
  steward 的 external-content+手动同步范式(engine.ts:184-224)证明外部内容
  表可用——DRS 选普通表是「直插简单、空间换复杂」,不是「用不了」。

## 约束与依赖

- 只读纪律:readFileSync 是唯一触碰会话文件的调用。
- inject 仅 `['webServer']`:webStartup(0.2.1-a.2 起由 webRuntime 更名)不列,
  免老线缺服务导致整个插件不加载;启动同步用 setTimeout 自排,不依赖它。
- dsh.plugin.json engines 抄 steward 全宿主列表(0.1.0-rc.2…0.2.1-rc.2)。
- vendored 文件头注声明"逐字移植+文件级回搬";三处 provenance 头注尚待补写
  (T0.3)。

## 风险识别

- **surfaceOp 双形状**(startSeq/endSeq vs start/end):投影核心双容;若宿主
  未来改形状,segments/replaces 落空表现为 0 对——status 里加 pairs=0 会话
  计数作为哨兵,verify 对账能立刻暴露。
- **大规模首同步阻塞**:37+ 会话/20MB 语料首轮解码约分钟级;启动同步延迟
  2.5s 且 setImmediate 让路,POST sync 可重触发;interval 轮(30s,补口后
  缺省开)因 stat 预查全命中而空转廉价,仅在变更时才会把解码分片入主线——
  若实测抖动可 env 降频/关闭(补口前「不设内置轮询、二期 chokidar」的旧裁定
  作废,新鲜度模型改走 T3.3)。
- **与 CCI 同机双 SQLite**:统计口径不同源(claims 聚合 vs 投影重算),一期
  只做对账展示不做合并——面板上分列呈现,避免再演「两值一个值」事故。
- **steward 兼容残留**:steward 内联引擎与 DRS 并存期会有两份索引(各 ~50MB
  量级),二期切换完成后由 steward 侧退役旧目录,不在 DRS 里做清理。
- **隐私边界(新增红线)**:projection.db 存未脱敏原文,泄露面=会话文件本身
  (同源同权);脱敏链必须留在 memory capture 侧,DRS 永不承诺「已洗语料」。
- **interval 同步的宿主主线程占用**:node:sqlite DatabaseSync 同机阻塞,
  30s 空转轮仅 stat 预查(37+ 会话 <200ms 预算);首轮回填仍 setImmediate
  分片让路——若实测干扰会话交互,env 降频或关闭(手动 POST 兑底)。

## L1 主线完成轮(2026-10-19 晚)

- **范围**:T0.4/T0.5 → T1.1-T1.5 → T2.1-T2.5 → T5.1-T5.3 全部落地;
  门禁五项全绿(typecheck/lint/build/smoke 退出码 0,vitest 37/37)。
- **泳道实况**:L3 会话本轮交付 src/sync.ts+sync.spec.ts(14 测试,依赖
  倒置端口设计),与 L1 真件无缝对接——e2e.spec.ts 已验 ProjectionSync×
  真库全链路(首轮入库/二轮 stat 跳过/mtime 幂等/归档翻转/中文检索)。
  T2.5 segment.ts 与 surface.ts 六函数由 L1 代做(契约同串);L2 若再交
  正式版以 route/e2e 测试为护栏。
- **新增事实(实测修正计划假设)**:①node:sqlite FTS5 在 node v22.22.1
  直接可用(普通表直插+bm25+前缀短语查询全绿);②pnpm 安装需
  pnpm-workspace.yaml allowBuilds.esbuild(已知坑重现)+.npmrc 把
  @deepseek-ai 钉到 registry.npmjs.org(默认镜像无此 scope);③双形状
  surfaceOp 在 TS 类型面只需 cast 一次(叶子类型声明 start/end)。
- **待定项**:T4.2 正式 surface.spec(L2)、T6+ 跨仓接线、T9.1 真机 perf;
  真机桌面 profile 装机未做(需先关停 Electron)。

## T7.0 对照表(2026-10-19 二期前置核对;源码锚点=steward@0.5.5)

steward docs 表(src/host/index/schema.ts ensureSchema)逐字段 ← DRS 来源:

| steward 字段 | DRS 来源 | 语义对齐说明 |
|---|---|---|
| docs.session_id | segments.session_id | PK 同形(header.id,目录名兜底) |
| docs.seq | segments.seq | PK(session_id,seq) 同形;唯一索引 docs_session_seq 同构 |
| docs.type | segments.kind | 事件 type 原串,不翻译 |
| docs.surface | segments.on_surface | 'current'/'shadowed' ↔ 1/0;**同视界=同算法**(见下折叠规则) |
| docs.time | segments.time | 事件 epoch ms(buildIndexDocuments 缺 time 记 0) |
| docs.text | segments.search_text | 检索视界=extractSessionEventText 同构(extract.ts:108-199) |
| docs.index_text | segments_fts.index_text | segmentForIndex 同构(Intl.Segmenter('zh') word 级空格连接,extract.ts:73-95);索引/查询同函数 |
| (无对应) | segments.text/tokens/turn/step/role/compressed/surface_*/replaced_by + replaces 表 | DRS 超集;text=CCI verify 口径(message.content 视界),与 search_text 并存正是设计意图;steward 不消费,无害 |

steward sessions 表 ← DRS sessions:

| steward 字段 | DRS 来源 | 说明 |
|---|---|---|
| session_id | sessions.session_id | 同形 |
| version | ⚠ 无直接对应 | steward 增量水位列;T7.1 适配侧以 synced_at 代际或 artifact mtime 换算,不动 DRS schema |
| title | sessions.title | ⚠ gap-1:DRS 不提取标题;补口=extractTitleFromEvents(extract.ts:28)同构移植进投影 summary,T7.1 前置子项 |
| cwd | sessions.cwd | header.cwd |
| updated_at | sessions.last_time_ms | 排序/日期过滤语义=会话末事件时间 ✓(engine.ts:511-531 半开区间) |
| indexed_at | sessions.synced_at | ⚠ 类型差:steward INTEGER epoch vs DRS TEXT datetime;适配侧换算 |
| archived | sessions.archived | ✓ 检索域成员标志 |

折叠规则(classifySurface,extract.ts:219-246)——L1 projection 的 on_surface 逐字镜像:
1. 参与类型仅四类:user/message、assistant/message、tool/call、tool/result;
2. append/无 op → current(1) 入节点表;
3. replace{startSeq,endSeq} → 只对**当前在面节点**落于闭区间者置 shadowed(0),replace 自身 current(1) 替换入节点表——不是「区间内全部 seq 置 0」;
4. 未知 op 形状 → 降级 append;
5. 非参与类型(todo/write、turn/end 虽产检索文本)不在 map → steward `?? 'shadowed'`(extract.ts:267)→ on_surface 镜像值=0。

决策点(阻塞 T7.1,须用户拍板):
- **mirror-vs-改良**:steward 今天 surface='current' 过滤实际把 todo/write、turn/end 排除在搜索外。默认逐字镜像(行为与 steward 现状逐行一致,继承排除);改良=改 steward 侧过滤子句,不动 DRS 存储语义,另行开关。
- **gap-1(title)**:T7.1 开工前先移植 extractTitleFromEvents,否则命中面 join s.title 全空。
- version/indexed_at 换算放 steward 适配层。

结论:对照表齐备,无缺项阻塞;T7.0 解除阻塞。
