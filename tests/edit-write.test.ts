import { expect, test } from 'claude-code/testing'
import { sentinelFor } from './sentinels.ts'
import { fakeEngine, type FakeEngine } from './fake-engine.ts'

const S = sentinelFor('a.cs')!
const GIT = { 'C:/r/.git': '' }
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
  const engine = fakeEngine(on, { files: GIT })
  const ran: string[] = []
  tools(on, engine, ran)
  const r = await $.tool.call({ tool: 'Write', file_path: 'C:/r/a.cs', content: 'class A {}\n' })
  expect(r.deny).toBeUndefined()
  expect(engine.text('C:/r/a.cs')).toBe(`${S}\nclass A {}\n`)
})

test('Write runs with the input as given, so auto mode sees the call it reviewed', async ($, on) => {
  const engine = fakeEngine(on, { files: { ...GIT, 'C:/r/a.cs': `${S}\nold\n` } })
  const seen: string[] = []
  on('tool.call', (_: unknown, e: any) => {
    seen.push(e.content)
    engine.put(e.file_path, e.content)
    return { result: {} }
  })
  await $.tool.call({ tool: 'Write', file_path: 'C:/r/a.cs', content: 'new\n' })
  await $.tool.call({ tool: 'Write', file_path: 'C:/r/b.cs', content: 'class B {}\n' })
  expect(seen).toEqual(['new\n', 'class B {}\n'])
  expect(engine.text('C:/r/a.cs')).toBe(`${S}\nnew\n`)
  expect(engine.text('C:/r/b.cs')).toBe(`${S}\nclass B {}\n`)
})

test('Write dropping an on-disk sentinel is re-inserted, and the model is told', async ($, on) => {
  const engine = fakeEngine(on, { files: { ...GIT, 'C:/r/a.cs': `${S}\nold\n` } })
  tools(on, engine, [])
  const r = await $.tool.call({ tool: 'Write', file_path: 'C:/r/a.cs', content: 'new\n' })
  expect(engine.text('C:/r/a.cs')).toBe(`${S}\nnew\n`)
  expect(r.context).toEqual(['Sentinel line kept on line 1 of C:/r/a.cs; only the user removes it.'])
})

test('Write of a new file carries no context', async ($, on) => {
  const engine = fakeEngine(on, { files: GIT })
  tools(on, engine, [])
  const r = await $.tool.call({ tool: 'Write', file_path: 'C:/r/a.cs', content: 'new\n' })
  expect(r.context ?? []).toEqual([])
})

test('Write of a shebang script keeps the sentinel on line 2', async ($, on) => {
  const engine = fakeEngine(on, { files: { ...GIT, 'C:/r/x.sh': `#!/bin/bash\n${sentinelFor('x.sh')}\necho\n` } })
  tools(on, engine, [])
  const r = await $.tool.call({ tool: 'Write', file_path: 'C:/r/x.sh', content: '#!/bin/bash\necho hi\n' })
  expect(engine.text('C:/r/x.sh')).toBe(`#!/bin/bash\n${sentinelFor('x.sh')}\necho hi\n`)
  expect(r.context).toEqual(['Sentinel line kept on line 2 of C:/r/x.sh; only the user removes it.'])
})

test('Write of .json untouched', async ($, on) => {
  const engine = fakeEngine(on, { files: GIT })
  tools(on, engine, [])
  await $.tool.call({ tool: 'Write', file_path: 'C:/r/a.json', content: '{}\n' })
  expect(engine.text('C:/r/a.json')).toBe('{}\n')
})

test('Write with empty content gets sentinel plus newline', async ($, on) => {
  const engine = fakeEngine(on, { files: GIT })
  tools(on, engine, [])
  await $.tool.call({ tool: 'Write', file_path: 'C:/r/a.cs', content: '' })
  expect(engine.text('C:/r/a.cs')).toBe(`${S}\n`)
})

