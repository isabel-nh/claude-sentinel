import { locate } from '../hooks/styles.ts'
import { BUILTIN_TABLE, resolve } from '../hooks/types.ts'

// The built-in sentinel line for a path, as an empty file would get it.
export function sentinelFor(path: string): string | undefined {
  const rule = resolve(BUILTIN_TABLE, path)
  const got = rule === undefined ? undefined : locate(rule, [], true)
  return got !== undefined && 'line' in got ? got.line : undefined
}
