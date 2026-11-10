import { basename, extension } from './rules.ts'

export type StyleName = 'line' | 'block' | 'json-property' | 'markdown'

export type Entry =
  | { style: 'line'; prefix: string; skip?: string[] }
  | { style: 'block'; prefix: string; suffix: string; skip?: string[] }
  | { style: 'json-property'; key?: string }
  | { style: 'markdown' }

export type Rule =
  | { style: 'line'; prefix: string; skip: readonly RegExp[] }
  | { style: 'block'; prefix: string; suffix: string; skip: readonly RegExp[] }
  | { style: 'json-property'; key: string }
  | { style: 'markdown' }

// Keyed by '.ext' or an exact file name.
export type Table = ReadonlyMap<string, Rule>

// key '' names a problem with the option as a whole.
export type Problem = { key: string; reason: string }

const SHEBANG = ['^#!']
const slash = (skip?: string[]): Entry => (skip ? { style: 'line', prefix: '//', skip } : { style: 'line', prefix: '//' })
const hash = (skip?: string[]): Entry => (skip ? { style: 'line', prefix: '#', skip } : { style: 'line', prefix: '#' })

export const BUILTIN_ENTRIES: Readonly<Record<string, Entry>> = {
  '.cs': slash(),
  '.jsx': slash(),
  '.tsx': slash(),
  '.js': slash(SHEBANG),
  '.mjs': slash(SHEBANG),
  '.ts': slash(SHEBANG),
  '.sql': { style: 'line', prefix: '--' },
  '.yaml': hash(),
  '.yml': hash(),
  '.py': hash(SHEBANG),
  '.sh': hash(SHEBANG),
  '.ps1': hash(SHEBANG),
  '.gitignore': hash(),
  '.gitattributes': hash(),
}

export const PRESETS: Readonly<Record<string, Entry>> = {
  '.md': { style: 'markdown' },
  '.json': { style: 'json-property' },
  '.jsonc': { style: 'line', prefix: '//', skip: ['^\\s*[\\[{]\\s*$'] },
  '.css': { style: 'block', prefix: '/*', suffix: '*/' },
  '.html': { style: 'block', prefix: '<!--', suffix: '-->' },
  '.xml': { style: 'block', prefix: '<!--', suffix: '-->' },
}

const FIELDS: Readonly<Record<StyleName, readonly string[]>> = {
  line: ['style', 'prefix', 'skip'],
  block: ['style', 'prefix', 'suffix', 'skip'],
  'json-property': ['style', 'key'],
  markdown: ['style'],
}

const isStyle = (s: unknown): s is StyleName => typeof s === 'string' && Object.hasOwn(FIELDS, s)
const isText = (v: unknown): v is string => typeof v === 'string' && v !== '' && !/[\r\n]/.test(v)
const validKey = (key: string) => key !== '' && key !== '.' && !/[\\/]/.test(key)

function compileSkip(key: string, raw: unknown): readonly RegExp[] | Problem {
  if (raw === undefined) return []
  if (!Array.isArray(raw) || raw.some(p => typeof p !== 'string')) return { key, reason: 'skip must be an array of strings' }
  if (raw.length > 3) return { key, reason: 'skip allows at most 3 patterns' }
  const out: RegExp[] = []
  for (const src of raw as string[]) {
    try {
      out.push(new RegExp(src))
    } catch {
      return { key, reason: `skip pattern ${JSON.stringify(src)} is not a valid regular expression` }
    }
  }
  return out
}

const isProblem = (x: unknown): x is Problem => typeof x === 'object' && x !== null && 'reason' in x

