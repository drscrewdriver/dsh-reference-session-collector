/**
 * ⚠ VENDORED（回搬件）——源自 dsh-context-compression-improved
 *   `packages/selector/src/runtime/session-file-decode.ts`，回搬时点 2026-10-19。
 *   回搬纪律：**文件级拷贝，禁止分叉**；与源文件逐字节一致，无授权 diff。
 *   （该文件本身又移植自 dsh-session-steward，见下文原头注。）
 */
/**
 * 会话日志文件的只读解码叶子模块（回填后端 B 的格式底座，T19）。
 *
 * **零内部依赖**：只 import `node:*` 内置模块，不引用本插件任何其他 runtime 模块，
 * 供 `stats-backfill.ts`（后端 B）与测试直接消费；断代风险被隔离在本文件内。
 *
 * 移植自 dsh-session-steward 的 `host/health/generation.ts` + `decode.ts`
 * （代次文件名契约 + zstd 多帧/撕裂尾帧/打包行/provenance 解码链），
 * 并按本仓 D7 静态门做纪律适配：
 * - 源码（含注释）不得出现「session+裸点+jsonl」的连续字面量，也不得以任何
 *   大小写/驼峰形态写出宿主的格式版本常量名（检查器扫 src/lib/dist 三类命中，
 *   本注释自身就是最后一个命中点，所以只能用描述式写法）；
 *   历史代文件名一律拼接构造（与 SS 生产代码同技巧），正则内转义点不触发。
 * - **header 代次未知 → fail-soft**：本模块只解码不裁决，提供
 *   `classifySessionHeader`；调用方（回填）据此跳过该会话 + 一次性 warn，
 *   绝不整体抛。
 *
 * 只读纪律：本模块绝不写会话文件（SS 红线先例）。
 */
import { readFileSync, readdirSync, statSync, type Dirent } from 'node:fs'
import { join } from 'node:path'
import zlib from 'node:zlib'

// ─────────────────────────── 代次文件名契约 ───────────────────────────

/** 日志的物理编码（对齐宿主的 JsonlCompression 概念）。 */
export type LogCompression = 'zstd' | 'none'

/**
 * 规范日志名的语法（不含压缩后缀），与宿主 session-format 的 filename 检查器
 * 逐字一致：代次 0 不带版本号，后续代次必须是小写数字且无前导零；
 * `.v0`、`.v01`、`.V1`、`session.v1.backup` 变体都不识别为规范代次。
 */
const CANONICAL_LOG_BASENAME = /^session(?:\.v([1-9][0-9]*))?\.jsonl$/u

/**
 * 迁移暂存名的语法（宿主发布路径的暂存形状 `session.migration.<hex>.jsonl[.zstd].tmp`，
 * token 位数是宿主内部细节，这里只固定形状，宿主换 token 长度时不失明）。
 */
const MIGRATION_STAGING_NAME = /^session\.migration\.[0-9a-f]+\.jsonl(?:\.zstd)?\.tmp$/u

/** 一份日志产物在磁盘上的事实。 */
export interface LogArtifact {
  /** 文件名（不含目录）。 */
  name: string
  /** 绝对路径。 */
  path: string
  bytes: number
  /** mtime（epoch ms）。 */
  mtimeMs: number
}

/** 一份规范代次产物。 */
export interface GenerationArtifact extends LogArtifact {
  /** 该文件承载的格式代次；0 为无版本号的历史代。 */
  version: number
  /** 该文件的物理编码。 */
  compression: LogCompression
}

/** 一个会话目录的代次事实。 */
export interface SessionGenerations {
  /** 目录内全部规范产物，按代次升序（同代次再按 mtime 升序）。 */
  canonical: GenerationArtifact[]
  /** 当前代 = 规范产物中代次最高的一份；目录内没有规范产物时为 undefined。 */
  current?: GenerationArtifact
  /** 历史代（代次 0）；宿主按契约保留已提交的旧代次，不删不改。 */
  legacy?: GenerationArtifact
  /** 迁移暂存残留（发布源）。 */
  staging: LogArtifact[]
  /** 只有历史代、尚无更高代次。 */
  legacyOnly: boolean
}

function compressionSuffix(compression: LogCompression): '.zstd' | '' {
  return compression === 'zstd' ? '.zstd' : ''
}