test('Edit removing the sentinel is denied and the tool never runs', async ($, on) => {
  const engine = fakeEngine(on, { files: { ...GIT, 'C:/r/a.cs': `${S}\nx\n` } })
  const ran: string[] = []
  tools(on, engine, ran)
  const r = await $.tool.call({ tool: 'Edit', file_path: 'C:/r/a.cs', old_string: `${S}\nx`, new_string: 'x' })
  expect(r.deny).toBe(DENY)
  expect(ran).toEqual([])
})

test('Edit with replace_all keeping the marker is allowed', async ($, on) => {
  const engine = fakeEngine(on, { files: { ...GIT, 'C:/r/a.cs': `${S}\nfoo foo\n` } })
  const ran: string[] = []
  tools(on, engine, ran)
  await $.tool.call({ tool: 'Edit', file_path: 'C:/r/a.cs', old_string: 'foo', new_string: 'bar', replace_all: true })
  expect(ran).toEqual(['Edit'])
  expect(engine.text('C:/r/a.cs')).toBe(`${S}\nbar bar\n`)
})

test('Edit adding a second marker copy is allowed', async ($, on) => {
  const engine = fakeEngine(on, { files: { ...GIT, 'C:/r/a.cs': `${S}\nx\n` } })
  const ran: string[] = []
  tools(on, engine, ran)
  await $.tool.call({ tool: 'Edit', file_path: 'C:/r/a.cs', old_string: 'x', new_string: `x // ${S}` })
  expect(ran).toEqual(['Edit'])
})

test('MultiEdit: one item removing the marker is denied; none removing it is allowed', async ($, on) => {
  const engine = fakeEngine(on, { files: { ...GIT, 'C:/r/a.cs': `${S}\na\nb\n` } })
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
  const engine = fakeEngine(on, { files: { ...GIT, 'C:/r/a.cs': 'x\n' } })
  tools(on, engine, [])
  await $.tool.call({ tool: 'Edit', file_path: 'C:/r/a.cs', old_string: 'x', new_string: 'y' })
  expect(engine.text('C:/r/a.cs')).toBe(`${S}\ny\n`)
})

test('Edit on a non-allowlisted file is never guarded', async ($, on) => {
  const engine = fakeEngine(on, { files: { ...GIT, 'C:/r/n.md': `${S}\n` } })
  const ran: string[] = []
  tools(on, engine, ran)
  await $.tool.call({ tool: 'Edit', file_path: 'C:/r/n.md', old_string: `${S}\n`, new_string: '' })
  expect(ran).toEqual(['Edit'])
})

test('a failed insertion is reported once by toast', async ($, on) => {
  // UTF-16LE needs a byte write, and with every process failing there is no Git Bash.
  const engine = fakeEngine(on, { files: { ...GIT, 'C:/r/a.cs': new Uint8Array([0xff, 0xfe, 0x78, 0x00]) }, failRun: true })
  tools(on, engine, [])
  await $.tool.call({ tool: 'Edit', file_path: 'C:/r/a.cs', old_string: 'q', new_string: 'r' })
  expect(engine.toasts.length).toBe(1)
  expect(engine.toasts[0]).toContain('C:/r/a.cs')
})

test('handler crash before next still runs the tool (fail-open)', async ($, on) => {
  const engine = fakeEngine(on, { files: GIT })
  const ran: string[] = []
  tools(on, engine, ran)
  // A malformed edits field makes the guard throw before it calls next.
  const r = await $.tool.call({ tool: 'MultiEdit', file_path: 'C:/r/a.cs', edits: 5 } as any)
  expect(r.deny).toBeUndefined()
  expect(ran).toEqual(['MultiEdit'])
})

const MD_LINE = `# ${['TODO:', 'Manual', 'review', 'needed'].join(' ')}. Please delete this line after review.`

