import { expect, test } from 'claude-code/testing'
import { insertSentinel } from '../hooks/apply.ts'
import { runSelftest, SELFTEST_FIXTURES, SELFTEST_TABLE } from '../hooks/selftest.ts'
import { resolve } from '../hooks/types.ts'
import { fakeEngine } from './fake-engine.ts'
import { fakeHost } from './fake-host.ts'

test('without Git Bash the first line is FAIL git-bash and nothing else is attempted', async () => {
  const host = fakeHost({ gitBash: undefined })
  expect(await runSelftest(host)).toEqual(['FAIL git-bash: not found'])
  expect(host.gitCalls).toEqual([])
})

test('a failed scratch repo stops the run after the git-bash check', async () => {
  const host = fakeHost({ bash: () => ({ exitCode: 1, stdout: '', stderr: 'mktemp: failed' }) })
  expect(await runSelftest(host)).toEqual(['PASS git-bash', 'FAIL scratch-repo: mktemp: failed'])
})

test('/sentinel-selftest is registered at session.start and answers with the check lines', async ($, on) => {
  const commands: string[] = []
  fakeEngine(on, { failRun: true })
  on('session.start', (_: unknown, e: any) => ({ cwd: e.cwd }))
  on('tool.register', (_: unknown, e: any) => ({ value: { tool: `mcp__sentinel__${e.name}` } }))
  on('command.register', (_: unknown, e: any) => {
    commands.push(e.name)
    return { value: { command: e.name } }
  })
  await $.session.start({ cwd: 'C:/r', surface: 'desktop', isInteractive: true })
  expect(commands).toEqual(['sentinel-selftest', 'sentinel-types'])
  const r = await $.command.run({ command: 'sentinel-selftest', args: '' } as any)
  expect(r.text).toBe('FAIL git-bash: not found')
})

test('the selftest covers markdown and json-property fixtures under its own table', () => {
  expect(SELFTEST_FIXTURES.map(([name]) => name)).toEqual(['a.cs', 'b.sql', 'c.sql', 'd.sql', 'e.md', 'f.json'])
  for (const [name, bytes] of SELFTEST_FIXTURES) {
    const rule = resolve(SELFTEST_TABLE, name)
    expect({ name, ruled: rule !== undefined }).toEqual({ name, ruled: true })
    expect({ name, inserted: 'bytes' in insertSentinel(bytes, rule!) }).toEqual({ name, inserted: true })
  }
})
