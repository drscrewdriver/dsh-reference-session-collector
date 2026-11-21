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

// ─────────────────────────── 帧级增量尾段解码（issue #3） ───────────────────────────

/** 事件流终态滚动归属（水位写入用）：最后一个 step/start 的 turn/step；无则 0/0。 */
export function finalRollState(events: readonly DecodedEvent[]): { turn: number; step: number } {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i]
    if (event?.type !== 'step/start') continue
    const data = typeof event.data === 'object' && event.data !== null
      ? (event.data as { turn?: unknown; step?: unknown })
      : undefined
    return {
      turn: typeof data?.turn === 'number' ? data.turn : 0,
      step: typeof data?.step === 'number' ? data.step : 0,
    }
  }
  return { turn: 0, step: 0 }
}

/** 尾段解码读数（{@link decodeSessionLogTailAsync} 产出）。 */
export interface SessionLogTailRead {
  /**
   * 尾段起点是否为合法帧边界（zstd 魔数可扫）。false = 明文产物/字节错位
   * （宿主回缩重写等）——调用方必须回退全量，绝不猜。
   */
  boundaryOk: boolean
  /** 完整帧内稠密解码的事件（seq 为绝对值；torn 区域不消费）。 */
  events: DecodedEvent[]
  /** 尾段内首个事件的 seq（空尾段/零事件=undefined）。 */
  firstSeq?: number
  /** 尾段内末个事件的 seq。 */
  lastSeq?: number
  /** 完整帧数。 */
  frames: number
  /** 水位停靠位：**尾段 buffer 内的相对偏移**（torn 起点，或尾段末尾）。 */
  consumedEndOffset: number
  /** 解码问题清单（非空=调用方回退全量）。 */
  issues: { line: number; why: string }[]
}

/**
 * 尾段解码（issue #3）：从**帧边界**起只解新增帧——O(新增) 读取与解压的
 * 解码面。与 {@link decodeSessionLogTailAsync} 全量版的差异：
 * - **torn 区域不消费**（全量版会抢救明文行）——torn 字节会被宿主
 *   truncateTornTail 重写，字节水位对重写区不稳定；跳过它，下一轮在
 *   重写后的完整帧里按 seq 前缀去重接续（see sync 侧 dedup 规则）。
 * - seq 稠密校验以**尾段首个事件**为基（全量版从 0 起）——重写区回放
 *   的历史事件 seq 不从 0 开始。
 * - 首行 header 不在本面（header 在第一帧的解压文本里，增量路径不重读；
 *   代次守卫走产物文件名版本 + sessions 行 format_generation）。
 */
export async function decodeSessionLogTailAsync(
  tail: Buffer,
  decoders?: OfficialDecoders,
  yieldEveryFrames: number = DEFAULT_YIELD_EVERY_FRAMES,
  yieldEveryLines: number = DEFAULT_YIELD_EVERY_LINES,
): Promise<SessionLogTailRead> {
  const { frames, tornStart } = scanZstdFrames(tail)
  if (tail.length > 0 && frames.length === 0) {
    // 尾段起点不是帧头：明文产物（compression=none）或字节错位——不猜，回退全量。
    return { boundaryOk: false, events: [], frames: 0, consumedEndOffset: 0, issues: [] }
  }
  const parts: Buffer[] = []
  const frameIssues: string[] = []
  let sinceYield = 0
  for (const frame of frames) {
    try {
      parts.push(await zstdDecompressAsync(tail.subarray(frame.start, frame.end)))
    } catch (err) {
      frameIssues.push(`frame@${frame.start}: ${String(err instanceof Error ? err.message : err)}`)
    }
    sinceYield += 1
    if (yieldEveryFrames > 0 && sinceYield >= yieldEveryFrames) {
      sinceYield = 0
      await yieldToLoop()
    }
  }
  const consumedEndOffset = tornStart !== undefined ? tornStart : tail.length
  if (frameIssues.length > 0) {
    return {
      boundaryOk: true, events: [], frames: frames.length, consumedEndOffset,
      issues: frameIssues.map((why, index) => ({ line: index + 1, why })),
    }
  }
  const text = Buffer.concat(parts).toString('utf8')
  const lines = text.split('\n').filter(line => line.trim() !== '')
  const decodeRecord = decoders?.decodeStorageRecord ?? decodeRecordLocal
  const events: DecodedEvent[] = []
  const issues: { line: number; why: string }[] = []
  let base: number | undefined
  let linesSinceYield = 0
  for (let index = 0; index < lines.length; index += 1) {
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
    for (const event of decoded) {
      if (base === undefined) base = event.seq
      if (event.seq !== base + events.length) {
        issues.push({ line: index + 1, why: `seq gap (expected ${base + events.length}, got ${event.seq})` })
        return {
          boundaryOk: true, events: [], frames: frames.length, consumedEndOffset, issues,
        }
      }
      events.push(event)
    }
    linesSinceYield += 1
    if (yieldEveryLines > 0 && linesSinceYield >= yieldEveryLines) {
      linesSinceYield = 0
      await yieldToLoop()
    }
  }
  const first = events[0]
  const last = events[events.length - 1]
  return {
    boundaryOk: true,
    events,
    ...(first !== undefined && last !== undefined ? { firstSeq: first.seq, lastSeq: last.seq } : {}),
    frames: frames.length,
    consumedEndOffset,
    issues,
  }
}
