export type RunResult = { exitCode: number; stdout: string; stderr: string }
export type FileRead = { bytes: Uint8Array } | { missing: true } | { tooLarge: true }

export type Host = {
  // The POSIX shell for byte-level work: Git Bash on Windows, `bash` on PATH elsewhere.
  gitBash: string | undefined
  home: string | undefined
  git(args: readonly string[], cwd: string): Promise<RunResult>
  readFile(path: string): Promise<FileRead>
  writeText(path: string, text: string): Promise<boolean>
  writeBytes(path: string, bytes: Uint8Array): Promise<boolean>
  readBlob(repo: string, path: string, ceiling: number): Promise<Uint8Array | undefined>
  bash(script: string, args: readonly string[]): Promise<RunResult>
  exists(path: string): Promise<boolean>
  mtimeMs(path: string): Promise<number | undefined>
  now(): Promise<number>
}

// The engine calls host.ts makes, behind one seam so the host logic is testable
// without the engine: a kit test's own `$` has no `process` or `fs` noun. The
// loader forbids passing `$` as a value, so each hook body builds this object
// itself, every member spelled `$.noun.event(...)`.
export type HostIO = {
  run(argv: readonly string[], init?: { cwd?: string; stdin?: string }): Promise<RunResult>
  exists(path: string): Promise<boolean>
  stat(path: string): Promise<{ size: number; mtimeMs: number }>
  readBase64(path: string): Promise<string>
  writeText(path: string, text: string): Promise<void>
  now(): Promise<number>
}

const READ_LIMIT = 4 * 1024 * 1024

const WRITE_SCRIPT = 't="$1.claude-sentinel.$$"; base64 -d > "$t" && [ -s "$t" ] && mv -f "$t" "$1" || { rm -f "$t"; exit 1; }'
// `tr` rather than GNU `base64 -w0`, which BSD/macOS base64 lacks.
const BLOB_SCRIPT = 'git -C "$1" show ":$2" | head -c "$3" | base64 | tr -d "\\r\\n"'
const HOME_SCRIPT = 'printf %s "$HOME"'

export function gitBashFromExecPath(execPath: string): string {
  const parts = execPath.trim().replace(/\\/g, '/').replace(/\/+$/, '').split('/')
  return [...parts.slice(0, -3), 'usr', 'bin', 'bash.exe'].join('/')
}

async function attempt<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn()
  } catch {
    return fallback
  }
}

type Probe = { gitBash: string | undefined; home: string | undefined }

function guarded(io: HostIO) {
  const run = (argv: readonly string[], init?: { cwd?: string; stdin?: string }) =>
    attempt(() => io.run(argv, init), { exitCode: -1, stdout: '', stderr: 'process.run failed' })
  const exists = (path: string) => attempt(() => io.exists(path), false)
  return { run, exists }
}

// A drive-letter exec path means Windows, where `bash` on PATH may be WSL's
// and must never stand in for Git Bash.
async function probe(io: HostIO): Promise<Probe> {
  const { run, exists } = guarded(io)
  const execRun = await run(['git', '--exec-path'])
  const execPath = execRun.exitCode === 0 ? execRun.stdout.trim() : ''
  const windows = /^[A-Za-z]:[\\/]/.test(execPath)
  const candidate = windows ? gitBashFromExecPath(execPath) : 'bash'
  const found = execPath === '' ? undefined : !windows || (await exists(candidate)) ? candidate : undefined
  const homeRun = found === undefined ? undefined : await run([found, '-c', HOME_SCRIPT])
  const home = homeRun?.exitCode === 0 && homeRun.stdout !== '' ? homeRun.stdout : undefined
  // Off Windows nothing was checked on disk: a shell that cannot answer is no shell.
  const gitBash = windows || homeRun?.exitCode === 0 ? found : undefined
  return { gitBash, home }
}

export async function createHost(io: HostIO): Promise<Host> {
  return hostFrom(io, await probe(io))
}

// Git Bash and $HOME are probed once per module lifetime (one session).
let probed: Promise<Probe> | undefined

export async function cachedHost(io: HostIO): Promise<Host> {
  probed ??= probe(io)
  return hostFrom(io, await probed)
}

function hostFrom(io: HostIO, { gitBash, home }: Probe): Host {
  const { run, exists } = guarded(io)
  return {
    gitBash,
    home,
    git: (args, cwd) => run(['git', '-c', 'core.quotePath=false', ...args], { cwd }),
    async readFile(path) {
      if (!(await exists(path))) return { missing: true }
      const stat = await attempt(() => io.stat(path), undefined)
      if (stat === undefined) return { missing: true }
      if (stat.size > READ_LIMIT) return { tooLarge: true }
      const base64 = await attempt(() => io.readBase64(path), undefined)
      return base64 === undefined ? { missing: true } : { bytes: Uint8Array.fromBase64(base64) }
    },
    writeText: (path, text) => attempt(async () => (await io.writeText(path, text), true), false),
    async writeBytes(path, bytes) {
      if (gitBash === undefined) return false
      const r = await run([gitBash, '-c', WRITE_SCRIPT, '_', path], { stdin: bytes.toBase64() })
      return r.exitCode === 0
    },
    async readBlob(repo, path, ceiling) {
      if (gitBash === undefined) return undefined
      const r = await run([gitBash, '-c', BLOB_SCRIPT, '_', repo, path, String(ceiling)])
      if (r.exitCode !== 0) return undefined
      return attempt(async () => Uint8Array.fromBase64(r.stdout.trim()), undefined)
    },
    bash: async (script, args) =>
      gitBash === undefined ? { exitCode: -1, stdout: '', stderr: 'Git Bash not found' } : run([gitBash, '-c', script, '_', ...args]),
    exists,
    mtimeMs: async path => (await attempt(() => io.stat(path), undefined))?.mtimeMs,
    now: () => io.now(),
  }
}