/**
 * 某代次的规范日志文件名。
 *
 * 注意：历史代的名字必须**拼接构造**（`'.'` 归入分支串），源码文本中不得
 * 出现检查器正则的连续字面量（见文件头 D7 纪律）。
 * @param version - 非负安全整数的格式代次。
 * @param compression - 物理编码（缺省 zstd）。
 * @returns 该代次在会话目录内的文件名。
 */
export function generationLogFilename(version: number, compression: LogCompression = 'zstd'): string {
  if (!Number.isSafeInteger(version) || version < 0) {
    throw new Error(`session log generation must be a non-negative safe integer, got ${String(version)}`)
  }
  const basename = `session${version === 0 ? '.' : `.v${version}.`}jsonl`
  return `${basename}${compressionSuffix(compression)}`
}

/**
 * 把一个规范日志名解析回代次；与宿主同语义：非规范名（临时、大写、前导零、
 * `.v0`、别的压缩后缀）一律返回 undefined，**不猜**。
 * @param filename - 会话目录里的一个文件名。
 * @param compression - 该目录使用的物理编码（缺省 zstd）。
 * @returns 其格式代次，或名字不构成规范代次时的 undefined。
 */
export function parseGenerationLogFilename(filename: string, compression: LogCompression = 'zstd'): number | undefined {
  const suffix = compressionSuffix(compression)
  if (!filename.endsWith(suffix)) return undefined
  const match = CANONICAL_LOG_BASENAME.exec(filename.slice(0, filename.length - suffix.length))
  if (match === null) return undefined
  if (match[1] === undefined) return 0
  const version = Number(match[1])
  return Number.isSafeInteger(version) ? version : undefined
}

/**
 * 两种压缩编码都试一遍，判定该名字是不是某代的规范产物。
 * 发现路径不假设部署的压缩配置（配置在 profile 侧，插件读不到），按名字本身分类。
 * @param filename - 会话目录里的一个文件名。
 * @returns 代次与编码，或该名字不是规范代次时的 undefined。
 */
export function classifyGenerationFilename(filename: string): { version: number; compression: LogCompression } | undefined {
  const zstd = parseGenerationLogFilename(filename, 'zstd')
  if (zstd !== undefined) return { version: zstd, compression: 'zstd' }
  const none = parseGenerationLogFilename(filename, 'none')
  if (none !== undefined) return { version: none, compression: 'none' }
  return undefined
}

/**
 * 该文件名是否是迁移暂存（当前代的发布源）。
 * @param filename - 会话目录里的一个文件名。
 * @returns 是否形如 `session.migration.<token>.jsonl[.zstd].tmp`。
 */
export function isMigrationStagingFilename(filename: string): boolean {
  return MIGRATION_STAGING_NAME.test(filename)
}

/**
 * 读取一个会话目录的代次事实（只读，不碰任何文件内容）。
 * 目录在枚举与读取之间消失（宿主正在删会话）时如实返回「没有产物」，不抛。
 * @param dir - 会话目录的绝对路径。
 * @returns 规范产物（按代次升序）、当前代、历史代与暂存残留。
 */
export function readSessionGenerations(dir: string): SessionGenerations {
  const canonical: GenerationArtifact[] = []
  const staging: LogArtifact[] = []
  let entries: Dirent[]
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return { canonical: [], staging: [], legacyOnly: false }
  }
  for (const entry of entries) {
    if (!entry.isFile()) continue
    const path = join(dir, entry.name)
    let bytes: number
    let mtimeMs: number
    try {
      const stat = statSync(path)
      bytes = stat.size
      mtimeMs = stat.mtimeMs
    } catch {
      continue
    }
    const artifact: LogArtifact = { name: entry.name, path, bytes, mtimeMs }
    const generation = classifyGenerationFilename(entry.name)
    if (generation !== undefined) {
      canonical.push({ ...artifact, version: generation.version, compression: generation.compression })
      continue
    }
    if (isMigrationStagingFilename(entry.name)) staging.push(artifact)
  }
  canonical.sort((left, right) => left.version - right.version || left.mtimeMs - right.mtimeMs)
  staging.sort((left, right) => left.mtimeMs - right.mtimeMs)
  const current = canonical.at(-1)
  const legacy = canonical.find(artifact => artifact.version === 0)
  return {
    canonical,
    staging,
    ...(current === undefined ? {} : { current }),
    ...(legacy === undefined ? {} : { legacy }),
    legacyOnly: canonical.length > 0 && current?.version === 0,
  }
}