test('a configured .md type gets its sentinel inside frontmatter, and removing it is denied', { options: { fileTypes: '{".md":{"style":"markdown"}}' } }, async ($, on) => {
  const engine = fakeEngine(on, { files: GIT })
  tools(on, engine, [])
  await $.tool.call({ tool: 'Write', file_path: 'C:/r/a.md', content: '---\nname: x\n---\n' })
  expect(engine.text('C:/r/a.md')).toBe(`---\n${MD_LINE}\nname: x\n---\n`)
  const r = await $.tool.call({ tool: 'Edit', file_path: 'C:/r/a.md', old_string: `${MD_LINE}\n`, new_string: '' })
  expect(r.deny).toBe(DENY)
})

test('with no fileTypes a .md Write is untouched', async ($, on) => {
  const engine = fakeEngine(on, { files: GIT })
  tools(on, engine, [])
  await $.tool.call({ tool: 'Write', file_path: 'C:/r/a.md', content: '# T\n' })
  expect(engine.text('C:/r/a.md')).toBe('# T\n')
})

test('a type turned off is written unchanged', { options: { fileTypes: '{".cs":false}' } }, async ($, on) => {
  const engine = fakeEngine(on, { files: GIT })
  tools(on, engine, [])
  await $.tool.call({ tool: 'Write', file_path: 'C:/r/a.cs', content: 'class A {}\n' })
  expect(engine.text('C:/r/a.cs')).toBe('class A {}\n')
})

test('an invalid fileTypes entry is reported once and the built-in rows keep working', { options: { fileTypes: '{".x":{"style":"nope"}}' } }, async ($, on) => {
  const engine = fakeEngine(on, { files: GIT })
  tools(on, engine, [])
  await $.tool.call({ tool: 'Write', file_path: 'C:/r/a.cs', content: 'class A {}\n' })
  await $.tool.call({ tool: 'Write', file_path: 'C:/r/b.cs', content: 'class B {}\n' })
  expect(engine.text('C:/r/a.cs')).toBe(`${S}\nclass A {}\n`)
  const notices = engine.toasts.filter(t => t.includes('fileTypes'))
  expect(notices.length).toBe(1)
  expect(notices[0]).toContain('.x: unknown style "nope"')
})

test('Write outside a git working tree is untouched', async ($, on) => {
  const engine = fakeEngine(on)
  tools(on, engine, [])
  const r = await $.tool.call({ tool: 'Write', file_path: 'C:/tmp/a.cs', content: 'class A {}\n' })
  expect(r.deny).toBeUndefined()
  expect(engine.text('C:/tmp/a.cs')).toBe('class A {}\n')
})

test('Edit outside a git working tree is untouched, and removing a sentinel is still denied', async ($, on) => {
  const engine = fakeEngine(on, { files: { 'C:/tmp/a.cs': 'x\n', 'C:/tmp/b.cs': `${S}\nx\n` } })
  tools(on, engine, [])
  await $.tool.call({ tool: 'Edit', file_path: 'C:/tmp/a.cs', old_string: 'x', new_string: 'y' })
  expect(engine.text('C:/tmp/a.cs')).toBe('y\n')
  const r = await $.tool.call({ tool: 'Edit', file_path: 'C:/tmp/b.cs', old_string: `${S}\n`, new_string: '' })
  expect(r.deny).toBe(DENY)
})

test('Write in a nested directory of a repository walks up to its .git', async ($, on) => {
  const engine = fakeEngine(on, { files: GIT })
  tools(on, engine, [])
  await $.tool.call({ tool: 'Write', file_path: 'C:/r/src/deep/a.cs', content: 'class A {}\n' })
  expect(engine.text('C:/r/src/deep/a.cs')).toBe(`${S}\nclass A {}\n`)
})

test('Write of a file git ignores is untouched; check-ignore runs in the repository with the relative path', async ($, on) => {
  const engine = fakeEngine(on, { files: GIT, ignored: ['gen/gen.cs'] })
  tools(on, engine, [])
  await $.tool.call({ tool: 'Write', file_path: 'C:\\r\\gen\\gen.cs', content: 'class G {}\n' })
  expect(engine.text('C:/r/gen/gen.cs')).toBe('class G {}\n')
  expect(engine.gitCalls).toContainEqual({ args: ['check-ignore', '-q', '--', 'gen/gen.cs'], cwd: 'C:/r' })
})

