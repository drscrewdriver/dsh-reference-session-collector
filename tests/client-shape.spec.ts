/**
 * client 半身形态断言（装机实锤回归）：宿主/客户端 cordis 加载器要求插件
 * 形态为 function 或 {apply}——裸 `export {}` 的空对象会触发
 * "invalid plugin, expect function or object with an 'apply' method"。
 */
import { describe, expect, it } from 'vitest'
import * as client from '../src/client/index.ts'

describe('client half plugin shape', () => {
  it('apply 是函数且 inject 是数组（合法空插件契约）', () => {
    expect(typeof client.apply).toBe('function')
    expect(Array.isArray(client.inject)).toBe(true)
    expect(client.inject).toHaveLength(0)
    // apply no-op 可带任意 ctx 调用不抛
    expect(() => client.apply()).not.toThrow()
  })
})
