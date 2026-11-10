import { decodeLines, decodeUtf8, detectBom, encodeText, isValidUtf8, type Bom, type DecodedLine } from './encoding.ts'
import type { Host } from './host.ts'
import { TAIL } from './rules.ts'
import { locate, MAX_LINES, type Located } from './styles.ts'
import { resolve, type Rule, type Table } from './types.ts'

export type ApplyOutcome = 'inserted' | 'present' | 'skipped' | { failed: string }

export type Inserted = { bytes: Uint8Array } | { present: true } | { unsupported: string }

export async function applyToFile(host: Host, path: string, table: Table): Promise<ApplyOutcome> {
  const rule = resolve(table, path)
  if (rule === undefined) return 'skipped'
  const read = await host.readFile(path)
  if ('missing' in read) return { failed: 'missing' }
  if ('tooLarge' in read) return { failed: 'larger than 4 MiB' }

  const out = insertSentinel(read.bytes, rule)
  if ('present' in out) return 'present'
  if ('unsupported' in out) return { failed: out.unsupported }

  // Text writes only where nothing can be lost: no BOM and the whole file valid
  // UTF-8. Everything else goes byte-exact through Git Bash.
  const asText = detectBom(out.bytes).kind === 'none' && isValidUtf8(out.bytes, 0)
  const ok = asText ? await host.writeText(path, decodeUtf8(out.bytes, 0)) : await host.writeBytes(path, out.bytes)
  return ok ? 'inserted' : { failed: asText ? 'write failed' : 'Git Bash unavailable or write failed' }
}

type Placement = { bom: Bom; lines: DecodedLine[]; located: Located }

function place(bytes: Uint8Array, rule: Rule): Placement {
  const bom = detectBom(bytes)
  const lines = decodeLines(bytes, bom, MAX_LINES)
  const located = locate(rule, lines.map(l => l.text), bom.encoding === 'UTF-8')
  return { bom, lines, located }
}

export function hasSentinel(bytes: Uint8Array, rule: Rule): boolean {
  const { located } = place(bytes, rule)
  return 'present' in located && located.present
}

// The comment syntax a sentinel line of this rule may carry around TAIL.
function wrappers(rule: Rule): string[] {
  switch (rule.style) {
    case 'line':
      return [rule.prefix]
    case 'block':
      return [rule.prefix, rule.suffix]
    case 'json-property':
      return [`${JSON.stringify(rule.key)}:`]
    case 'markdown':
      return ['<!--', '-->', '#']
  }
}

// A line that is this rule's sentinel and nothing else, in any of its forms.
function isOwnSentinel(text: string, rule: Rule): boolean {
  if (!text.includes(TAIL)) return false
  let rest = text.replace(TAIL, '')
  for (const w of wrappers(rule)) rest = rest.replace(w, '')
  return rest.replace(/[\s",]/g, '') === ''
}

// Byte ranges of sentinel lines that sit below the slot: lines added above a
// pending sentinel pushed it down.
function displaced(bytes: Uint8Array, bom: Bom, at: number, rule: Rule): [number, number][] {
  const all = decodeLines(bytes, bom, Number.POSITIVE_INFINITY)
  return all.flatMap((l, i) => (i !== at && isOwnSentinel(l.text, rule) ? [[i === 0 ? bom.length : all[i - 1]!.end, l.end] as [number, number]] : []))
}

function without(bytes: Uint8Array, ranges: readonly [number, number][]): Uint8Array {
  const parts: Uint8Array[] = []
  let from = 0
  for (const [start, end] of ranges) {
    parts.push(bytes.subarray(from, start))
    from = end
  }
  parts.push(bytes.subarray(from))
  return concat(...parts)
}

export function insertSentinel(bytes: Uint8Array, rule: Rule): Inserted {
  const { bom, lines, located } = place(bytes, rule)
  if ('unsupported' in located) return located
  if (located.present) return { present: true }

  // A sentinel pushed out of its slot moves back rather than gaining a copy.
  const moved = displaced(bytes, bom, located.at, rule)
  if (moved.length > 0) {
    const kept = without(bytes, moved)
    const again = insertSentinel(kept, rule)
    return 'present' in again ? { bytes: kept } : again
  }

  const eol = lines[0]?.terminator === '\r\n' ? '\r\n' : '\n'
  const line = encodeText(located.line + eol, bom.encoding)
  const before = located.at === 0 ? undefined : lines[located.at - 1]
  const cut = before?.end ?? bom.length
  // A line the sentinel goes after that has no terminator gains one first.
  const gap = before !== undefined && before.terminator === '' ? encodeText(eol, bom.encoding) : new Uint8Array()
  return { bytes: concat(bytes.subarray(0, cut), gap, line, bytes.subarray(cut)) }
}

export function insertSentinelText(text: string, rule: Rule): string | undefined {
  const out = insertSentinel(encodeText(text, 'UTF-8'), rule)
  return 'bytes' in out ? decodeUtf8(out.bytes, 0) : undefined
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
