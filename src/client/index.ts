// DRS v0 client 半身:合法**空插件**(T1.4 占位,装机实锤修正)。
// ⚠ 不能是裸 `export {}`:client 半身同样经 cordis 插件加载器装载
//   (dsh-plugin-dev 双半契约),形态必须为 function 或 {apply}——空对象
//   触发宿主 "invalid plugin, expect function or object with an
//   'apply' method, received object"。
// 设置卡/面板随消费方接线相(二期)在 apply 里长槽位注入;本版 apply 为
// 合法 no-op。tsdown 横幅负责 __ModuleLoader__.load 包装与 id==包名契约。
export const inject: string[] = []

export function apply(): void {}