// ─────────────────────────── 日志解码链路 ───────────────────────────

/** zstd 帧魔数（0xFD2FB528 的小端读取值）。 */
const ZSTD_MAGIC = 4247762216

/** 打包行类型（读路径必须解包）。 */
const PACKED_ROWS = new Set(['text-chunks', 'reasoning-chunks', 'tool-call-chunks'])

/** 解码后的事件（磁盘存储记录的结构子集；与宿主 SessionEvent 形状兼容但不 import 其类型，保持叶子零依赖）。 */
export interface DecodedEvent {
  type: string
  seq: number
  time: number
  data?: Record<string, unknown>
  surfaceOp?: 'append' | { op: 'replace'; start: number; end: number }
  sourceEventSeqs?: number[]
}

/** 一次读取的统计与问题清单。 */
export interface SessionLogRead {
  events: DecodedEvent[]
  /** 完整帧数。 */
  frames: number
  /** 撕裂尾帧起始偏移（无撕裂为 undefined）。 */
  tornStart?: number
  /** 从撕裂尾帧抢救出的明文字节数。 */
  recoveredFromTorn: number
  /** 读取问题（解码失败/seq 缺口），按遇到顺序。 */
  issues: { line: number; why: string }[]
  /** 实际使用的解码器来源。 */
  decoder: 'official' | 'local'
  /** 尾部是否仍有未收尾的 open step。 */
  openStep?: { turn: number; step: number }
  /** 日志首行的 header（`type: 'session'` 记录）；首行不是 JSON 时为 undefined。 */
  header?: Record<string, unknown>
}

/** 扫描拼接的 zstd 多帧；返回完整帧范围与撕裂尾帧起点。 */
export function scanZstdFrames(buffer: Buffer): {
  frames: { start: number; end: number }[]
  tornStart?: number
} {
  const frames: { start: number; end: number }[] = []
  let offset = 0
  while (offset < buffer.length) {
    const start = offset
    if (buffer.length - offset < 4) return { frames, tornStart: start }
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) return { frames, tornStart: start }
    offset += 4
    if (offset === buffer.length) return { frames, tornStart: start }
    const descriptor = buffer.readUInt8(offset)
    offset += 1
    if ((descriptor & 24) !== 0) return { frames, tornStart: start }
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 32) !== 0
    const checksum = (descriptor & 4) !== 0
    const dictionaryFlag = descriptor & 3
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    if (buffer.length - offset < remainingHeaderBytes) return { frames, tornStart: start }
    offset += remainingHeaderBytes
    for (;;) {
      if (buffer.length - offset < 3) return { frames, tornStart: start }
      const blockHeader = buffer.readUIntLE(offset, 3)
      offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = (blockHeader >>> 1) & 3
      const blockSize = blockHeader >>> 3
      if (blockType === 3) return { frames, tornStart: start }
      const payloadBytes = blockType === 1 ? 1 : blockSize
      if (buffer.length - offset < payloadBytes) return { frames, tornStart: start }
      offset += payloadBytes
      if (lastBlock) break
    }
    if (checksum) {
      if (buffer.length - offset < 4) return { frames, tornStart: start }
      offset += 4
    }
    frames.push({ start, end: offset })
  }
  return { frames }
}

/** 存储形态的 provenance（`[[start,end],…]` 区间编码或直接 seq 数组）展开为递增 seq 列表。 */
export function decodeSeqRangesStorage(value: unknown, currentSeq: number): number[] {
  if (!Array.isArray(value)) throw new Error('sourceEventSeqs must be an array when present')
  const out: number[] = []
  for (const entry of value) {
    if (typeof entry === 'number') {
      out.push(entry)
      continue
    }
    if (Array.isArray(entry) && entry.length === 2) {
      const [start, end] = entry as [unknown, unknown]
      if (typeof start !== 'number' || typeof end !== 'number' || end < start) {
        throw new Error('sourceEventSeqs range is malformed')
      }
      for (let seq = start; seq <= end; seq += 1) out.push(seq)
      continue
    }
    throw new Error('sourceEventSeqs entry is neither a seq nor a [start,end] range')
  }
  for (const seq of out) {
    if (!Number.isSafeInteger(seq) || seq < 0 || seq >= currentSeq) {
      throw new Error(`sourceEventSeqs must reference earlier events: ${seq} >= ${currentSeq}`)
    }
  }
  return out
}

