import { expect, test } from 'claude-code/testing'
import { sentinelFor } from '../hooks/rules.ts'
import { fakeEngine, type FakeEngine } from './fake-engine.ts'

const S = sentinelFor('a.cs')!
const DENY = 'Sentinel lines are removed only by the user, manually, after review.'

// The bottom tool.call hook stands for the tool itself.
function tools(on: any, engine: FakeEngine, ran: string[]) {
  on('tool.call', (_: unknown, e: any) => {
    ran.push(e.tool)
    if (e.tool === 'Write') engine.put(e.file_path, e.content)
    if (e.tool === 'Edit' || e.tool === 'MultiEdit') {
      const before = engine.text(e.file_path) ?? ''
      let text = before
      for (const x of Array.isArray(e.edits) ? e.edits : [e]) text = x.replace_all ? text.split(x.old_string).join(x.new_string) : text.replace(x.old_string, x.new_string)
      if (text !== before) engine.put(e.file_path, text)
    }
    return { result: {} }
  })
}

test('Write of a new .cs gets the sentinel in content', async ($, on) => {
  const engine = fakeEngine(on)
  const ran: string[] = []
  tools(on, engine, ran)
  const r = await $.tool.call({ tool: 'Write', file_path: 'C:/r/a.cs', content: 'class A {}\n' })
  expect(r.deny).toBeUndefined()
  expect(engine.text('C:/r/a.cs')).toBe(`${S}\nclass A {}\n`)
})

test('Write dropping an on-disk sentinel is re-inserted, and the model is told', async ($, on) => {
  const engine = fakeEngine(on, { files: { 'C:/r/a.cs': `${S}\nold\n` } })
  tools(on, engine, [])
  const r = await $.tool.call({ tool: 'Write', file_path: 'C:/r/a.cs', content: 'new\n' })
  expect(engine.text('C:/r/a.cs')).toBe(`${S}\nnew\n`)
  expect(r.context).toEqual(['Sentinel line kept on line 1 of C:/r/a.cs; only the user removes it.'])
})

test('Write of a new file carries no context', async ($, on) => {
  const engine = fakeEngine(on)
  tools(on, engine, [])
  const r = await $.tool.call({ tool: 'Write', file_path: 'C:/r/a.cs', content: 'new\n' })
  expect(r.context ?? []).toEqual([])
})

test('Write of a shebang script keeps the sentinel on line 2', async ($, on) => {
  const engine = fakeEngine(on, { files: { 'C:/r/x.sh': `#!/bin/bash\n${sentinelFor('x.sh')}\necho\n` } })
  tools(on, engine, [])
  const r = await $.tool.call({ tool: 'Write', file_path: 'C:/r/x.sh', content: '#!/bin/bash\necho hi\n' })
  expect(engine.text('C:/r/x.sh')).toBe(`#!/bin/bash\n${sentinelFor('x.sh')}\necho hi\n`)
  expect(r.context).toEqual(['Sentinel line kept on line 2 of C:/r/x.sh; only the user removes it.'])
})

test('Write of .json untouched', async ($, on) => {
  const engine = fakeEngine(on)
  tools(on, engine, [])
  await $.tool.call({ tool: 'Write', file_path: 'C:/r/a.json', content: '{}\n' })
  expect(engine.text('C:/r/a.json')).toBe('{}\n')
})

test('Write with empty content gets sentinel plus newline', async ($, on) => {
  const engine = fakeEngine(on)
  tools(on, engine, [])
  await $.tool.call({ tool: 'Write', file_path: 'C:/r/a.cs', content: '' })
  expect(engine.text('C:/r/a.cs')).toBe(`${S}\n`)
})

test('Edit removing the sentinel is denied and the tool never runs', async ($, on) => {
  const engine = fakeEngine(on, { files: { 'C:/r/a.cs': `${S}\nx\n` } })
  const ran: string[] = []
  tools(on, engine, ran)
  const r = await $.tool.call({ tool: 'Edit', file_path: 'C:/r/a.cs', old_string: `${S}\nx`, new_string: 'x' })
  expect(r.deny).toBe(DENY)
  expect(ran).toEqual([])
})

