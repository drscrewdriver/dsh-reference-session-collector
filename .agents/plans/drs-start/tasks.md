# Tasks

粒度纪律:单项 ≤2-5 分钟人工复核量;每项有交付物与验证。✅=已完成。

## Phase 0: 侦察与落位(已完成)

- [x] ✅ T0.1 名字查重:npm E404 / GitHub 无同名(findings §进度对齐)
- [x] ✅ T0.2 消费方勘察:steward 内联引擎 / memory l0 写路径 / CCI 路由样板
- [x] ✅ T0.3 vendor 三叶子模块 + assets/deepseek-v4 落位(拷贝已完成)
- [x] ✅ T0.4 补三处 vendored provenance 头注(`src/session-file-decode.ts`、
  `src/token-count.ts`、`src/deepseek-v4-tokenizer.ts` 文件头各加 ⚠ 注释;
  验证:头注存在且正文 diff=0)——逐字节对账已验 extraLines=头注行数、
  mismatches=0(2026-10-19 L1 轮)
- [x] ✅ T0.5 修 vendored 导入断链:`src/deepseek-v4-tokenizer.ts` 引
  `./runtime/token-count.ts`(CCI 原目录布局),DRS 平铺下不存在——改指
  `./token-count.ts`,头注登记为唯一授权 diff(验证:tsc 可解析,其余正文
  diff=0;并入 T0.4 同一提交)

## Phase 1: 包骨架

- [x] ✅ T1.1 `package.json`:name=dsh-reference-session v0.1.0,type=module,
  main=lib/index.js,exports 四条;deps @huggingface/tokenizers 0.1.3;
  devDeps typescript/tsdown/tsx/vitest/eslint 全家+@deepseek-ai/cordis(dev,
  仅类型);engines node>=22 + dsh 全列表;scripts
  build/typecheck/test/lint(验证:pnpm install 后 node -e require 解析)
- [x] ✅ T1.2 `dsh.plugin.json`(steward 式:id/components 双半/engines/中英
  description)+ `cordis.patch.yml`(单 insert id 行)(验证:JSON.parse 通过)
- [x] ✅ T1.3 `tsconfig.json`(strict/exactOptionalPropertyTypes/
  noUncheckedIndexedAccess/verbatimModuleSyntax/allowImportingTsExtensions/
  noEmit,include src+tests)+ `tsdown.config.ts`(host ESM+dts,
  neverBundle node:/@deepseek-ai/*/@huggingface/tokenizers;client CJS
  ModuleLoader 横幅)(验证:tsc -p --noEmit 空项目通过)
- [x] ✅ T1.4 `eslint.config.js`(抄 CCI 精简版)+ `vitest.config.ts`
  (node,include tests/**/*.spec.ts)+ `src/client/index.ts` 占位
  (export {} 一行 + 注释)(验证:两工具空跑通过)
- [x] ✅ T1.5 `README.md`(中英:定位/架构图/路由表/只读纪律/分期路线)

## Phase 2: 投影核心

- [x] ✅ T2.1 `src/schema.ts`:openProjectionStore(DDL 全量,spec §DDL 的
  pragma+四表一虚表;segments 含 time/search_text/on_surface,
  sessions 含 last_time_ms/archived,fts 索引 index_text)+ closeStore +
  事务式 replaceSession(projection, artifactBytes, mtimeMs)(验证:T2.4 测试)
- [x] ✅ T2.2 `src/projection.ts`:projectSessionEvents 纯核心(spec §纯投影
  核心;双形状容错;text/search_text 任一非空才收;steward 同构检索视界;
  on_surface 重放;basis 标注)(验证:T2.4)
- [x] ✅ T2.3 测试 `tests/projection.spec.ts`:合成事件→压缩对 gross 数学、
  recall 分类、compressed/replaced_by 指针、双形状、空文本过滤、chars/4
  降级、turn/step 滚动、**time 落事件 epoch ms、search_text 含 tool/call
  参数与 todo/write 与 turn/end 错误原因、on_surface 与 steward
  classifySurface 同视界(被覆盖区间=0、replace 自身=1)**(验证:vitest run 绿)
- [x] ✅ T2.4 `tests/schema.spec.ts`:临时目录建库→replaceSession 两次幂等
  (行数稳定)→重开库数据仍在(验证:vitest 绿)
- [x] ✅ T2.5 `src/segment.ts`:Intl.Segmenter('zh') 词级切分 + 查询侧
  phrase/尾前缀构造(steward extract.ts:73-95 与 engine.ts sanitizeFtsQuery
  逐字同构移植,头注登记回搬纪律)+ 测试:中文查询命中切分后 index_text
  (验证:vitest 绿)

## Phase 3: 同步引擎

- [x] ✅ T3.1 `src/sync.ts`:discoverSessionLogs(readSessionGenerations walk,
  limit 兜底)+ resolveDshHome/resolveIndexDir(env 覆盖)+
  resolveExactCounter(flash→pro)+ readArchiveSet(workspace.json 只读,
  坏文件=空集)+ ProjectionSync.syncAll(watermark 预查/软跳/setImmediate
  让路/syncing 旗标/archived 旗标翻转)(验证:T3.2)
- [x] ✅ T3.2 测试 `tests/sync.spec.ts`:generationLogFilename(0,'none') 造
  明文代次文件→syncAll updated=1→再跑 skipped→utimesSync 变 mtime→重解码
  幂等;坏 header 软跳;归档集文件变更→下一轮 sessions.archived 翻转;
  last_time_ms=事件最大 time(验证:vitest 绿)
