import { expect, test } from 'claude-code/testing'
import { createHost, gitBashFromExecPath, type HostIO } from '../hooks/host.ts'

const EXEC = 'C:/Program Files/Git/mingw64/libexec/git-core\n'
const BASH = 'C:/Program Files/Git/usr/bin/bash.exe'

type Run = { argv: readonly string[]; init?: { stdin?: string; cwd?: string } }

function fakeIO(opts: { bash?: boolean; exec?: string; missing?: string; stdout?: (r: Run) => string; files?: Record<string, { size: number; base64?: string }> } = {}) {
  const runs: Run[] = []
  const io: HostIO = {
    async run(argv, init) {
      runs.push({ argv, init })
      const out = argv[1] === '--exec-path' ? (opts.exec ?? EXEC) : argv[2]?.includes('$HOME') ? '/c/Users/u' : (opts.stdout?.({ argv, init }) ?? '')
      if (argv[0] === opts.missing) return { exitCode: 127, stdout: '', stderr: 'not found' }
      return { exitCode: 0, stdout: out, stderr: '' }
    },
    exists: async path => (path === BASH ? opts.bash !== false : path in (opts.files ?? {})),
    stat: async path => ({ size: opts.files?.[path]?.size ?? 0, mtimeMs: 5 }),
    readBase64: async path => opts.files?.[path]?.base64 ?? '',
    writeText: async () => {},
    now: async () => 1,
  }
  return { io, runs }
}

test('gitBashFromExecPath walks up from git-core to usr/bin/bash.exe', () => {
  expect(gitBashFromExecPath('C:/Program Files/Git/mingw64/libexec/git-core')).toBe(BASH)
  expect(gitBashFromExecPath('C:\\Program Files\\Git\\mingw64\\libexec\\git-core\\')).toBe(BASH)
})

test('createHost resolves Git Bash and HOME', async () => {
  const host = await createHost(fakeIO().io)
  expect(host.gitBash).toBe(BASH)
  expect(host.home).toBe('/c/Users/u')
})

test('off Windows, bash on PATH stands in for Git Bash', async () => {
  const { io, runs } = fakeIO({ exec: '/usr/lib/git-core\n' })
  const host = await createHost(io)
  expect(host.gitBash).toBe('bash')
  expect(host.home).toBe('/c/Users/u')
  expect(runs.some(r => r.argv[0] === 'bash')).toBe(true)
})

test('off Windows with no bash on PATH, there is no shell', async () => {
  const host = await createHost(fakeIO({ exec: '/usr/lib/git-core\n', missing: 'bash' }).io)
  expect(host.gitBash).toBeUndefined()
  expect(host.home).toBeUndefined()
})

test('on Windows with no Git Bash, bash on PATH (WSL) is never tried', async () => {
  const { io, runs } = fakeIO({ bash: false })
  const host = await createHost(io)
  expect(host.gitBash).toBeUndefined()
  expect(runs.some(r => r.argv[0] === 'bash')).toBe(false)
})

test('readBlob avoids GNU-only base64 flags', async () => {
  const { io, runs } = fakeIO({ stdout: () => 'YWJj\n' })
  const host = await createHost(io)
  await host.readBlob('C:/r', 'a.cs', 10)
  expect(runs.at(-1)!.argv[2]).not.toContain('-w')
})

test('git prefixes core.quotePath=false and passes cwd', async () => {
  const { io, runs } = fakeIO()
  const host = await createHost(io)
  await host.git(['status', '--porcelain'], 'C:/r')
  const last = runs.at(-1)!
  expect(last.argv).toEqual(['git', '-c', 'core.quotePath=false', 'status', '--porcelain'])
  expect(last.init?.cwd).toBe('C:/r')
})

test('writeBytes passes the path as $1 and base64 on stdin', async () => {
  const { io, runs } = fakeIO()
  const host = await createHost(io)
  const path = 'C:/a b/$x`y.cs'
  expect(await host.writeBytes(path, new Uint8Array([97, 98, 99]))).toBe(true)
  const last = runs.at(-1)!
  expect(last.argv[0]).toBe(BASH)
  expect(last.argv[1]).toBe('-c')
  expect(last.argv[2]).toContain('"$1"')
  expect(last.argv.slice(3)).toEqual(['_', path])
  expect(last.init?.stdin).toBe('YWJj')
})

test('readBlob decodes base64 stdout and passes repo, path and ceiling as arguments', async () => {
  const { io, runs } = fakeIO({ stdout: () => 'YWJj\n' })
  const host = await createHost(io)
  expect([...(await host.readBlob('C:/r', 'a b.sql', 2052))!]).toEqual([97, 98, 99])
  expect(runs.at(-1)!.argv.slice(3)).toEqual(['_', 'C:/r', 'a b.sql', '2052'])
})

test('without Git Bash, writeBytes and readBlob fail without running a process', async () => {
  const { io, runs } = fakeIO({ bash: false })
  const host = await createHost(io)
  const before = runs.length
  expect(host.gitBash).toBeUndefined()
  expect(await host.writeBytes('C:/a.cs', new Uint8Array([1]))).toBe(false)
  expect(await host.readBlob('C:/r', 'a.cs', 2052)).toBeUndefined()
  expect(runs.length).toBe(before)
})

test('readFile reports missing, too large, and bytes', async () => {
  const { io } = fakeIO({ files: { 'C:/big.cs': { size: 4 * 1024 * 1024 + 1 }, 'C:/a.cs': { size: 3, base64: 'YWJj' } } })
  const host = await createHost(io)
  expect(await host.readFile('C:/none.cs')).toEqual({ missing: true })
  expect(await host.readFile('C:/big.cs')).toEqual({ tooLarge: true })
  const read = await host.readFile('C:/a.cs')
  expect('bytes' in read && [...read.bytes]).toEqual([97, 98, 99])
})

test('a throwing process.run becomes a failed RunResult, not a rejection', async () => {
  const { io } = fakeIO()
  const host = await createHost({ ...io, run: async argv => { if (argv[0] === 'git' && argv[1] !== '--exec-path') throw new Error('boom'); return io.run(argv) } })
  expect((await host.git(['status'], 'C:/r')).exitCode).toBe(-1)
})
