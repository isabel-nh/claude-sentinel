import type { Register } from 'claude-code'
import { onBash } from './bash.ts'
import type { Ctx } from './ctx.ts'
import { compileWrapper, normalizeDrive } from './command.ts'
import { onEdit, onWrite } from './edit-write.ts'
import { GATE_TOOL, gateStatus } from './gate-tool.ts'
import { cachedHost, type HostIO } from './host.ts'
import { sessionNotifier } from './notify.ts'
import { PANE, registerPane } from './pane.tsx'
import { runSelftest } from './selftest.ts'
import { buildTable, type Problem } from './types.ts'

const GATE = `mcp__sentinel__${GATE_TOOL.name}`
const HANDLED = new Set(['Write', 'Edit', 'MultiEdit', 'Bash', GATE])

// One tool.call hook for every tool this mod watches: the loader forbids
// passing `$` as a value, so the engine seam is built here, once, rather than
// in a copy per matcher. Fail-open: a crash before next runs the tool, a crash
// after replays what the tool settled to. A crash never denies.
export const register: Register = (on, options) => {
  const wrapper = compileWrapper(options.commitWrapper)
  const { table, problems } = buildTable(typeof options.fileTypes === 'string' ? options.fileTypes : '')

  on('session.start', async ($, e, next) => {
    await Promise.allSettled([
      $.tool.register(GATE_TOOL),
      $.command.register({ name: 'sentinel-selftest', description: 'Check sentinel insertion and the commit scan against a scratch repo.' }),
      $.command.register({ name: PANE, description: 'Edit the sentinel file types.' }),
    ])
    return next(e)
  }).catch(($, e, next) => next(e))

  // A second copy of the engine seam: `$` cannot be handed to a shared builder.
  on('command.run', { command: 'sentinel-selftest' }, async $ => {
    const io: HostIO = {
      run: (argv, init) => $.process.run(argv, init),
      exists: path => $.fs.exists(path),
      stat: path => $.fs.stat(path),
      readBase64: async path => (await $.fs.read(path, { as: 'bytes' })).base64,
      writeText: (path, text) => $.fs.write(path, text),
      now: () => $.clock.now(),
    }
    return { text: (await runSelftest(await cachedHost(io))).join('\n') }
  }).catch(() => ({ text: 'FAIL selftest: crashed' }))

  registerPane(on)

  on('tool.call', async ($, e, next) => {
    if (!HANDLED.has(e.tool)) return next(e)
    const io: HostIO = {
      run: (argv, init) => $.process.run(argv, init),
      exists: path => $.fs.exists(path),
      stat: path => $.fs.stat(path),
      readBase64: async path => (await $.fs.read(path, { as: 'bytes' })).base64,
      writeText: (path, text) => $.fs.write(path, text),
      now: () => $.clock.now(),
    }
    const ctx: Ctx = {
      host: () => cachedHost(io),
      cwd: () => $.session.cwd(),
      wrapper,
      table,
      notify: sessionNotifier(text =>
        Promise.allSettled([$.ui.toast(text), $.session.append({ message: { type: 'system', content: [{ type: 'text', text }] } })]),
      ),
    }
    if (problems.length > 0) await ctx.notify('config:fileTypes', fileTypesNotice(problems))
    const loose = e as typeof e & { file_path: string; content: string; command: string; repo: string }
    if (e.tool === GATE) return { result: await gateStatus(await ctx.host(), normalizeDrive(loose.repo), table) }
    if (e.tool === 'Bash') return onBash(ctx, loose, next)
    return e.tool === 'Write' ? onWrite(ctx, loose, next) : onEdit(ctx, loose, next)
  }).catch(($, e, next) => next(e))
}

function fileTypesNotice(problems: readonly Problem[]): string {
  return `sentinel: fileTypes entries ignored: ${problems.map(p => (p.key ? `${p.key}: ` : '') + p.reason).join('; ')}.`
}
