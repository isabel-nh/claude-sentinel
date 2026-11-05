import { applyToFile, insertSentinel } from './apply.ts'
import { changedSince } from './detect.ts'
import { encodeText } from './encoding.ts'
import type { Host } from './host.ts'
import { scanStaged } from './scan.ts'
import { buildTable, PRESETS, resolve } from './types.ts'

// Real-host checks the kit tests cannot make: the kit's fakes stand in for
// Git Bash, git and the file system. cygpath exists only under Git Bash;
// elsewhere the POSIX path is already the one the engine takes.
export const SCRATCH = 'd=$(mktemp -d) && git -C "$d" init -q && git -C "$d" config commit.gpgsign false && { cygpath -m "$d" 2>/dev/null || printf %s "$d"; }'

// The built-in rows plus the markdown and json-property presets, so the real
// byte path covers every style that places below line 1.
export const SELFTEST_TABLE = buildTable(JSON.stringify({ '.md': PRESETS['.md'], '.json': PRESETS['.json'] })).table

export const SELFTEST_FIXTURES: [string, Uint8Array][] = [
  ['a.cs', encodeText('class A {}\n', 'UTF-8')],
  ['b.sql', encodeText('select 1\r\n', 'UTF-8')],
  ['c.sql', new Uint8Array([0xff, 0xfe, ...encodeText('select 2\r\n', 'UTF-16LE')])],
  // Windows-1252 "select 'café'" — 0xE9 alone is not valid UTF-8.
  ['d.sql', new Uint8Array([...encodeText("select 'caf", 'UTF-8'), 0xe9, ...encodeText("'\r\n", 'UTF-8')])],
  ['e.md', encodeText('---\nname: x\n---\nbody\n', 'UTF-8')],
  ['f.json', encodeText('{\n  "a": 1\n}\n', 'UTF-8')],
]

const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i])
const sorted = (xs: readonly string[]) => [...xs].sort().join(',')

export async function runSelftest(host: Host): Promise<string[]> {
  const out: string[] = []
  const pass = (check: string) => out.push(`PASS ${check}`)
  const fail = (check: string, detail: string) => out.push(`FAIL ${check}: ${detail}`)

  if (host.gitBash === undefined) return ['FAIL git-bash: not found']
  pass('git-bash')

  const made = await host.bash(SCRATCH, [])
  const dir = made.stdout.trim()
  if (made.exitCode !== 0 || dir === '') {
    fail('scratch-repo', made.stderr.trim() || `exit ${made.exitCode}`)
    return out
  }

  for (const [name, original] of SELFTEST_FIXTURES) {
    const path = `${dir}/${name}`
    const check = `insert ${name}`
    if (!(await host.writeBytes(path, original))) {
      fail(check, 'fixture write failed')
      continue
    }
    const outcome = await applyToFile(host, path, SELFTEST_TABLE)
    const read = await host.readFile(path)
    const inserted = insertSentinel(original, resolve(SELFTEST_TABLE, path)!)
    const expected = 'bytes' in inserted ? inserted.bytes : original
    if (outcome !== 'inserted') fail(check, `outcome ${JSON.stringify(outcome)}`)
    else if (!('bytes' in read) || !sameBytes(read.bytes, expected)) fail(check, 'bytes differ from the expected insertion')
    else pass(check)
  }

  await host.git(['add', '-A'], dir)
  const all = await scanStaged(host, dir, SELFTEST_TABLE)
  if (sorted(all) === 'a.cs,b.sql,c.sql,d.sql,e.md,f.json') pass('scan finds all six')
  else fail('scan finds all six', `got [${all.join(', ')}]`)

  const [, b] = SELFTEST_FIXTURES[1]!
  const cleared = (await host.writeBytes(`${dir}/b.sql`, b)) && (await host.git(['add', '--', 'b.sql'], dir)).exitCode === 0
  const rest = await scanStaged(host, dir, SELFTEST_TABLE)
  if (cleared && sorted(rest) === 'a.cs,c.sql,d.sql,e.md,f.json') pass('scan after clearing b.sql')
  else fail('scan after clearing b.sql', cleared ? `got [${rest.join(', ')}]` : 'could not rewrite and re-stage b.sql')

  const start = await host.now()
  const wrote = await host.writeText(`${dir}/g.cs`, 'class G {}\n')
  const changed = await changedSince(host, dir, start, SELFTEST_TABLE)
  if (wrote && changed.includes(`${dir}/g.cs`)) pass('changedSince')
  else fail('changedSince', wrote ? `got [${changed.join(', ')}]` : 'could not write g.cs')

  out.push(`scratch repo: ${dir}`)
  return out
}
