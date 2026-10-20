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

## 三仓适配前准备轮(2026-10-19 晚，接 L1 完成后)

- **TDD 补口**:新增 register/segment/tokenizer 三 spec(双通道注册 direct+
  inject+duplicate 容错+dispose 注销;切词尾前缀/引号结构不变式/多词 AND;
  R5 真资产正负分支+resolveExactCounter 实词表命中);smoke 加 client 横幅
  id==包名断言。门禁链固化为 `pnpm check`(typecheck→lint→test→build→smoke),
  全绿=9 文件 66 测试。
- **git 基线**:仓初建(main),root-commit `8020eb7` + tag `v0.1.0-baseline`;
  42 文件入基线(无 node_modules/lib;*.tgz 已加 ignore)。
- **tgz 实证**:`npm pack`(触发 prepack 重建)→ 23 文件/1.9MB;解包四文件
  (lib/index.js、lib/client.js、dsh.plugin.json、cordis.patch.yml)SHA256
  全部 MATCH 仓内;engines.dsh 仓↔包同串;client 横幅首行正常。
- **npm 特性注意**:`files` 剔除 README.en.md 行仍会被打进包——npm 无条件
  强含 README*/LICENSE/package.json;如需彻底排除只能删文件(未动,留用户裁)。
- **下一闸(三仓支线并行开工前置仅剩)**:DRS tgz 装机(profile 改写+重启,
  串行资源,装机前先关停 Electron)→ T6.x/T7.x/T8.x 三仓支线即可互不相
  干地并行;T7.0 对照表本轮未回写(用户删除了 fork 旧版;开工 T7.1 前按当前
  代码重推,事实基线:title 已由 extractTitleFromEvents 落 summary.title,
  旧 gap-1 不成立)。

## 装机实锤轮(2026-10-20 凌晨,双 profile)

