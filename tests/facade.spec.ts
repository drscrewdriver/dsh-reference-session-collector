/**
 * 跨插件只读门面（drsReadFacade）契约断言。
 *
 * 这个门面是给消费方插件进程内用的（宿主 HTTP 面对插件服务端请求一律 401），
 * 所以它的三条判据都是"消费方能不能安全降级"：
 *  1. 库未就绪时返回 undefined，不抛——消费方据此回退，而不是拿到半初始化对象；
 *  2. apply 的 setImmediate 臂跑完后返回可用门面，且方法形状与 HTTP 面一致；
 *  3. dispose 关库后门面必须失效——否则消费方会拿到指向已关 db 的 QueryContext。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { apply, drsReadFacade } from '../src/index.ts'

/** 让 apply 内 setImmediate 臂跑完（开库 + 建 QueryContext + 赋 liveQuery）。 */
const flushInit = async (): Promise<void> => {
  await new Promise<void>((resolve) => setImmediate(resolve))
  await new Promise<void>((resolve) => setImmediate(resolve))
}

function stubCtx() {
  const effects: Array<() => void | (() => void)> = []
  const ctx = {
    get: vi.fn(() => undefined),
    inject: vi.fn(() => undefined),
    effect: vi.fn((fn: () => void | (() => void)) => {
      effects.push(fn)
    }),
    logger: { info: () => {}, warn: () => {} },
  } as unknown as Parameters<typeof apply>[0]
  return { ctx, effects }
}

const cleanups: string[] = []
afterEach(() => {
  while (cleanups.length > 0) {
    const dir = cleanups.pop()
    try {
      rmSync(dir!, { recursive: true, force: true })
    } catch { /* Windows 短暂锁库，忽略 */ }
  }
})

describe('drsReadFacade 跨插件只读门面', () => {
  it('apply 之前不可用：返回 undefined 而不是抛', () => {
    // 本用例不跑 apply；若前置用例已装配过，dispose 会把它清回去。
    const envDir = mkdtempSync(join(tmpdir(), 'drs-facade-idle-'))
    cleanups.push(envDir)
    const previous = process.env['DSH_REFERENCE_SESSION_COLLECTOR_DIR']
    process.env['DSH_REFERENCE_SESSION_COLLECTOR_DIR'] = envDir
    try {
      expect(drsReadFacade()).toBeUndefined()
    } finally {
      if (previous === undefined) delete process.env['DSH_REFERENCE_SESSION_COLLECTOR_DIR']
      else process.env['DSH_REFERENCE_SESSION_COLLECTOR_DIR'] = previous
    }
  })

  it('apply 就绪后可用，三个读方法形状与 HTTP 面一致', async () => {
    const envDir = mkdtempSync(join(tmpdir(), 'drs-facade-live-'))
    cleanups.push(envDir)
    const previous = process.env['DSH_REFERENCE_SESSION_COLLECTOR_DIR']
    process.env['DSH_REFERENCE_SESSION_COLLECTOR_DIR'] = envDir
    const { ctx, effects } = stubCtx()
    try {
      apply(ctx)
      await flushInit()

      const facade = drsReadFacade()
      expect(facade).toBeDefined()
      expect(typeof facade!.listSessions).toBe('function')
      expect(typeof facade!.sessionDetail).toBe('function')
      expect(typeof facade!.search).toBe('function')

      // 空库：listSessions 给出 total=0 而非抛；search 空命中。
      const listed = facade!.listSessions(0, 5)
      expect(listed.total).toBe(0)
      expect(Array.isArray(listed.rows)).toBe(true)
      const hits = facade!.search('任意词', { limit: 3, redact: true })
      expect(hits.hits).toEqual([])
      expect(hits.query).toBe('任意词')

      // 缺省 offset/limit 必须可用（消费方按可选参调用）。
      expect(facade!.listSessions().total).toBe(0)
    } finally {
      for (const fn of effects) {
        const off = fn()
        if (typeof off === 'function') off()
      }
      if (previous === undefined) delete process.env['DSH_REFERENCE_SESSION_COLLECTOR_DIR']
      else process.env['DSH_REFERENCE_SESSION_COLLECTOR_DIR'] = previous
    }
  })

  it('dispose 关库后门面失效（返回 undefined），不留悬空 QueryContext', async () => {
    const envDir = mkdtempSync(join(tmpdir(), 'drs-facade-gone-'))
    cleanups.push(envDir)
    const previous = process.env['DSH_REFERENCE_SESSION_COLLECTOR_DIR']
    process.env['DSH_REFERENCE_SESSION_COLLECTOR_DIR'] = envDir
    const { ctx, effects } = stubCtx()
    try {
      apply(ctx)
      await flushInit()
      expect(drsReadFacade()).toBeDefined()

      for (const fn of effects) {
        const off = fn()
        if (typeof off === 'function') off()
      }
      expect(drsReadFacade()).toBeUndefined()
    } finally {
      if (previous === undefined) delete process.env['DSH_REFERENCE_SESSION_COLLECTOR_DIR']
      else process.env['DSH_REFERENCE_SESSION_COLLECTOR_DIR'] = previous
    }
  })
})
