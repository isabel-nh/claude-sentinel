import type { FileRead, Host, RunResult } from '../hooks/host.ts'

export type FakeHostInit = {
  files?: Record<string, Uint8Array | string>
  git?: (args: readonly string[], cwd: string) => RunResult
  blobs?: Record<string, Uint8Array>
  now?: number
  mtimes?: Record<string, number>
  gitBash?: string | undefined
  home?: string
  dirs?: readonly string[]
  bash?: (script: string, args: readonly string[]) => RunResult
}

export type FakeHost = Host & { written: Map<string, Uint8Array>; gitCalls: { args: readonly string[]; cwd: string }[] }

const enc = new TextEncoder()
const norm = (p: string) => p.replace(/\\/g, '/')

export function fakeHost(init: FakeHostInit = {}): FakeHost {
  const files = new Map<string, Uint8Array>()
  for (const [k, v] of Object.entries(init.files ?? {})) files.set(norm(k), typeof v === 'string' ? enc.encode(v) : v)
  const written = new Map<string, Uint8Array>()
  const gitCalls: { args: readonly string[]; cwd: string }[] = []
  const dirs = new Set((init.dirs ?? []).map(norm))
  const gitBash = 'gitBash' in init ? init.gitBash : 'C:/Program Files/Git/usr/bin/bash.exe'
  const store = (path: string, bytes: Uint8Array) => {
    files.set(norm(path), bytes)
    written.set(norm(path), bytes)
  }
  return {
    gitBash,
    home: init.home ?? 'C:/Users/u',
    written,
    gitCalls,
    async git(args, cwd) {
      gitCalls.push({ args, cwd })
      return init.git?.(args, cwd) ?? { exitCode: 0, stdout: '', stderr: '' }
    },
    async readFile(path): Promise<FileRead> {
      const b = files.get(norm(path))
      if (b === undefined) return { missing: true }
      return b.length > 4 * 1024 * 1024 ? { tooLarge: true } : { bytes: b }
    },
    async writeText(path, text) {
      store(path, enc.encode(text))
      return true
    },
    async writeBytes(path, bytes) {
      if (gitBash === undefined) return false
      store(path, bytes)
      return true
    },
    async readBlob(repo, path) {
      return gitBash === undefined ? undefined : init.blobs?.[`${norm(repo)}:${path}`]
    },
    async bash(script, args) {
      if (gitBash === undefined) return { exitCode: -1, stdout: '', stderr: 'Git Bash not found' }
      return init.bash?.(script, args) ?? { exitCode: 0, stdout: '', stderr: '' }
    },
    exists: async path => files.has(norm(path)) || dirs.has(norm(path)),
    mtimeMs: async path => init.mtimes?.[norm(path)],
    now: async () => init.now ?? 0,
  }
}