- [x] ✅ T3.3 interval 调度:setInterval 缺省 30s(env
  DSH_REFERENCE_SESSION_SYNC_INTERVAL_MS,0=关闭),轮=syncAll(stat 命中
  零解码);与启动首轮/syncing 旗标不并发;dispose 清定时器(验证:假 timers
  两轮空转 <50ms 且零解码;checklist 对应项绿)

## Phase 4: 查询面与缓存

- [x] ✅ T4.1 `src/surface.ts`:status/listSessions/sessionDetail/surfaceLedger/
  recallReport/search 六函数 + sessions 汇总常驻 Map + per-session LRU
  (cap 32,键含 synced_at 代际;hits/misses 计数)。sessionDetail 支持
  `turn=` 区间过滤与 `fields=search`(返回 time/search_text/on_surface
  检索面——steward 切料与 memory 回填共用此臂);search 查询走 T2.5 切词
  构造(中文可用)(验证:T4.2;2026-10-19 准备轮复验通过)
- [x] ✅ T4.2 测试 `tests/surface.spec.ts`:种子库→六查询形状/数学断言+LRU
  命中计数+重同步后代际失效+turn 过滤+**中文查询命中 index_text**
  (验证:vitest 绿;含于 66/66 全链 `pnpm check`;另补 register/segment/
  tokenizer 三 spec + smoke 横幅断言——9 文件 66 测试)

## Phase 5: 宿主半与门禁

- [x] ✅ T5.1 `src/index.ts`:inject=['webServer']、双通道路由注册(direct+
  inject,duplicate 容错,ctx.effect 注销)、GET op 分发表、POST sync
  触发后台同步、启动延迟 2.5s syncAll、dispose 关库清定时器
  (验证:T5.3 + 无宿主 node 导入冒烟)
- [x] ✅ T5.2 路由测试 `tests/route.spec.ts`:op→JSON 全 200;未知 op 400;
  webServer 缺席 apply 不抛(验证:vitest 绿)
- [x] ✅ T5.3 门禁全绿:typecheck/lint/test/build + node 冒烟 import
  lib/index.js 建临时库(验证:checklist Must Pass 全勾)——TC/LINT/BUILD/SMOKE
  退出码全 0,vitest 37/37(含 e2e.spec 真件联调:ProjectionSync×真库
  首轮入库/二轮 stat 跳过/mtime 重解码幂等/归档翻转/中文检索命中)

## Phase 6: 一期接线 —— CCI 对账(改 dsh-context-compression-improved)

- [ ] T6.1 CCI `runtime/monitor.ts` 增 DRS 探针:GET
  `/api/dsh-reference-session?op=status&session=<id>`(fail-soft,DRS 缺席
  返回 undefined)(验证:CCI vitest 存根测试)
- [ ] T6.2 面板 verify 对账块:claims vs formula vs drs-recall 三列呈现
  (Δ 行不动,只加对账脚注)(验证:monitor-fab 客户端测试)
- [ ] T6.3 桌面装机冒烟(tgz→profile→重启后 /ccip verify 显示 drs 列)
  (验证:真机路由 200)

## Phase 7: 二期接线 —— steward 内容搜索切换(改 dsh-session-steward)

- [ ] T7.0 前置核对(阻塞项):DRS segments→steward docs 字段对照表齐备
  (type←kind, surface←on_surface, time←segments.time, updated_at←
  sessions.last_time_ms, archived←sessions.archived, title←sessions.title,
  text←search_text);缺项=不动手(验证:对照表进 findings)
- [ ] T7.1 steward 引擎语料源开关:GET op=session&fields=search 造 docs
  (自有切分与 fts 面不动;保留旧 sessionQuery+文件兜底为回退路)
  (验证:steward vitest+真机搜索命中含工具调用参数/todo 内容)
- [ ] T7.2 新鲜度链路验收:interval(T3.3)下新会话≤1 分钟可搜;
  旧目录退役由 steward 侧开关执行,不在 DRS 里做清理
  (验证:真机新会话 1 分钟内命中)

## Phase 8: 三期接线 —— memory 历史投影只读(改 dsh-prime-memory)

- [ ] T8.1 语义更正落档:l0 写路径保持 memory 自有(清洗/脱敏/record_id
  不迁),DRS 仅作历史投影只读源(spec R8 三期已改定;本项=确认计划文本
  无残留「l0 写 DRS」表述)
- [ ] T8.2 memory 历史锚点回填:读 DRS op=session&turn= 按
  (session_id, turn, role, 时间窗)匹配补 l0 旧行 turn/step;匹配不上
  留 NULL 不伪造(对齐 sqlite.ts:591-599 纪律);一次性任务+dry-run 报告
  (验证:抽检脚本;回填前后行数不变仅列填充)
- [ ] T8.3 (独立可选,不卡三期)DRS 增 vec 列+BGE-M3 int8 填充批任务
  (可选依赖,缺资产跳过;embedding_meta 记模型/revision/维度)
  (验证:余弦冒烟=实验台口径)

## Phase 9: 效率验证(横切)

- [ ] T9.1 benchmark 脚本:首轮/二次 syncAll 耗时、status/search p50、
  LRU 命中率(验证:checklist Should Pass 三项达标)
