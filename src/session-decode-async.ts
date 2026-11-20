/**
 * 会话日志的**异步分片解码**（issue #2）：与 `session-file-decode.ts` 的同步
 * {@link decodeSessionLogBytes} 产出逐字节等价的结果，但把不可中断的同步段
 * 拆成可让路的片，使大会话（issue 实测单会话解压约 62MB）不再独占宿主主线程。
 *
 * ## 为什么单独一个文件
 *
 * `session-file-decode.ts` 是 **VENDORED 回搬件**（文件头写明「文件级拷贝，禁止
 * 分叉；与源文件逐字节一致，无授权 diff」）。在里面加异步版就是分叉，违反回搬
 * 纪律。本文件只**消费**它的导出叶子件（`scanZstdFrames` / `decodeRecordLocal` /
 * `decodeSeqRangesStorage` / `findOpenStep` 等），一行都不改它。
 *
 * ## 让路点
 *
 * - **帧间**：每 `yieldEveryFrames` 帧 `await` 一次（缺省 8）。帧彼此独立，天然
 *   可切分；逐帧让路会让数千帧的会话吞吐崩塌，所以按批。
 * - **行批间**：行解码每 `yieldEveryLines` 行 `await` 一次（缺省 512）。明文
 *   （compression=none）与已拼接的文本都走这条，覆盖帧数少但行数多的场景。
 *
 * 异步 zlib 本身走 Node 的线程池，解压计算不占主线程；让路点保证的是「主线程
 * 能在片之间处理别的请求」，两者互补。
 *
 * 只读纪律：本模块不写任何文件。
 *
 * @module dsh-reference-session-collector/session-decode-async
 */
import zlib from 'node:zlib'
import { promisify } from 'node:util'
import {
  decodeRecordLocal,
  decodeSeqRangesStorage,
  findOpenStep,
  scanZstdFrames,
  type DecodedEvent,
  type OfficialDecoders,
  type SessionLogRead,
} from './session-file-decode.ts'

const zstdDecompressAsync = promisify(zlib.zstdDecompress) as (
  buffer: Buffer,
  options?: zlib.ZstdOptions,
) => Promise<Buffer>

/** 帧间让路间隔：每 N 帧给事件循环一次机会。 */
export const DEFAULT_YIELD_EVERY_FRAMES = 8

/** 行批让路间隔：每 N 行给事件循环一次机会。 */
export const DEFAULT_YIELD_EVERY_LINES = 512

/** 让一次事件循环（宏任务边界，宿主请求得以插话）。 */
function yieldToLoop(): Promise<void> {
  return new Promise<void>(resolve => { setImmediate(resolve) })
}

/**
 * 异步分片解码一个会话日志，结果与同步 {@link decodeSessionLogBytes} 等价。
 * @param bytes - 文件内容（调用方读取，便于测试注入）。
 * @param decoders - 可选官方解码器（缺省用本地等价实现；差异记入 `decoder` 字段，禁止静默回退）。
 * @param yieldEveryFrames - 每解压多少帧让路一次（≤0 表示不按帧让路）。
 * @param yieldEveryLines - 每解码多少行让路一次（≤0 表示不按行让路）。
 * @returns 事件、统计与问题清单——字段与同步版逐一对应。
 */
export async function decodeSessionLogBytesAsync(
  bytes: Buffer,
  decoders?: OfficialDecoders,
  yieldEveryFrames: number = DEFAULT_YIELD_EVERY_FRAMES,
  yieldEveryLines: number = DEFAULT_YIELD_EVERY_LINES,
): Promise<SessionLogRead> {
  const { frames, tornStart } = scanZstdFrames(bytes)
  const parts: Buffer[] = []
  const frameIssues: string[] = []
  let sinceYield = 0
  for (const frame of frames) {
    try {
      parts.push(await zstdDecompressAsync(bytes.subarray(frame.start, frame.end)))
    } catch (err) {
      frameIssues.push(`frame@${frame.start}: ${String(err instanceof Error ? err.message : err)}`)
    }
    sinceYield += 1
    if (yieldEveryFrames > 0 && sinceYield >= yieldEveryFrames) {
      sinceYield = 0
      await yieldToLoop()
    }
  }
  let recoveredFromTorn = 0
  if (tornStart !== undefined) {
    try {
      const recovered = await zstdDecompressAsync(bytes.subarray(tornStart), {
        finishFlush: zlib.constants.ZSTD_e_flush,
      })
      recoveredFromTorn = recovered.length
      parts.push(recovered)
    } catch { /* 撕裂帧完全不可抢救 */ }
  }
  const text = (() => {
    const payload = Buffer.concat(parts)
    // 明文产物（compression=none）：帧扫描在偏移 0 就发现不是 zstd 帧头，整段
    // buffer 即 UTF-8 文本，直接按行解。与同步版逐字同义。
    if (payload.length === 0 && frames.length === 0 && bytes.length > 0) return bytes.toString('utf8')
    return payload.toString('utf8')
  })()
  const lines = text.split('\n').filter(line => line.trim() !== '')
  const issues: { line: number; why: string }[] = frameIssues.map((why, index) => ({ line: index + 1, why }))
  const decodeRecord = decoders?.decodeStorageRecord ?? decodeRecordLocal
  const events: DecodedEvent[] = []
  let linesSinceYield = 0
  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index] as string
    let decoded: DecodedEvent[]
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>
      const withProvenance = parsed['sourceEventSeqs'] === undefined
        ? parsed
        : {
            ...parsed,
            sourceEventSeqs: decoders?.decodeSeqRanges !== undefined && typeof parsed['seq'] === 'number'
              ? decoders.decodeSeqRanges(parsed['sourceEventSeqs'], parsed['seq'])
              : decodeSeqRangesStorage(parsed['sourceEventSeqs'], Number(parsed['seq'] ?? 0)),
          }
      decoded = decodeRecord(withProvenance)
    } catch (err) {
      issues.push({ line: index + 1, why: `decode failed: ${String(err instanceof Error ? err.message : err)}` })
      break
    }
    const rowStart = events.length
    let gapped = false
    for (const event of decoded) {
      if (event.seq !== events.length) {
        issues.push({ line: index + 1, why: `seq gap (expected ${events.length}, got ${event.seq})` })
        events.length = rowStart
        gapped = true
        break
      }
      events.push(event)
    }
    if (gapped) break
    linesSinceYield += 1
    if (yieldEveryLines > 0 && linesSinceYield >= yieldEveryLines) {
      linesSinceYield = 0
      await yieldToLoop()
    }
  }
  const openStep = findOpenStep(events)
  // 首行是 header，不参与事件序列（上面的事件循环从 index 1 起）。
  let header: Record<string, unknown> | undefined
  const headerLine = lines[0]
  if (headerLine !== undefined) {
    try {
      const parsed: unknown = JSON.parse(headerLine)
      if (typeof parsed === 'object' && parsed !== null) header = parsed as Record<string, unknown>
    } catch { /* 首行不是 JSON：header 不可读，按缺失处理 */ }
  }
  return {
    events,
    frames: frames.length,
    ...(tornStart === undefined ? {} : { tornStart }),
    recoveredFromTorn,
    issues,
    decoder: decoders === undefined ? 'local' : 'official',
    ...(openStep === undefined ? {} : { openStep }),
    ...(header === undefined ? {} : { header }),
  }
}
