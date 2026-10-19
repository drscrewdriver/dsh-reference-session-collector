// 一次性：统计 user/message 文本里的注入样板标记全集（决定剥离规则）
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { decodeSessionLogBytes } from './lib/index.js'

const sessionsRoot = join(process.env.USERPROFILE ?? '', '.dsh', 'sessions')
function* walkDir(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) yield* walkDir(p)
    else if (/session(\.v\d+)?\.jsonl(\.zstd)?$/.test(e.name)) yield p
  }
}
function decode(f) {
  const read = decodeSessionLogBytes(readFileSync(f))
  return read && Array.isArray(read.events) ? read.events : null
}

const tagCount = new Map()
const tagLen = new Map()
let userMsgs = 0
let withTags = 0
for (const f of walkDir(sessionsRoot)) {
  const events = decode(f)
  if (!events) continue
  for (const ev of events) {
    if (!ev || ev.type !== 'user/message') continue
    const blocks = ev.data?.content ?? ev.data?.message?.content ?? []
    if (!Array.isArray(blocks)) {
      continue
    }
    for (const b of blocks) {
      if (!b || b.type !== 'text' || typeof b.text !== 'string') continue
      userMsgs += 1
      const text = b.text
      // 顶层成对标记（不区分大小写）+ 常见系统标记词
      const tags = [...text.matchAll(/<([a-z][\w-]{2,40})>(?:(?!\1)[\s\S]){0,20000}?<\/\1>/gi)]
      if (tags.length > 0) withTags += 1
      for (const m of tags) {
        const t = m[1].toLowerCase()
        tagCount.set(t, (tagCount.get(t) ?? 0) + 1)
        tagLen.set(t, Math.max(tagLen.get(t) ?? 0, m[0].length))
      }
    }
  }
}
const rows = [...tagCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25)
console.log(JSON.stringify({ userMsgs, withTags }, null, 0))
for (const [t, n] of rows) console.log(t, 'count=' + n, 'maxLen=' + tagLen.get(t))
