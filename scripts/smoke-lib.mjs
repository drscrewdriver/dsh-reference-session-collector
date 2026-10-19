// T5.3 node 冒烟（门禁链）：无宿主环境导入 lib/index.js → 建临时库 → apply 不抛
// → client 横幅 id==包名（checklist Must Pass 自动化面）。
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const dir = mkdtempSync(join(tmpdir(), 'drs-smoke-'))
process.env['DSH_REFERENCE_SESSION_DIR'] = dir
const m = await import('../lib/index.js')
if (typeof m.apply !== 'function' || !Array.isArray(m.inject)) throw new Error('export face missing')
const store = m.openProjectionStore(dir)
const p = m.projectSessionEvents([
  { type: 'user/message', seq: 0, time: 1, data: { content: [{ type: 'text', text: '冒烟' }] } },
  { type: 'assistant/message', seq: 1, time: 2, data: { message: { content: [{ type: 'text', text: 'hi body' }] } } },
], { dirId: 'smoke' })
store.replaceSession(p, 1, 2)
const ctx = { get: () => undefined, inject: () => {}, effect: (fn) => { ctx.__effects.push(fn) } , __effects: [] }
m.apply(ctx)
const n = store.db.prepare('SELECT COUNT(*) AS c FROM segments').get()
store.close()
// 执行 apply 注册的生命周期 effect 并回收（dispose 关库清定时器）
for (const fn of ctx.__effects) {
  const off = fn()
  if (typeof off === 'function') off()
}
// client 半身横幅契约：ModuleLoader.load + id==包名
const client = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
if (!client.includes('window.__ModuleLoader__.load') || !client.includes('"dsh-reference-session"')) {
  throw new Error('client banner missing ModuleLoader.load or wrong id')
}
// 装机实锤回归：client 产物必须暴露 apply（空对象会触发宿主 invalid plugin）
if (!/\bapply\b/u.test(client)) {
  throw new Error('client bundle exposes no apply — cordis loader will reject as invalid plugin')
}
rmSync(dir, { recursive: true, force: true })
console.log('SMOKE_OK segments=' + n.c + ' inject=' + JSON.stringify(m.inject) + ' client-banner=ok')
