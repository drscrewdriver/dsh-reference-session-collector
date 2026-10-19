/**
 * T5.1 注册通道断言：direct(ctx.get)/inject 迟到臂双通道、duplicate 容错、
 * webServer 无 register 面 fail-soft、dispose 注销路由。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { apply, DRS_API_PATH } from '../src/index.ts'

const disposers: Array<() => void> = []
const dirs: string[] = []

/** webServer.register 入参形状（断言用窄化面）。 */
interface RegisteredRoute { kind: string; path: string; handler?: (req: unknown, res: unknown) => unknown }

function freshCtx(webServer?: unknown) {
  const dir = mkdtempSync(join(tmpdir(), 'drs-reg-'))
  dirs.push(dir)
  const previous = process.env['DSH_REFERENCE_SESSION_DIR']
  process.env['DSH_REFERENCE_SESSION_DIR'] = dir
  const injectArms: Array<(injected: unknown) => void> = []
  const ctx = {
    get: (name: string) => (name === 'webServer' ? webServer : undefined),
    inject: (_deps: string[], cb: (injected: unknown) => void) => { injectArms.push(cb) },
    effect: (fn: () => void | (() => void)) => {
      const off = fn()
      if (typeof off === 'function') disposers.push(off)
    },
    // lifecycle effect 立即执行会挂 2.5s boot timer——本组测试全部走
    // env interval=0 + 及时 dispose，timer 不会实发（见下方断言窗口）。
  }
  void previous
  return { ctx: ctx as unknown as Parameters<typeof apply>[0], injectArms }
}

beforeAll(() => {
  process.env['DSH_REFERENCE_SESSION_SYNC_INTERVAL_MS'] = '0'
})
afterEach(() => {
  while (disposers.length > 0) disposers.pop()?.()
})
afterAll(() => {
  delete process.env['DSH_REFERENCE_SESSION_SYNC_INTERVAL_MS']
  delete process.env['DSH_REFERENCE_SESSION_DIR']
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

describe('双通道路由注册', () => {
  it('direct 臂：webServer 已在 ctx 面 → register(exact, DRS_API_PATH)', () => {
    const off = vi.fn()
    const register = vi.fn((_route: RegisteredRoute) => off)
    const { ctx } = freshCtx({ register })
    apply(ctx)
    expect(register).toHaveBeenCalledTimes(1)
    const route = register.mock.calls[0]?.[0]
    expect(route?.kind).toBe('exact')
    expect(route?.path).toBe(DRS_API_PATH)
  })

  it('dispose 链：route disposer 被调用（ctx.effect 注销臂）', () => {
    const off = vi.fn()
    const { ctx } = freshCtx({ register: (_route: RegisteredRoute) => off })
    apply(ctx)
    while (disposers.length > 0) disposers.pop()?.()
    expect(off).toHaveBeenCalledTimes(1)
  })

  it('duplicate exact route 容错=成功，且不再挂 inject 臂（对侧已拥有路径）', () => {
    const register = vi.fn((_route: RegisteredRoute): never => { throw new Error('duplicate exact route /api/dsh-reference-session') })
    const { ctx, injectArms } = freshCtx({ register })
    expect(() => apply(ctx)).not.toThrow()
    expect(register).toHaveBeenCalledTimes(1)
    expect(injectArms).toHaveLength(0)
  })

  it('inject 迟到臂：direct 面无 webServer → inject 回调触发注册', () => {
    const { ctx, injectArms } = freshCtx(undefined)
    apply(ctx)
    expect(injectArms).toHaveLength(1)
    const lateRegister = vi.fn((_route: RegisteredRoute) => vi.fn())
    injectArms[0]?.({ webServer: { register: lateRegister } })
    expect(lateRegister).toHaveBeenCalledTimes(1)
    expect(lateRegister.mock.calls[0]?.[0]?.path).toBe(DRS_API_PATH)
  })

  it('webServer 无 register()：两臂都 fail-soft 不抛（HTTP 面缺席、同步本体照常）', () => {
    const { ctx, injectArms } = freshCtx({})
    expect(() => apply(ctx)).not.toThrow()
    expect(injectArms).toHaveLength(1)
    expect(() => injectArms[0]?.({ webServer: {} })).not.toThrow()
  })

  it('装机回归（宿主实锤）：未声明服务面访问（属性读+ctx.get）全抛 → 路由仍注册且请求 200', async () => {
    let handler: ((req: unknown, res: unknown) => Promise<unknown>) | undefined
    const register = vi.fn((route: RegisteredRoute) => {
      handler = route.handler as (req: unknown, res: unknown) => Promise<unknown>
      return vi.fn()
    })
    const dir = mkdtempSync(join(tmpdir(), 'drs-hostile-'))
    dirs.push(dir)
    process.env['DSH_REFERENCE_SESSION_DIR'] = dir
    const offs: Array<() => void> = []
    const base = {
      get: (name: string) => {
        if (name === 'webServer') return { register }
        throw new Error(`service '${name}' is not injected`)
      },
      inject: () => {},
      effect: (fn: () => void | (() => void)) => {
        const off = fn()
        if (typeof off === 'function') offs.push(off)
      },
    }
    // cordis Context 的 Proxy 形态：允许声明面与基础设施键，其余服务读即抛
    const allowed = new Set(['get', 'inject', 'effect', 'logger', 'webServer'])
    const hostile = new Proxy(base, {
      get(target, prop) {
        if (typeof prop === 'symbol' || allowed.has(prop)) {
          return prop === 'webServer' ? { register } : Reflect.get(target, prop)
        }
        throw new Error(`service '${String(prop)}' is not injected`)
      },
    })
    apply(hostile as unknown as Parameters<typeof apply>[0])
    expect(register).toHaveBeenCalledTimes(1)
    expect(handler).toBeDefined()
    const res = { statusCode: 0, body: '', writeHead(code: number) { res.statusCode = code }, end(data: string) { res.body = data } }
    const req = { method: 'GET', url: '/api/dsh-reference-session?op=status', headers: { host: '127.0.0.1:3080' } }
    await handler?.(req, res)
    expect(res.statusCode).toBe(200)
    while (offs.length > 0) offs.pop()?.()
  })
})
