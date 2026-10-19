/**
 * R5 token 口径断言：vendored deepseek-v4 tokenizer 资产验证臂（正/负）与
 * flash→pro 计数器解析（resolveExactCounter 同步臂）。
 */
import { describe, expect, it } from 'vitest'
import {
  DEEPSEEK_V4_TOKENIZER_ARTIFACT,
  createDeepSeekV4TokenizerFromAssets,
  deepSeekTokenizerArtifacts,
  deepSeekV4TokenizerForModel,
  deepSeekV4TokenizerFailureReason,
} from '../src/deepseek-v4-tokenizer.ts'
import { resolveExactCounter } from '../src/sync.ts'

const V4_ROOT = new URL('../assets/deepseek-v4/', import.meta.url)
const V4_INTEGRITY = {
  tokenizer: { bytes: 6_367_146, sha256: DEEPSEEK_V4_TOKENIZER_ARTIFACT.tokenizerSha256 },
  config: { bytes: 801, sha256: DEEPSEEK_V4_TOKENIZER_ARTIFACT.tokenizerConfigSha256 },
}

describe('deepseek-v4 tokenizer (R5)', () => {
  it('flash 模型解析到真资产计数器，中英混排计数与官方词表一致', () => {
    const tokenizer = deepSeekV4TokenizerForModel('deepseek-v4-flash')
    expect(tokenizer).toBeDefined()
    const count = tokenizer?.countText('hello world 中文')
    expect(count?.kind).toBe('exact-tokenizer')
    expect(count?.tokens).toBe(4)
    expect(count?.tokenizerId).toBe('deepseek-ai/DeepSeek-V4-Pro')
  })

  it('pro 与 flash 共享同一 artifact（modelIds 双映射）', () => {
    expect(DEEPSEEK_V4_TOKENIZER_ARTIFACT.modelIds).toEqual(
      expect.arrayContaining(['deepseek-v4-flash', 'deepseek-v4-pro']))
    expect(deepSeekTokenizerArtifacts().length).toBe(2)
  })

  it('未知模型 → undefined；vision 资产缺席 → undefined + 失败原因缓存', () => {
    expect(deepSeekV4TokenizerForModel('gpt-unknown')).toBeUndefined()
    expect(deepSeekV4TokenizerForModel('deepseek-v4-flash-vision-exp')).toBeUndefined()
    expect(typeof deepSeekV4TokenizerFailureReason('deepseek-v4-flash-vision-exp')).toBe('string')
  })

  it('完整性负分支：bytes 不符/SHA 不符都抛，绝不静默放行', () => {
    expect(() => createDeepSeekV4TokenizerFromAssets(V4_ROOT, {
      tokenizer: { bytes: 1, sha256: V4_INTEGRITY.tokenizer.sha256 },
      config: V4_INTEGRITY.config,
    })).toThrow(/expected 1/u)
    expect(() => createDeepSeekV4TokenizerFromAssets(V4_ROOT, {
      tokenizer: { bytes: V4_INTEGRITY.tokenizer.bytes, sha256: 'f'.repeat(64) },
      config: V4_INTEGRITY.config,
    })).toThrow(/SHA-256/u)
  })

  it('resolveExactCounter 命中 flash → 数值臂 kind=exact-tokenizer', () => {
    const counter = resolveExactCounter()
    expect(counter).toBeDefined()
    const count = counter?.('你好，投影世界')
    expect(count?.kind).toBe('exact-tokenizer')
    if (count?.kind === 'exact-tokenizer') expect(count.tokens).toBeGreaterThan(0)
  })
})