test('Edit with replace_all keeping the marker is allowed', async ($, on) => {
  const engine = fakeEngine(on, { files: { 'C:/r/a.cs': `${S}\nfoo foo\n` } })
  const ran: string[] = []
  tools(on, engine, ran)
  await $.tool.call({ tool: 'Edit', file_path: 'C:/r/a.cs', old_string: 'foo', new_string: 'bar', replace_all: true })
  expect(ran).toEqual(['Edit'])
  expect(engine.text('C:/r/a.cs')).toBe(`${S}\nbar bar\n`)
})

test('Edit adding a second marker copy is allowed', async ($, on) => {
  const engine = fakeEngine(on, { files: { 'C:/r/a.cs': `${S}\nx\n` } })
  const ran: string[] = []
  tools(on, engine, ran)
  await $.tool.call({ tool: 'Edit', file_path: 'C:/r/a.cs', old_string: 'x', new_string: `x // ${S}` })
  expect(ran).toEqual(['Edit'])
})

test('MultiEdit: one item removing the marker is denied; none removing it is allowed', async ($, on) => {
  const engine = fakeEngine(on, { files: { 'C:/r/a.cs': `${S}\na\nb\n` } })
  const ran: string[] = []
  tools(on, engine, ran)
  const denied = await $.tool.call({
    tool: 'MultiEdit',
    file_path: 'C:/r/a.cs',
    edits: [{ old_string: 'a', new_string: 'A' }, { old_string: `${S}\n`, new_string: '' }],
  } as any)
  expect(denied.deny).toBe(DENY)
  expect(ran).toEqual([])
  await $.tool.call({ tool: 'MultiEdit', file_path: 'C:/r/a.cs', edits: [{ old_string: 'a', new_string: 'A' }, { old_string: 'b', new_string: 'B' }] } as any)
  expect(ran).toEqual(['MultiEdit'])
})

test('Edit on a sentinel-free file inserts after the tool ran', async ($, on) => {
  const engine = fakeEngine(on, { files: { 'C:/r/a.cs': 'x\n' } })
  tools(on, engine, [])
  await $.tool.call({ tool: 'Edit', file_path: 'C:/r/a.cs', old_string: 'x', new_string: 'y' })
  expect(engine.text('C:/r/a.cs')).toBe(`${S}\ny\n`)
})

test('Edit on a non-allowlisted file is never guarded', async ($, on) => {
  const engine = fakeEngine(on, { files: { 'C:/r/n.md': `${S}\n` } })
  const ran: string[] = []
  tools(on, engine, ran)
  await $.tool.call({ tool: 'Edit', file_path: 'C:/r/n.md', old_string: `${S}\n`, new_string: '' })
  expect(ran).toEqual(['Edit'])
})

test('a failed insertion is reported once by toast', async ($, on) => {
  // UTF-16LE needs a byte write, and with every process failing there is no Git Bash.
  const engine = fakeEngine(on, { files: { 'C:/r/a.cs': new Uint8Array([0xff, 0xfe, 0x78, 0x00]) }, failRun: true })
  tools(on, engine, [])
  await $.tool.call({ tool: 'Edit', file_path: 'C:/r/a.cs', old_string: 'q', new_string: 'r' })
  expect(engine.toasts.length).toBe(1)
  expect(engine.toasts[0]).toContain('C:/r/a.cs')
})

test('handler crash before next still runs the tool (fail-open)', async ($, on) => {
  const engine = fakeEngine(on)
  const ran: string[] = []
  tools(on, engine, ran)
  // A malformed edits field makes the guard throw before it calls next.
  const r = await $.tool.call({ tool: 'MultiEdit', file_path: 'C:/r/a.cs', edits: 5 } as any)
  expect(r.deny).toBeUndefined()
  expect(ran).toEqual(['MultiEdit'])
})
