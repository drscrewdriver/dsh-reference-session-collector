# Checklist

## Must Pass

- [x] `pnpm -C dsh-reference-session typecheck`(tsc 零错误,strict+exactOptionalPropertyTypes)
- [x] `pnpm -C dsh-reference-session lint`(eslint 零错误)
- [x] `pnpm -C dsh-reference-session test`(三件套:projection 纯核心 / schema+sync / surface 查询面)——37/37 含 route/e2e
- [x] projection:压缩对 gross=Σa−b、recall 对(b>a)入 recall_tokens、compressed 标记+replaced_by 指针落行
- [x] projection:surfaceOp 双形状(startSeq/endSeq 与 start/end)均产出对
- [x] projection:text='' 且 search_text='' 事件不落 segments;chars/4 降级时 sessions.basis='chars/4'
- [x] projection:segments.time=事件 epoch ms;search_text 覆盖 tool/call name+arguments、
  todo/write、turn/end 错误原因(steward 视界超集);on_surface 与 steward
  classifySurface 同视界(被覆盖区间=0、replace 自身=1)
- [x] sync:sessions.archived 随 workspace.json 归档集翻转(只读);
  sessions.last_time_ms=事件最大 time(真库 e2e 已验)
- [x] sync:interval 轮(缺省 30s)stat 全命中时零解码、零重写;env=0 可关
- [x] surface:sessionDetail 的 turn= 区间过滤与 fields=search 返检索面字段
- [x] search:中文查询词命中切分后 index_text(索引/查询同一分词函数)
- [x] sync:stat 命中跳过(第二次 syncAll updated=0);mtime 变化重解码并幂等重写(行数稳定)
- [x] sync:未知 header 代次软跳,不抛,记 softSkipped
- [x] surface:search 命中 fts5;recall 报告含 Σb 与原区间指针
- [x] 路由:GET status/sessions/session/surface/recall/search + POST sync 全 200;webServer 缺席时 apply 不抛
- [x] build:lib/index.js + lib/client.js 产出;client 横幅 id==dsh-reference-session
- [x] dist 冒烟:node 直接 import lib/index.js 打开临时库建表成功(不 import 宿主)——scripts/smoke-lib.mjs

## Should Pass

- [ ] 二次同步耗时 < 200ms(全 skip 路径,37+ 会话);interval 空转轮同此上限(T9.1 真机测)
- [x] status 报告 cache 层命中计数(LRU hits/misses)
- [ ] 首轮全量同步 37 会话后库体积 ≤ 90MB(实验台 baseline.db 现测
  57.5MB,且 DRS 另存 search_text/index_text 多份文本,原 80MB 口径上修)(T9.1)
- [x] vendored 三文件与上游逐字节一致(diff 为空;头注除外;
  deepseek-v4-tokenizer.ts 的 import 路径修正为 T0.5 唯一授权例外)
