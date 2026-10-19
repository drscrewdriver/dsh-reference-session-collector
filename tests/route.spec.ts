/**
 * T5.2 路由面断言：op→JSON 全 200；未知 op 400；webServer 缺席 apply 不抛；
 * 非 trusted host 403；POST sync 即回 accepted。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { apply, handleDrsRequest, type DrsHandlerDeps } from '../src/index.ts'
import { openProjectionStore, type ProjectionStore } from '../src/schema.ts'
import { projectSessionEvents } from '../src/projection.ts'
import type { DecodedEvent } from '../src/session-file-decode.ts'
import { createQueryContext } from '../src/surface.ts'

interface FakeRes {
  statusCode: number
  body: string
  writeHead(code: number): void
  end(data: string): void
  json(): Record<string, unknown>
}

function fakeRes(): FakeRes {
  const res: FakeRes = {
    statusCode: 0,
    body: '',
    writeHead(code: number) { res.statusCode = code },
    end(data: string) { res.body = data },
    json() { return JSON.parse(res.body) as Record<string, unknown> },
  }
  return res
}

function fakeReq(url: string, method = 'GET', headers: Record<string, string> = {}): Parameters<typeof handleDrsRequest>[1] {
  return { method, url, headers: { host: 'localhost:8080', ...headers } } as unknown as Parameters<typeof handleDrsRequest>[1]
}

const events: DecodedEvent[] = [
  { type: 'step/start', seq: 0, time: 100, data: { turn: 1, step: 1 } },
  { type: 'user/message', seq: 1, time: 200, data: { content: [{ type: 'text', text: '搜索标记词' }] } },
  { type: 'assistant/message', seq: 2, time: 300, data: { message: { content: [{ type: 'text', text: 'body text here' }] } } },
]

let dir = ''
let store: ProjectionStore
let deps: DrsHandlerDeps

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'drs-route-'))
  store = openProjectionStore(dir)
  store.replaceSession(projectSessionEvents(events, { dirId: 'd-route', sessionId: 's-route' }), 10, 20)
  deps = {
    query: createQueryContext(store),
    sync: { syncAll: vi.fn(async () => ({ ok: true })), lastSyncResult: { ok: true, updated: 0 }, isSyncing: false },
  }
})
afterAll(() => {
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

async function get(url: string): Promise<FakeRes> {
  const res = fakeRes()
  await handleDrsRequest(deps, fakeReq(url), res as unknown as Parameters<typeof handleDrsRequest>[2])
  return res
}

describe('GET op 分发', () => {
  it('status → 200 形状', async () => {
    const res = await get('/api/dsh-reference-session?op=status')
    expect(res.statusCode).toBe(200)
    expect(res.json().ok).toBe(true)
    expect(res.json().sessions).toBe(1)
  })

  it('sessions → 200 分页', async () => {
    const res = await get('/api/dsh-reference-session?op=sessions&offset=0&limit=10')
    expect(res.statusCode).toBe(200)
    expect((res.json().rows as unknown[]).length).toBe(1)
  })

  it('session + turn 过滤 + fields=search → 200', async () => {
    const res = await get('/api/dsh-reference-session?op=session&session=s-route&turn=1&fields=search')
    expect(res.statusCode).toBe(200)
    const rows = res.json().rows as Record<string, unknown>[]
    expect(rows.length).toBe(2)
    expect(rows[0]).toHaveProperty('search_text')
    expect(rows[0]).toHaveProperty('on_surface')
    const none = await get('/api/dsh-reference-session?op=session&session=s-route&turn=9')
    expect((none.json().rows as unknown[]).length).toBe(0)
  })

  it('surface → 200 台账', async () => {
    const res = await get('/api/dsh-reference-session?op=surface&session=s-route')
    expect(res.statusCode).toBe(200)
    expect((res.json().on_surface as unknown[]).length).toBeGreaterThan(0)
  })

  it('recall → 200 对账', async () => {
    const res = await get('/api/dsh-reference-session?op=recall&session=s-route')
    expect(res.statusCode).toBe(200)
    expect(res.json().gross_saved).toBe(0)
  })

  it('search 中文命中 → 200', async () => {
    const res = await get('/api/dsh-reference-session?op=search&q=搜索标记词')
    expect(res.statusCode).toBe(200)
    expect((res.json().hits as unknown[]).length).toBeGreaterThan(0)
  })

  it('search group=session 分组臂 → 200，命中行携会话级字段（steward 直连契约）', async () => {
    const res = await get('/api/dsh-reference-session?op=search&group=session&q=搜索标记词&archived=all&sort=time')
    expect(res.statusCode).toBe(200)
    const j = res.json()
    const hits = j.hits as Record<string, unknown>[]
    expect(hits.length).toBeGreaterThan(0)
    expect(hits[0]?.['session_id']).toBe('s-route')
    expect(String(hits[0]?.['seq'])).toBe('1')
    expect(hits[0]?.['type']).toBe('user/message')
    expect(hits[0]).toHaveProperty('updated_at')
    expect(hits[0]).toHaveProperty('snippet')
    // 节选锚定在查询词上（非头部截断）
    expect(String(hits[0]?.['snippet'])).toContain('搜索标记词')
    // kinds 非法展开：显式 tool 类零命中（种子无 tool 行）
    const none = await get('/api/dsh-reference-session?op=search&group=session&q=搜索标记词&kinds=' + encodeURIComponent('tool/call'))
    expect(((none.json() as Record<string, unknown>).hits as unknown[]).length).toBe(0)
  })

  it('缺 session/q 参数 → 400；未知 op → 400', async () => {
    expect((await get('/api/dsh-reference-session?op=session')).statusCode).toBe(400)
    expect((await get('/api/dsh-reference-session?op=search')).statusCode).toBe(400)
    expect((await get('/api/dsh-reference-session?op=nope')).statusCode).toBe(400)
    expect((await get('/api/dsh-reference-session')).statusCode).toBe(400)
  })

  it('recall/surface 省 session 参数 → 自解析最活跃会话（CCI 无参臂契约，装机对练实锤）', async () => {
    const r = await get('/api/dsh-reference-session?op=recall')
    expect(r.statusCode).toBe(200)
    const j = r.json()
    expect(j.ok).toBe(true)
    expect(j.resolved_session_id).toBe('s-route')
    expect(j.resolved_by).toBe('latest')
    const s = await get('/api/dsh-reference-session?op=surface')
    expect(s.statusCode).toBe(200)
    expect((s.json() as Record<string, unknown>).resolved_session_id).toBe('s-route')
    // op=session 明细面仍需显式 session（不自解析）
    expect((await get('/api/dsh-reference-session?op=session')).statusCode).toBe(400)
  })

  it('非 trusted host → 403', async () => {
    const guarded: DrsHandlerDeps = { ...deps, trustedHosts: ['127.0.0.1:8080'] }
    const res = fakeRes()
    await handleDrsRequest(guarded, fakeReq('/api/dsh-reference-session?op=status'), res as unknown as Parameters<typeof handleDrsRequest>[2])
    expect(res.statusCode).toBe(403)
  })

  it('POST sync → accepted；未知 POST op → 400', async () => {
    const res = fakeRes()
    await handleDrsRequest(deps, fakeReq('/api/dsh-reference-session?op=sync', 'POST'), res as unknown as Parameters<typeof handleDrsRequest>[2])
    expect(res.statusCode).toBe(200)
    expect(res.json().accepted).toBe(true)
    expect((deps.sync.syncAll as ReturnType<typeof vi.fn>)).toHaveBeenCalled()
    const bad = fakeRes()
    await handleDrsRequest(deps, fakeReq('/api/dsh-reference-session?op=status', 'POST'), bad as unknown as Parameters<typeof handleDrsRequest>[2])
    expect(bad.statusCode).toBe(400)
  })
})

describe('apply 装配', () => {
  it('webServer 缺席不抛（fail-soft），dispose 关库', () => {
    const envDir = mkdtempSync(join(tmpdir(), 'drs-apply-'))
    const effects: Array<() => void | (() => void)> = []
    const ctx = {
      get: vi.fn(() => undefined),
      inject: vi.fn(() => undefined),
      effect: vi.fn((fn: () => void | (() => void)) => { effects.push(fn) }),
    } as unknown as Parameters<typeof apply>[0]
    const previous = process.env['DSH_REFERENCE_SESSION_DIR']
    process.env['DSH_REFERENCE_SESSION_DIR'] = envDir
    try {
      expect(() => apply(ctx)).not.toThrow()
      // 生命周期 effect 运行并回收
      for (const fn of effects) {
        const off = fn()
        if (typeof off === 'function') off()
      }
    } finally {
      if (previous === undefined) delete process.env['DSH_REFERENCE_SESSION_DIR']
      else process.env['DSH_REFERENCE_SESSION_DIR'] = previous
      rmSync(envDir, { recursive: true, force: true })
    }
  })
})
