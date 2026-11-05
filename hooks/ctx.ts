import { applyToFile } from './apply.ts'
import type { Wrapper } from './command.ts'
import type { Host } from './host.ts'
import type { Notify } from './notify.ts'
import type { Table } from './types.ts'

// What a hook body hands the handlers in place of `$`, which the loader
// forbids passing as a value. `host` is built lazily: only calls that need
// it pay for the Git Bash probe. `wrapper` is the compiled commitWrapper option,
// `table` the file types built from the fileTypes option.
export type Ctx = { host: () => Promise<Host>; notify: Notify; cwd: () => Promise<string>; wrapper?: Wrapper; table: Table }

export async function applyAndReport(ctx: Ctx, host: Host, path: string, hook: string): Promise<void> {
  const outcome = await applyToFile(host, path, ctx.table)
  if (typeof outcome !== 'object') return
  await ctx.notify(`apply:${outcome.failed}`, `sentinel (${hook}): sentinel line not inserted in ${path}: ${outcome.failed}.`)
}
