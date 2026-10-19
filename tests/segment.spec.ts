/**
 * T2.5 切词叶子断言：Intl.Segmenter('zh') 索引/查询同函数契约 +
 * sanitizeFtsQuery 构造（短语引号转义、尾前缀、多词 AND、空串）。
 */
import { describe, expect, it } from 'vitest'
import { sanitizeFtsQuery, segmentForIndex, segmentQueryTerm } from '../src/segment.ts'

describe('segmentForIndex', () => {
  it('词边界空格连接且字符内容不丢', () => {
    const out = segmentForIndex('中文查询词 abc 混合')
    expect(out).not.toContain('\n')
    expect(out.replace(/\s+/gu, '')).toBe('中文查询词abc混合')
    // 词级切分：CJK 串至少切出一个空格位（非整段透传）
    expect(out.split(' ').length).toBeGreaterThan(1)
  })

  it('空串与非分词输入原样安全', () => {
    expect(segmentForIndex('')).toBe('')
    expect(segmentForIndex('abc')).toBe('abc')
  })
})

describe('segmentQueryTerm', () => {
  it('词性片段优先；整段不可切分时回退原词', () => {
    expect(segmentQueryTerm('正在搜索')).toEqual(expect.arrayContaining(['正在']))
    expect(segmentQueryTerm('abc123')).toEqual(['abc123'])
  })
})

describe('sanitizeFtsQuery', () => {
  it('尾前缀 * 让部分输入命中（steward 同款构造）', () => {
    const q = sanitizeFtsQuery('笔记')
    expect(q).toMatch(/^".*"\*$/)
  })

  it('引号透传不破坏短语结构（词切分剥标点或双写转义，两路均合法）', () => {
    const q = sanitizeFtsQuery('a"b')
    expect(q.length).toBeGreaterThan(0)
    // 输出必须是合法 FTS 短语串：以引号开头、引号总数为偶、末尾前缀星号
    expect(q.startsWith('"')).toBe(true)
    const quotes = (q.match(/"/gu) ?? []).length
    expect(quotes % 2).toBe(0)
    expect(q.endsWith('"*')).toBe(true)
  })

  it('多词 AND（空格连接）、全空白输入=空', () => {
    const q = sanitizeFtsQuery('中文 abc')
    expect(q.split(' ').filter(p => p.startsWith('"')).length).toBe(2)
    expect(sanitizeFtsQuery('   ')).toBe('')
    expect(sanitizeFtsQuery('')).toBe('')
  })
})
