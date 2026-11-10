import type { RunResult } from '../hooks/host.ts'

// Stands for the engine beneath the plugin in a kit test: the engine raises
// fs.* with backslash paths, so every path is normalized to forward slashes.
export type EngineInit = {
  files?: Record<string, Uint8Array | string>
  git?: (args: readonly string[], cwd: string) => RunResult
  blobs?: Record<string, Uint8Array>
  mtimes?: Record<string, number>
  now?: () => number
  cwd?: string
  home?: string
  // Every process.run fails (no git, no Git Bash).
  failRun?: boolean
  // Engine calls that throw, standing for a crash inside the handler.
  throwOn?: readonly string[]
  // The process environment `$.env` reaches. Absent: every `$.env.set` is refused.
  env?: Record<string, string>
}

export type FakeEngine = {
  files: Map<string, Uint8Array>
  writes: string[]
  toasts: string[]
  gitCalls: { args: string[]; cwd: string }[]
  text(path: string): string | undefined
  put(path: string, text: string): void
}

// Loose `on`: the test's own hook registrar, typed only as far as used here.
type On = (event: string, hook: (_: unknown, e: any) => unknown) => unknown

export const GIT_BASH = 'C:/Program Files/Git/usr/bin/bash.exe'
const EXEC_PATH = 'C:/Program Files/Git/mingw64/libexec/git-core\n'
const enc = new TextEncoder()
const dec = new TextDecoder()
const norm = (p: string) => p.replace(/\\/g, '/')
const ok = (stdout: string): RunResult => ({ exitCode: 0, stdout, stderr: '' })

export function fakeEngine(on: On, init: EngineInit = {}): FakeEngine {
  const files = new Map<string, Uint8Array>()
  for (const [k, v] of Object.entries(init.files ?? {})) files.set(norm(k), typeof v === 'string' ? enc.encode(v) : v)
  const mtimes = new Map<string, number>(Object.entries(init.mtimes ?? {}).map(([k, v]) => [norm(k), v]))
  const now = init.now ?? (() => 0)
  const engine: FakeEngine = {
    files,
    writes: [],
    toasts: [],
    gitCalls: [],
    text: path => {
      const b = files.get(norm(path))
      return b === undefined ? undefined : dec.decode(b)
    },
    put: (path, text) => {
      files.set(norm(path), enc.encode(text))
      mtimes.set(norm(path), now())
    },
  }
  const store = (path: string, bytes: Uint8Array) => {
    files.set(norm(path), bytes)
    mtimes.set(norm(path), now())
    engine.writes.push(norm(path))
  }

  const run = (argv: readonly string[], init2: { cwd?: string; stdin?: string } = {}): RunResult => {
    const [cmd, ...rest] = argv
    if (cmd === 'git') {
      if (rest[0] === '--exec-path') return ok(EXEC_PATH)
      const args = rest[0] === '-c' && rest[1] === 'core.quotePath=false' ? rest.slice(2) : rest
      const cwd = norm(init2.cwd ?? init.cwd ?? 'C:/')
      engine.gitCalls.push({ args, cwd })
      return init.git?.(args, cwd) ?? ok('')
    }
    if (norm(cmd ?? '') === GIT_BASH && rest[0] === '-c') {
      const script = rest[1] ?? ''
      if (script.includes('$HOME')) return ok(init.home ?? 'C:/Users/u')
      if (script.startsWith('mkdir -p') || script.startsWith('chmod +x')) return ok('')
      if (script.includes('base64 -d')) {
        store(rest[3]!, Uint8Array.fromBase64(init2.stdin ?? ''))
        return ok('')
      }
      if (script.includes('git -C')) {
        const blob = init.blobs?.[`${norm(rest[3]!)}:${rest[4]}`]
        return blob === undefined ? { exitCode: 128, stdout: '', stderr: 'missing' } : ok(blob.toBase64())
      }
    }
    return { exitCode: 127, stdout: '', stderr: `fake engine: no ${cmd}` }
  }

  const hook = (event: string, fn: (e: any) => unknown) =>
    on(event, (_, e) => {
      if (init.throwOn?.includes(event)) throw new Error(`fake engine: ${event} threw`)
      return fn(e)
    })
  const failed: RunResult = { exitCode: 1, stdout: '', stderr: 'fake engine: failRun' }
  hook('process.run', e => ({ value: init.failRun ? failed : run(e.argv, e.init) }))
  hook('fs.exists', e => ({ value: files.has(norm(e.path)) || norm(e.path) === GIT_BASH }))
  hook('fs.stat', e => {
    const b = files.get(norm(e.path))
    if (b === undefined) throw new Error(`ENOENT: ${e.path}`)
    return { value: { size: b.length, mtimeMs: mtimes.get(norm(e.path)) ?? 0, isFile: true, isDirectory: false } }
  })
  hook('fs.read', e => {
    const b = files.get(norm(e.path))
    if (b === undefined) throw new Error(`ENOENT: ${e.path}`)
    return { value: e.as === 'bytes' ? { base64: b.toBase64() } : dec.decode(b) }
  })
  hook('fs.write', e => {
    store(e.path, enc.encode(e.text))
    return { value: undefined }
  })
  hook('env.get', e => ({ value: init.env?.[e.name] }))
  hook('env.set', e => {
    if (init.env === undefined) return { value: { deny: 'fake engine: no env' } }
    if (e.value === undefined) delete init.env[e.name]
    else init.env[e.name] = e.value
    return { value: {} }
  })
  hook('clock.now', () => ({ value: now() }))
  hook('session.cwd', () => ({ value: init.cwd ?? 'C:/' }))
  hook('ui.toast', e => {
    engine.toasts.push(e.text)
    return { value: undefined }
  })
  return engine
}