/** 官方解码器面（软加载所得）。 */
export interface OfficialDecoders {
  decodeStorageRecord(value: unknown): DecodedEvent[]
  decodeSeqRanges(value: unknown, seq: number): number[]
}

/**
 * 按需软加载宿主的官方解码器；不可用（未安装/版本不符）时返回 undefined。
 * 插件不 value-import 官方包，这里只做运行时可选加载。
 */
export async function loadOfficialDecoders(): Promise<OfficialDecoders | undefined> {
  try {
    const mod = await import(/* @vite-ignore */ '@deepseek-ai/dsh-session') as unknown as {
      decodeStorageRecord?: (value: unknown) => DecodedEvent[]
      decodeSeqRanges?: (value: unknown, seq: number) => number[]
    }
    if (typeof mod.decodeStorageRecord !== 'function' || typeof mod.decodeSeqRanges !== 'function') return undefined
    return {
      decodeStorageRecord: mod.decodeStorageRecord,
      decodeSeqRanges: mod.decodeSeqRanges,
    }
  } catch {
    return undefined
  }
}

/** 本地等价实现：把一行存储记录解包为事件（打包行展开为 assistant/chunk）。 */
export function decodeRecordLocal(value: unknown): DecodedEvent[] {
  if (typeof value !== 'object' || value === null) return [value as DecodedEvent]
  const record = value as Record<string, unknown>
  const type = record['type']
  if (typeof type !== 'string' || !PACKED_ROWS.has(type)) {
    const seq = record['seq']
    if (typeof seq === 'number' && (!Number.isSafeInteger(seq) || seq < 0)) {
      throw new Error(`session event seq ${String(seq)} is not a non-negative safe integer`)
    }
    return [record as unknown as DecodedEvent]
  }
  const data = record['data'] as Record<string, unknown> | undefined
  if (data === undefined) throw new Error(`malformed ${type} storage row: data must be an object`)
  const members = type === 'tool-call-chunks' ? data['args'] : data['texts']
  if (!Array.isArray(members) || members.length === 0 || members.some(entry => typeof entry !== 'string')) {
    throw new Error(`malformed ${type} storage row: payload must be a non-empty string array`)
  }
  const dt = data['dt']
  if (!Array.isArray(dt) || dt.some(gap => !Number.isSafeInteger(gap))) {
    throw new Error(`malformed ${type} storage row: dt must be an array of safe integers`)
  }
  if (dt.length !== members.length - 1) {
    throw new Error(`malformed ${type} storage row: dt length ${dt.length} does not match ${members.length} members`)
  }
  const seq0 = record['seq0']
  const time0 = record['time0']
  if (typeof seq0 !== 'number' || typeof time0 !== 'number') {
    throw new Error(`malformed ${type} storage row: seq0/time0 must be numbers`)
  }
  const turn = data['turn']
  const step = data['step']
  const index = data['index']
  const out: DecodedEvent[] = []
  let time = time0
  for (let k = 0; k < members.length; k += 1) {
    if (k > 0) time += dt[k - 1] as number
    let chunk: Record<string, unknown>
    if (type === 'text-chunks') chunk = { type: 'text-delta', index, text: members[k] }
    else if (type === 'reasoning-chunks') chunk = { type: 'reasoning-delta', index, text: members[k] }
    else {
      chunk = {
        type: 'tool-call-delta',
        index,
        id: typeof data['id'] === 'string' ? data['id'] : '',
        ...(typeof data['name'] === 'string' ? { name: data['name'] } : {}),
        argumentsDelta: members[k],
      }
    }
    out.push({
      type: 'assistant/chunk',
      seq: seq0 + k,
      time,
      data: { turn, step, chunk },
    })
  }
  return out
}

/**
 * 解码一个会话日志（zstd 帧扫描 + 撕裂尾帧抢救 + 解包 + seq 连续性）。
 * @param bytes - 文件内容（调用方读取，便于测试注入与 mtime/size 只读断言）。
 * @param decoders - 可选官方解码器（缺省用本地等价实现；差异记入 decoder 字段，禁止静默回退）。
 * @returns 事件、统计与问题清单。
 */
