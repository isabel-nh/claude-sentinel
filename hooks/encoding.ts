export type Encoding = 'UTF-8' | 'UTF-16LE' | 'UTF-16BE' | 'UTF-32LE' | 'UTF-32BE'

export type Bom = {
  kind: 'none' | 'utf8' | 'utf16le' | 'utf16be' | 'utf32le' | 'utf32be'
  length: 0 | 2 | 3 | 4
  encoding: Encoding
}

export type DecodedLine = { text: string; terminator: '' | '\n' | '\r\n'; end: number }

const REPLACEMENT = 0xfffd

export function detectBom(b: Uint8Array): Bom {
  const at = (i: number) => b[i] ?? -1
  if (at(0) === 0xff && at(1) === 0xfe && at(2) === 0 && at(3) === 0) return { kind: 'utf32le', length: 4, encoding: 'UTF-32LE' }
  if (at(0) === 0 && at(1) === 0 && at(2) === 0xfe && at(3) === 0xff) return { kind: 'utf32be', length: 4, encoding: 'UTF-32BE' }
  if (at(0) === 0xff && at(1) === 0xfe) return { kind: 'utf16le', length: 2, encoding: 'UTF-16LE' }
  if (at(0) === 0xfe && at(1) === 0xff) return { kind: 'utf16be', length: 2, encoding: 'UTF-16BE' }
  if (at(0) === 0xef && at(1) === 0xbb && at(2) === 0xbf) return { kind: 'utf8', length: 3, encoding: 'UTF-8' }
  return { kind: 'none', length: 0, encoding: 'UTF-8' }
}

// Returns [code point, byte length], or [-1, 0] at the end of input. Invalid or
// truncated sequences decode as U+FFFD consuming one unit, so callers can always
// advance.
function nextCodePoint(b: Uint8Array, i: number, enc: Encoding): [number, number] {
  const n = b.length
  if (i >= n) return [-1, 0]
  switch (enc) {
    case 'UTF-8':
      return nextUtf8(b, i)
    case 'UTF-16LE':
    case 'UTF-16BE': {
      if (i + 1 >= n) return [REPLACEMENT, n - i]
      const unit = (j: number) => (enc === 'UTF-16LE' ? b[j]! | (b[j + 1]! << 8) : (b[j]! << 8) | b[j + 1]!)
      const hi = unit(i)
      if (hi >= 0xd800 && hi <= 0xdbff && i + 3 < n) {
        const lo = unit(i + 2)
        if (lo >= 0xdc00 && lo <= 0xdfff) return [0x10000 + ((hi - 0xd800) << 10) + (lo - 0xdc00), 4]
      }
      return [hi >= 0xd800 && hi <= 0xdfff ? REPLACEMENT : hi, 2]
    }
    case 'UTF-32LE':
    case 'UTF-32BE': {
      if (i + 3 >= n) return [REPLACEMENT, n - i]
      const cp = enc === 'UTF-32LE'
        ? (b[i]! | (b[i + 1]! << 8) | (b[i + 2]! << 16) | (b[i + 3]! << 24)) >>> 0
        : ((b[i]! << 24) | (b[i + 1]! << 16) | (b[i + 2]! << 8) | b[i + 3]!) >>> 0
      return [cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff) ? REPLACEMENT : cp, 4]
    }
  }
}

function nextUtf8(b: Uint8Array, i: number): [number, number] {
  const b0 = b[i]!
  if (b0 < 0x80) return [b0, 1]
  let need: number
  let cp: number
  let min: number
  if (b0 >= 0xc2 && b0 <= 0xdf) { need = 1; cp = b0 & 0x1f; min = 0x80 }
  else if (b0 >= 0xe0 && b0 <= 0xef) { need = 2; cp = b0 & 0x0f; min = 0x800 }
  else if (b0 >= 0xf0 && b0 <= 0xf4) { need = 3; cp = b0 & 0x07; min = 0x10000 }
  else return [-2, 1]
  if (i + need >= b.length) return [-2, 1]
  for (let k = 1; k <= need; k++) {
    const c = b[i + k]!
    if ((c & 0xc0) !== 0x80) return [-2, 1]
    cp = (cp << 6) | (c & 0x3f)
  }
  if (cp < min || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return [-2, 1]
  return [cp, need + 1]
}

export function decodeLines(b: Uint8Array, bom: Bom, count: number): DecodedLine[] {
  const lines: DecodedLine[] = []
  let i = bom.length
  let text = ''
  while (lines.length < count) {
    const [raw, size] = nextCodePoint(b, i, bom.encoding)
    if (raw === -1) {
      if (text.length > 0) lines.push({ text, terminator: '', end: i })
      break
    }
    i += size
    const cp = raw === -2 ? REPLACEMENT : raw
    if (cp === 0x0a) {
      const crlf = text.endsWith('\r')
      lines.push({ text: crlf ? text.slice(0, -1) : text, terminator: crlf ? '\r\n' : '\n', end: i })
      text = ''
    } else {
      text += String.fromCodePoint(cp)
    }
  }
  return lines
}

export function encodeText(text: string, enc: Encoding): Uint8Array {
  const out: number[] = []
  for (const ch of text) {
    const cp = ch.codePointAt(0)!
    switch (enc) {
      case 'UTF-8':
        if (cp < 0x80) out.push(cp)
        else if (cp < 0x800) out.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f))
        else if (cp < 0x10000) out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f))
        else out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f))
        break
      case 'UTF-16LE':
      case 'UTF-16BE': {
        const units = cp < 0x10000 ? [cp] : [0xd800 + ((cp - 0x10000) >> 10), 0xdc00 + ((cp - 0x10000) & 0x3ff)]
        for (const u of units) out.push(...(enc === 'UTF-16LE' ? [u & 0xff, u >> 8] : [u >> 8, u & 0xff]))
        break
      }
      case 'UTF-32LE':
        out.push(cp & 0xff, (cp >> 8) & 0xff, (cp >> 16) & 0xff, cp >>> 24)
        break
      case 'UTF-32BE':
        out.push(cp >>> 24, (cp >> 16) & 0xff, (cp >> 8) & 0xff, cp & 0xff)
        break
    }
  }
  return new Uint8Array(out)
}

export function isValidUtf8(b: Uint8Array, from: number): boolean {
  for (let i = from; i < b.length;) {
    const [cp, size] = nextUtf8(b, i)
    if (cp === -2) return false
    i += size
  }
  return true
}

export function decodeUtf8(b: Uint8Array, from: number): string {
  let s = ''
  for (let i = from; i < b.length;) {
    const [cp, size] = nextUtf8(b, i)
    s += String.fromCodePoint(cp === -2 ? REPLACEMENT : cp)
    i += size
  }
  return s
}