test('Edit of a file git ignores is untouched, and removing a sentinel is still denied', async ($, on) => {
  const engine = fakeEngine(on, { files: { ...GIT, 'C:/r/gen/a.cs': 'x\n', 'C:/r/gen/b.cs': `${S}\nx\n` }, ignored: ['gen/a.cs', 'gen/b.cs'] })
  tools(on, engine, [])
  await $.tool.call({ tool: 'Edit', file_path: 'C:/r/gen/a.cs', old_string: 'x', new_string: 'y' })
  expect(engine.text('C:/r/gen/a.cs')).toBe('y\n')
  const r = await $.tool.call({ tool: 'Edit', file_path: 'C:/r/gen/b.cs', old_string: `${S}\n`, new_string: '' })
  expect(r.deny).toBe(DENY)
})

test('a failed check-ignore marks the file', async ($, on) => {
  const engine = fakeEngine(on, { files: GIT, ignored: 'fail' })
  tools(on, engine, [])
  await $.tool.call({ tool: 'Write', file_path: 'C:/r/a.cs', content: 'class A {}\n' })
  expect(engine.text('C:/r/a.cs')).toBe(`${S}\nclass A {}\n`)
})

// `git ls-files -o -i` answers `lists` in turn: before the tool runs, then after.
function lsIgnored(...lists: string[][]) {
  let call = 0
  return (args: readonly string[]) => (args[0] === 'ls-files' ? { exitCode: 0, stdout: (lists[call++] ?? []).map(p => `${p}\u0000`).join(''), stderr: '' } : { exitCode: 0, stdout: '', stderr: '' })
}

test('an Edit to .gitignore marks covered files it stops ignoring, and leaves the rest', async ($, on) => {
  const files = { ...GIT, 'C:/r/.gitignore': `${sentinelFor('.gitignore')}\ngen/\nout/\n`, 'C:/r/gen/gen.cs': 'class G {}\n', 'C:/r/out/out.cs': 'class O {}\n', 'C:/r/gen/notes.txt': 'n\n' }
  const engine = fakeEngine(on, { files, git: lsIgnored(['gen/gen.cs', 'out/out.cs', 'gen/notes.txt'], ['out/out.cs']) })
  tools(on, engine, [])
  await $.tool.call({ tool: 'Edit', file_path: 'C:/r/.gitignore', old_string: 'gen/\n', new_string: '' })
  expect(engine.text('C:/r/gen/gen.cs')).toBe(`${S}\nclass G {}\n`)
  expect(engine.text('C:/r/out/out.cs')).toBe('class O {}\n')
  expect(engine.text('C:/r/gen/notes.txt')).toBe('n\n')
})

test('a Write to .git/info/exclude marks covered files it stops ignoring', async ($, on) => {
  const engine = fakeEngine(on, { files: { ...GIT, 'C:/r/.git/info/exclude': 'gen/\n', 'C:/r/gen/gen.cs': 'class G {}\n' }, git: lsIgnored(['gen/gen.cs'], []) })
  tools(on, engine, [])
  await $.tool.call({ tool: 'Write', file_path: 'C:/r/.git/info/exclude', content: '' })
  expect(engine.text('C:/r/gen/gen.cs')).toBe(`${S}\nclass G {}\n`)
})

test('an Edit to an ordinary file never lists ignored files', async ($, on) => {
  const engine = fakeEngine(on, { files: { ...GIT, 'C:/r/a.cs': 'x\n' } })
  tools(on, engine, [])
  await $.tool.call({ tool: 'Edit', file_path: 'C:/r/a.cs', old_string: 'x', new_string: 'y' })
  expect(engine.gitCalls.some(c => c.args[0] === 'ls-files')).toBe(false)
})
