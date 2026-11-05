import { decodeLines, decodeUtf8, detectBom, encodeText, isValidUtf8, type Bom, type DecodedLine } from './encoding.ts'
import type { Host } from './host.ts'
import { MARKER, sentinelFor, sentinelLineNo } from './rules.ts'

export type ApplyOutcome = 'inserted' | 'present' | 'skipped' | { failed: string }

export async function applyToFile(host: Host, path: string): Promise<ApplyOutcome> {
  if (sentinelFor(path) === undefined) return 'skipped'
  const read = await host.readFile(path)
  if ('missing' in read) return { failed: 'missing' }
  if ('tooLarge' in read) return { failed: 'larger than 4 MiB' }

  const out = insertSentinel(read.bytes, path)
  if (out === undefined) return 'present'

  // Text writes only where nothing can be lost: no BOM and the whole file valid
  // UTF-8. Everything else goes byte-exact through Git Bash.
  const asText = detectBom(out).kind === 'none' && isValidUtf8(out, 0)
  const ok = asText ? await host.writeText(path, decodeUtf8(out, 0)) : await host.writeBytes(path, out)
  return ok ? 'inserted' : { failed: asText ? 'write failed' : 'Git Bash unavailable or write failed' }
}

type Placement = { bom: Bom; first: DecodedLine | undefined; lineNo: 1 | 2; present: boolean }

function place(bytes: Uint8Array, path: string): Placement {
  const bom = detectBom(bytes)
  const [first, second] = decodeLines(bytes, bom, 2)
  const lineNo = sentinelLineNo(path, bom.encoding === 'UTF-8', first?.text ?? '')
  const check = lineNo === 2 ? second?.text : first?.text
  return { bom, first, lineNo, present: check?.includes(MARKER) ?? false }
}

export function hasSentinel(bytes: Uint8Array, path: string): boolean {
  return place(bytes, path).present
}

export function insertSentinel(bytes: Uint8Array, path: string): Uint8Array | undefined {
  const sentinel = sentinelFor(path)
  if (sentinel === undefined) return undefined
  const { bom, first, lineNo, present } = place(bytes, path)
  if (present) return undefined

  const eol = first?.terminator === '\r\n' ? '\r\n' : '\n'
  const line = encodeText(sentinel + eol, bom.encoding)

  if (lineNo === 2 && first !== undefined) {
    const head = bytes.subarray(0, first.end)
    const gap = first.terminator === '' ? encodeText('\n', bom.encoding) : new Uint8Array()
    return concat(head, gap, line, bytes.subarray(first.end))
  }
  return concat(bytes.subarray(0, bom.length), line, bytes.subarray(bom.length))
}

export function insertSentinelText(text: string, path: string): string | undefined {
  const out = insertSentinel(encodeText(text, 'UTF-8'), path)
  return out === undefined ? undefined : decodeUtf8(out, 0)
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}