export function compileEntry(key: string, raw: unknown): Rule | Problem {
  if (!validKey(key)) return { key, reason: 'key must be a file name or .extension' }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { key, reason: 'entry must be an object or false' }
  const e = raw as Record<string, unknown>
  if (!isStyle(e.style)) return { key, reason: `unknown style ${JSON.stringify(e.style)}` }
  const extra = Object.keys(e).find(f => !FIELDS[e.style as StyleName].includes(f))
  if (extra !== undefined) return { key, reason: `unknown field ${JSON.stringify(extra)}` }

  const text = (field: string, required: boolean): string | Problem | undefined => {
    const v = e[field]
    if (v === undefined) return required ? { key, reason: `missing ${field}` } : undefined
    return isText(v) ? v : { key, reason: `${field} must be a non-empty single-line string` }
  }

  switch (e.style) {
    case 'markdown':
      return { style: 'markdown' }
    case 'json-property': {
      const k = text('key', false)
      return isProblem(k) ? k : { style: 'json-property', key: k ?? '_comment' }
    }
    case 'line': {
      const prefix = text('prefix', true)
      if (isProblem(prefix)) return prefix
      const skip = compileSkip(key, e.skip)
      return isProblem(skip) ? skip : { style: 'line', prefix: prefix!, skip }
    }
    case 'block': {
      const prefix = text('prefix', true)
      if (isProblem(prefix)) return prefix
      const suffix = text('suffix', true)
      if (isProblem(suffix)) return suffix
      const skip = compileSkip(key, e.skip)
      return isProblem(skip) ? skip : { style: 'block', prefix: prefix!, suffix: suffix!, skip }
    }
  }
}

export function parseEntries(json: string): { entries: Record<string, Entry | false>; problems: Problem[] } {
  if (json.trim() === '') return { entries: {}, problems: [] }
  let raw: unknown
  try {
    raw = JSON.parse(json)
  } catch {
    return { entries: {}, problems: [{ key: '', reason: 'option is not valid JSON' }] }
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { entries: {}, problems: [{ key: '', reason: 'option is not a JSON object' }] }
  const entries: Record<string, Entry | false> = {}
  const problems: Problem[] = []
  for (const [key, value] of Object.entries(raw)) {
    if (value === false) {
      if (validKey(key)) entries[key] = false
      else problems.push({ key, reason: 'key must be a file name or .extension' })
      continue
    }
    const rule = compileEntry(key, value)
    if (isProblem(rule)) problems.push(rule)
    else entries[key] = value as Entry
  }
  return { entries, problems }
}

export function buildTable(json: string): { table: Table; problems: Problem[] } {
  const table = new Map<string, Rule>()
  for (const [key, entry] of Object.entries(BUILTIN_ENTRIES)) table.set(key, compileEntry(key, entry) as Rule)
  const { entries, problems } = parseEntries(json)
  for (const [key, entry] of Object.entries(entries)) {
    if (entry === false) table.delete(key)
    else table.set(key, compileEntry(key, entry) as Rule)
  }
  return { table, problems }
}

const lowerExtensions = new WeakMap<Table, ReadonlyMap<string, Rule>>()

// File-name keys match exactly; extensions match regardless of case, so
// `A.CS` is a `.cs` file. An exact-case extension key wins.
export function resolve(table: Table, path: string): Rule | undefined {
  const named = table.get(basename(path))
  if (named !== undefined) return named
  const ext = extension(path)
  const exact = table.get(ext)
  if (exact !== undefined || ext === '') return exact
  let low = lowerExtensions.get(table)
  if (low === undefined) {
    low = new Map([...table].filter(([k]) => k.startsWith('.')).map(([k, v]) => [k.toLowerCase(), v]))
    lowerExtensions.set(table, low)
  }
  return low.get(ext.toLowerCase())
}

const canonical = (e: Entry | false): string => JSON.stringify(e === false ? false : Object.fromEntries(Object.entries(e).sort(([a], [b]) => a.localeCompare(b))))

export function diffAgainstBuiltins(effective: Record<string, Entry | false>): Record<string, Entry | false> {
  const out: Record<string, Entry | false> = {}
  for (const [key, entry] of Object.entries(effective)) {
    const builtin = BUILTIN_ENTRIES[key]
    if (builtin !== undefined && canonical(builtin) === canonical(entry)) continue
    if (builtin === undefined && entry === false) continue
    out[key] = entry
  }
  return out
}

export const BUILTIN_TABLE: Table = buildTable('').table
