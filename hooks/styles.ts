import { MARKER, TAIL } from './rules.ts'
import type { Rule } from './types.ts'

// The sentinel always sits within the first MAX_LINES lines, which bounds the
// commit scan's read and the deletion guard's look.
export const MAX_LINES = 4

// line: the sentinel line for this file, no EOL (the caller appends the file's EOL).
export type Located = { at: number; present: boolean; line: string } | { unsupported: string }

const found = (lines: readonly string[], at: number, line: string): Located => ({ at, present: lines[at]?.includes(MARKER) ?? false, line })

// A skip pattern never consumes a line carrying the marker: otherwise a pattern
// that also matches the sentinel (`^#` under a `#` prefix) would step past it
// and insert again on every write.
function skipped(skip: readonly RegExp[], lines: readonly string[], utf8: boolean): number {
  let at = 0
  if (!utf8) return at
  for (const p of skip) if (at < lines.length && !lines[at]!.includes(MARKER) && p.test(lines[at]!)) at++
  return at
}

function jsonProperty(key: string, lines: readonly string[]): Located {
  const brace = lines.findIndex(l => l.trim() !== '')
  if (brace === -1) return { unsupported: lines.length >= MAX_LINES ? 'opening brace below line 3' : 'top level is not an object' }
  if (!lines[brace]!.trimStart().startsWith('{')) return { unsupported: 'top level is not an object' }
  if (brace > 2) return { unsupported: 'opening brace below line 3' }
  if (lines[brace]!.trim() !== '{') return { unsupported: 'opening brace shares its line' }

  const at = brace + 1
  // The sentinel's own line, once inserted, is not the next property.
  const next = lines.slice(at).find(l => l.trim() !== '' && !l.includes(MARKER))
  const indent = next === undefined || next.trimStart().startsWith('}') ? '  ' : /^\s*/.exec(next)![0] || '  '
  const comma = next !== undefined && next.trimStart().startsWith('}') ? '' : ','
  return found(lines, at, `${indent}${JSON.stringify(key)}: ${JSON.stringify(TAIL)}${comma}`)
}

export function locate(rule: Rule, lines: readonly string[], utf8: boolean): Located {
  switch (rule.style) {
    case 'line':
      return found(lines, skipped(rule.skip, lines, utf8), `${rule.prefix} ${TAIL}`)
    case 'block':
      return found(lines, skipped(rule.skip, lines, utf8), `${rule.prefix} ${TAIL} ${rule.suffix}`)
    case 'json-property':
      return jsonProperty(rule.key, lines)
    case 'markdown':
      return lines[0] === '---' ? found(lines, 1, `# ${TAIL}`) : found(lines, 0, `<!-- ${TAIL} -->`)
  }
}