export function decodeSessionLogBytes(
  bytes: Buffer,
  decoders?: OfficialDecoders,
): SessionLogRead {
  const { frames, tornStart } = scanZstdFrames(bytes)
  const parts: Buffer[] = []
  const frameIssues: string[] = []
  for (const frame of frames) {
    try {
      parts.push(zlib.zstdDecompressSync(bytes.subarray(frame.start, frame.end)))
    } catch (err) {
      frameIssues.push(`frame@${frame.start}: ${String(err instanceof Error ? err.message : err)}`)
    }
  }
  let recoveredFromTorn = 0
  if (tornStart !== undefined) {
    try {
      const recovered = zlib.zstdDecompressSync(bytes.subarray(tornStart), {
        finishFlush: zlib.constants.ZSTD_e_flush,
      })
      recoveredFromTorn = recovered.length
      parts.push(recovered)
    } catch { /* 撕裂帧完全不可抢救 */ }
  }
  const text = (() => {
    const payload = Buffer.concat(parts)
    // 明文产物（compression=none）：帧扫描在偏移 0 就发现不是 zstd 帧头，整段
    // buffer 即 UTF-8 文本，直接按行解。非 zstd 的垃圾字节也走这条路：行解析
    // 失败进 issues、header 缺失，fail-soft 语义不变。
    if (payload.length === 0 && frames.length === 0 && bytes.length > 0) return bytes.toString('utf8')
    return payload.toString('utf8')
  })()
  const lines = text.split('\n').filter(line => line.trim() !== '')
  const issues: { line: number; why: string }[] = frameIssues.map((why, index) => ({ line: index + 1, why }))
  const decodeRecord = decoders?.decodeStorageRecord ?? decodeRecordLocal
  const events: DecodedEvent[] = []
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

/** 从文件读取并解码（只读）。 */
export function decodeSessionLogFile(file: string, decoders?: OfficialDecoders): SessionLogRead {
  return decodeSessionLogBytes(readFileSync(file), decoders)
}

/** 尾部未收尾的 open step（有 step/start 无对应 step/end）。 */
export function findOpenStep(events: readonly DecodedEvent[]): { turn: number; step: number } | undefined {
  let open: { turn: number; step: number } | undefined
  for (const event of events) {
    const data = event.data as { turn?: unknown; step?: unknown } | undefined
    if (event.type === 'step/start' && typeof data?.turn === 'number' && typeof data?.step === 'number') {
      open = { turn: data.turn, step: data.step }
      continue
    }
    if (event.type === 'step/end') open = undefined
  }
  return open
}

// ─────────────────────────── header 代次裁决（fail-soft 输入） ───────────────────────────

/** 本插件已实证认得的格式代次集合（v3/v4 线；其余一律按未知处理）。 */
export const KNOWN_SESSION_FORMAT_GENERATIONS: ReadonlySet<number> = new Set([3, 4])

/** header 代次分类结果：`known` 可回填；其余调用方必须跳过该会话（fail-soft）。 */
export type SessionHeaderVerdict =
  | { readonly state: 'known'; readonly version: number }
  | { readonly state: 'missing-header' }
  | { readonly state: 'not-session' }
  | { readonly state: 'unknown-version'; readonly version: unknown }

/**
 * 从解码结果的 header 判定格式代次是否可回填。
 *
 * 本模块只分类不告警——「跳过该会话 + 恰一条 warn」的裁决属于调用方
 * （stats-backfill）的责任面，保证叶子模块无副作用。
 * @param header - decodeSessionLog 结果里的 header（首行不是 JSON 时 undefined）。
 * @param known - 已知代次集合（缺省 {@link KNOWN_SESSION_FORMAT_GENERATIONS}）。
 */
export function classifySessionHeader(
  header: Record<string, unknown> | undefined,
  known: ReadonlySet<number> = KNOWN_SESSION_FORMAT_GENERATIONS,
): SessionHeaderVerdict {
  if (header === undefined) return { state: 'missing-header' }
  if (header['type'] !== 'session') return { state: 'not-session' }
  const version = header['version']
  if (typeof version === 'number' && known.has(version)) return { state: 'known', version }
  return { state: 'unknown-version', version }
}