- **装机完成**:desktop+web 两 profile 均 deps=file:…0.1.0-local.2.tgz,
  bundles 激活(33/44 条),8 文件哈希 MATCH 仓内,备份在
  `e:\test\rewrite-agently\_drs-install-20261019-235249\`。宿主 0.2.0-rc.2。
- **真机数据面(重量级证据)**:46 会话全量投影/14,851 segments/323
  replaces;**37 会话有替换对**;basis=ds-token(宿主内原生 tokenizer 真加载,
  非 chars/4 降级臂);样本对账 gross_saved=6920、surface 250 在面行+1 指针;
  中文 search 真命中 tool/result;LRU hits/misses 运转。
- **双根因修复(400 空体破案过程实录)**:宿主 webServer 对 handler 抛异常
  全局兑底 writeHead(400) 空体(dsh-host-webserver lib/index.js:248-256,
  异常只进 ctx.logger 不上 console)。根因=**cordis Context 对未声明
  inject 的服务面访问会抛**,且不仅 ctx.get()——**Proxy 属性读臂也抛**
  (readStartupFace 直读 ctx.webStartup 未保护→请求期抛)。修复=
  safeReadService 两层 try(属性读+get),register.spec 加 Proxy hostile
  回归(属性读/get 全抛形态)。旧教训修正:inject 只声明 webServer 时,
  读 webStartup/webRuntime 必须全臂包裹,不可裸属性访问。
- **pnpm store 同版钉死重现(第三次)**:file: tgz 改内容不改版号时
  `pnpm install`/`--force` 都不刷新 node_modules(store 以版本为键)——
  本地迭代必须递 `-local.X`(本轮 0.1.0→local.1→local.2)。
- **遗留**:仓根旧 `dsh-reference-session-0.1.0.tgz` 残留(DeleteFile 工具
  异常未删,gitignore 已挡,待手动清);desktop 宿主 GUI 未启动验证
  (装机+哈希已对,桌面端重启由用户触发);T9.1 二次同步耗时实测待跑。

## client 半身 invalid plugin 实锤轮(2026-10-20,local.3)

- **症状**:GUI 报 "Failed to load plugins — invalid plugin, expect
  function or object with an 'apply' method, received object";刷新无效;
  host 半路由 meanwhile 全 200(两个报错面无关,勿被路由绿误导)。
- **根因**:client 占位半写成裸 `export {}` → CJS 工厂返回空对象 →
  **client 半身同样经 cordis 插件加载器装载**(双半契约:两半都是插件,
  形态必须 function 或 {apply};对照 steward src/client/index.ts 有
  真实 `export function apply`)。
- **修复**:client 半改为合法空插件(`export const inject=[]` +
  `export function apply(): void {}`);新增 tests/client-shape.spec.ts
  形态断言 + smoke 对 lib/client.js 产物含 apply 的文本断言(两道网);
  双清单同步 0.1.0-local.3(store 钉版纪律)。
- **门禁**:pnpm check 全绿=10 文件 68 测试;装机 local.3 后路由 200 回归。
- **计划文本修正**:T1.4 原描述「export {} 一行+注释」为误导源——占位
  半身的最小合法形态是 no-op apply,不是空模块。

## 农场全版本冒烟轮(2026-10-20,local.3 × 保留场 8 线)

| 线 | smoke | apply 真跑(库落地) | ops 级 probe |
|---|---|---|---|
| 0.1.0-rc.8 | ok | ✓ | status 200(5会话/20段)、search 200 |
| 0.1.1-rc.2 | ok | ✓ | — |
| 0.1.2-rc.1 | ok(修复后) | ✓ | — |
| 0.1.5-rc.3 | ok(修复后) | ✓ | — |
| 0.1.7-rc.2 | ok(补 bundles 后) | ✓ | status 200(11会话/157段,带 cookie) |
| 0.2.0-rc.2 | desktop 通道 | — | 真实 desktop profile local.3 已装,GUI 已过 |
| 0.2.1-rc.1 | ok | ✓ | — |
| 0.2.1-rc.2 | ok | ✓ | status/search 200 |

- **新坑实锤①(比旧 IGNORED_BUILDS 教训更黑)**:farm add 撞 builds 闸时
  dependencies 写入成功但 **bundles 注册被回滚**——smoke 照样绿(插件根本
  不在装载面),假绿陷阱;且重跑 add 走幂等捷径(deps 已存在)**永不补写
  bundles**(0.1.7 线实测)。add 成功判据=deps+bundles 双查;缺 bundles 时
  手动 push(npm 包名形态)。修复面:格子 profile pnpm-workspace.yaml
  allowBuilds 补 protobufjs/better-sqlite3/node-pty 后 add 全绿。
- **新坑实锤②(跨线访问差异)**:0.1.2+ 线宿主用 cookie 闸门守 **所有**
  /api 路由(CCI 同闸,非 DRS 缺陷):无 cookie 401,?token= 引导换
  set-cookie 后 200;GUI 内 fetch 自动带 cookie,跨仓接线不受影响。
  0.2.1-rc.2/0.1.0/0.1.1 无此闸(裸 fetch 200)。
- **沙盒内语料**：格子 projection.db 均为 4KB 最小页但非空库——0.1.0 格
  实投影 5 会话/20 段、0.1.7 格 11 会话/157 段（沙盒自产会话），
  解码/投影/检索全链路在老线沙数据上跑通；真 ds-token 臂已在真实
  desktop profile 实锤（上轮 basis=ds-token）。
- **结论**:engines.dsh 17 条声明在本农场可达的 8 线全部实证成立
  (host 半装载/开库/路由三线形状一致);三仓接线可开工。

## 格式代次按版本判断处理轮(2026-10-20,local.4)

- **用户提问命中的真雷**:上一轮农场取证——0.1.0-rc.8/0.1.1-rc.2/0.1.2-rc.1
  格沙盒语料 header 代次=**0**（老宿主自写代次），而 DRS 放行集只有
  {3,4} → 三格 36/32/4 个会话**全部软跳＝老线整库静默不投**；smoke 绿
  掩盖了它（软跳不是错）。
- **代次语义取证**（当前 CLI 树迁移包）：v0→v1=**恒等边**（事件 type 体系
  v0..v4 同形）；v2→v3/v3→v4 才是字段级重写（迁移=宿主职责，DRS 只读
  不迁移）；官方解码器软加载臂在老格不可达（profile 树无
  @deepseek-ai/dsh-session）→本地叶子是唯一解码面。
- **处置**：放行集扩为 0..4（仍按文件头自声明判，不猜宿主版本；>4
  照旧软跳+warn）；sessions 新增 **format_generation** 列（schema v2，
  旧库 PRAGMA 探测+ALTER 就地迁移）；status 暴露 generations 分布哨兵；
  形状对不上的老代块→text/search_text 自然为空不落行，永不伪造。
- **实证链**：①单测（projection 透传/sync 0-1-2 放行/99 仍跳/e2e 真库
  round-trip）；②0.1.0 格真 v0 样料（逐行帧流 zstd）起宿主 probe：
  v0 会话 0→**37** 全入库，gen=0、basis=**ds-token**（老线原生 tokenizer
  可用）、assistant/message text=27 全形投影（恒等边实证）、检索命中；
  ③真实 web 宿主 local.4：schema=2 迁移无损，存量 46 行 gen=-1（水位
  命中不重写＝设计正确，会话变更时自然补齐）。
- **额外跨线发现（样料制作三轮才合规）**：0.1.0 线宿主 zstd 日志=
  **每行一帧的帧流**且启动校验「首帧恰为一 header 行」，整文件单帧
  压缩被判 corrupt 直接拒 boot（首错即致命）——v0 行形状本身与 v3+
  同形（header 字段 id/cwd/createdAt 同源），仅帧封装/校验宽度不同。
  农场老格 fixture 制作纪律入档。

## T7.3 直连轮（2026-10-20：节选对不上 → 检索链路重排）

- **症状根因两桩**：①search_text 收了宿主注入样板段（真机取证：7 类标记、
  1210/3100=39% 用户消息含注入，relevant-memories 747 次为最）——关键词命中
  在记忆召回区，节选与用户正文对不上；②跳转=uiWorkspace.openSession(sessionId)
  无 seq 定位参数（宿主接口面限制），点开只见会话头不见命中行——遗留项，
  需宿主锚点或面板内定位方案。索引本体取证为干净库（integrity OK/零孤儿）。
- **架构裁定（用户拍板）**：管家不再自建检索索引；DRS 设为硬依赖（永远在场，
  缺席即搜索显式报错不回退）；manifest 级依赖声明留后续。
- **DRS local.6/7**：strip-injected 七族成对剥离（反向引用配对，未闭合/异名
  保留）只过 search_text，text/tokens CCI 口径不动（R5）；schema v3 断裂重置
  （水位未变旧污染行永不重投，清空重建 47 会话实证）；op=search&group=session
  分组臂=steward engine.search 语义直译（TYPE_WEIGHT 3/1、-rank×w 分组、
  updated_at 时间排序、archived/from/to/surface 过滤、锚定 240 节选）。89/89。
- **steward drs-corpus 2f59d6e+c24d32e（local.2/3）**：content-search 直连 DRS；
  DRS 轮降级 header-only（engine.upsertSessionHead，docs/docs_fts 退役不新增，
  存量行老化）；search-status available 由 DRS probe 裁决；corpusSource 缺省
  drs。真机踩坑：宿主端口动态（3080），baseUrl 缺省猜 8080 → probe 假死
  drs-unavailable——修=同源转发请求 Host 头（getJson atHost 覆盖臂）。226/226。
- **装机终验**：双 profile drs local.7+steward local.3，content-search ok=true
  items=5 全锚定无噪；status schema=3、47 会话/13957 段全量重建。

## T7.4 定位臂轮（2026-10-20，B 路线 DOM 跳转）

- **前提实证**：宿主前端无列表虚拟化（virtuoso/react-window 零指纹；
  IntersectionObserver 仅 sticky 标题与入视口激活）——打开会话后历史行
  全量在 DOM，「偏旧历史预渲染」需求不成立，只做找行+滚动。
- **steward local.4/5（drs-corpus 3876f57+78ed350）**：src/client/search/
  locate.ts——同源 GET op=session&session= 拿段行；needle 决策：
  on_surface=0 放弃（GUI 不渲染替身原文）/compressed=1 用 surface_text/
  普通行优先 search_text（注入已剥=可见文本面）；归一化抹空白+markdown
  噪声两侧同式；MutationObserver 防抖轮询 5s；scrollIntoView(center)+
  4s outline 高亮（data-dss-located 钩子）；全链静默退化。点击后收起
  面板（遮罩挡滚动效果）。locate.spec 7 例+全量 233/233+client 套全绿。
- **数据面预检真机 10/10 LOCATABLE**（needle 全部解析成功零跳过）；
  GUI 目验待用户点击（ComputerUse 被浏览器 URL 置信策略挡住）。

## 删除剪枝补口轮（2026-10-20，T3.4，local.9）

- **触发**：桌面版取证发现 35 个会话目录已从磁盘消失但旧投影曾长期驻留
  （v4 重置只是碰巧清了库——稳态下 syncAll 只增不删，删除是漏项）。
  用户定标：被 session 删除的会话记录要传导给 DRS，用 WAL+按 uuid 级联
  清理对应内容的方式处理。
- **实现**：SyncStorePort 增 listProjectedDirs/deleteSession 两方法（端口
  扩为五方法）；syncAll 尾部对照发现集剪枝；真身 deleteSession=BEGIN 事务
  删 segments/segments_fts/replaces/sessions 四表（库本已 journal_mode=WAL）,
  提交后摘常驻 Map，Map 外幂等 false；SyncResult.pruned 数组如实上报。
- **守护（防误杀设计）**：sessions 根缺失（挂盘故障/整目录搬走）或发现被
  limit 截断时整轮不剪枝——陈旧行代价远小于误删全集；软跳会话从未入库，
  天然不在剪枝面。
- **验证**：97/97（+5：mock 剪枝/根守护/截断守护、真身四表级联+重开不
  复活、e2e 端到端删目录→pruned 非空+幸存可检）；门禁链 pnpm check 绿。
- **装机状态**：local.9 tgz 已出，双 profile 安装待桌面 Electron 关停后执行
  （desktop profile 修改纪律）；旧陈旧投影无需手工清——装后首轮 interval 自动剪。


## 改名轮 DRSC（2026-10-20，dsh-reference-session → dsh-reference-session-collector）

- **动机**：与消费方三分支的「安装时依赖 collector」诉求合并处理；npm 双名
  （旧/新）皆 E404 空位、旧名从未发布，纯本地盘切换零外部约束。
- **切换面**：包名/manifest id/路由 /api/dsh-reference-session-collector/
  env DSH_REFERENCE_SESSION_COLLECTOR_{DIR,SYNC_INTERVAL_MS}/数据目录
  ~/.dsh-reference-session-collector（起新库不迁移，投影可重建）/app-id DRSS→DRSC。
- **依赖声明通道**：npm peerDependencies 在 pnpm 工作区被 autoInstallPeers
  强拉注册表（未发布=404 卡死装机，optional meta 也拦不住）——改用
  package.json dsh.pluginDependencies:["dsh-reference-session-collector"]
  声明（仿 dsh.client 先例），装机强校验在 apply-drsc.cjs（tgz 解包验声明
  +profile 双闸），发布 npm 后可评估切回真 peers。
- **版本**：collector 0.1.0-local.9（97/97）× steward 0.5.5-local.10（233+client）
  × CCI selector 0.9.8-local.18（verify7+monitor44，bundle 零旧串）× memory
  0.26.4-local.2（anchor 5/5）。web profile 已装验（旧名 deps+bundles 双清，
  collector 四特征=true）；desktop 待 Electron 关停跑 apply-drsc.cjs。
- **目录迁移事故记**：PowerShell Move-Item 移 pnpm 符号链接农场部分失败
  （.git 过去了、src/tests/scripts 滞留旧目录）——逐目录补移修复，git 树
  验证干净；教训=含 node_modules 的目录改名应先 rm node_modules 再 move。
