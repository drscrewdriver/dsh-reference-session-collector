/**
 * 环境侧声明:DRS 不 value-import 任何宿主官方包(session-file-decode 的
 * `@deepseek-ai/dsh-session` 只是运行时可选软加载,失败即回退本地解码器),
 * 这里给动态 import 一个最小模块面让 tsc 在零宿主依赖下可解析。
 */
declare module '@deepseek-ai/dsh-session' {
  export function decodeStorageRecord(value: unknown): unknown[]
  export function decodeSeqRanges(value: unknown, seq: number): number[]
}
