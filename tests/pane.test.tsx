import { expect, test } from 'claude-code/testing'
import { draftProblems, nextOption, preview, rows, summary } from '../hooks/pane.tsx'
import { TAIL } from '../hooks/rules.ts'
import { BUILTIN_ENTRIES, compileEntry, PRESETS, type Rule } from '../hooks/types.ts'

const PANE = {
  plugin: 'sentinel',
  component: 'Pane',
  requestId: 'sentinel-types',
  props: {
    title: 'Sentinel file types',
    isFocused: false,
    bodyColumns: 80,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

// Stands for the engine's /config rows and writer beneath the plugin.
function config(on: any, value: string, answer?: { deny: string }) {
  const sets: unknown[] = []
  on('config.list', () => ({ value: [{ key: 'sentinel.fileTypes', label: 'File types', kind: 'text', value, provider: { plugin: 'sentinel', tier: 'user' }, isLocked: false }] }))
  on('config.set', (_: unknown, e: any) => {
    sets.push(e.value)
    return answer ?? { value: e.value }
  })
  return sets
}

test('rows of an empty option are the 14 built-ins', () => {
  const list = rows('')
  expect(list.length).toBe(14)
  expect(list.every(r => r.source === 'built-in')).toBe(true)
})

test('rows tag a turned-off built-in and a custom type', () => {
  const list = rows('{".sql":false,".md":{"style":"markdown"}}')
  expect(list.find(r => r.key === '.sql')?.source).toBe('off')
  expect(list.find(r => r.key === '.md')?.source).toBe('custom')
})

test('rows carry option problems', () => {
  const list = rows('{".x":{"style":"nope"}}')
  expect(list.find(r => r.key === '.x')?.problem).toBe('unknown style "nope"')
})

test('summary spells each style', () => {
  expect(summary({ style: 'line', prefix: '//', skip: ['^#!'] })).toBe('// · skip ^#!')
  expect(summary({ style: 'block', prefix: '/*', suffix: '*/' })).toBe('/* … */')
  expect(summary({ style: 'json-property' })).toBe('json "_comment"')
  expect(summary({ style: 'markdown' })).toBe('markdown')
})

test('nextOption drops a change equal to the built-in', () => {
  expect(nextOption('', { key: '.cs', entry: BUILTIN_ENTRIES['.cs']! })).toBe('')
})

test('nextOption reset clears an override', () => {
  expect(nextOption('{".sql":false}', { key: '.sql', entry: 'reset' })).toBe('')
})

test('nextOption keeps a custom type', () => {
  expect(nextOption('', { key: '.md', entry: { style: 'markdown' } })).toBe('{".md":{"style":"markdown"}}')
})

test('list view on terminal and desktop', async ($, on) => {
  const sets = config(on, '{".sql":false}')
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: /\.sql.*off/ })).toBeDefined()
    await ui.press({ key: 'on:.sql' })
    await ui.unmount()
  }
  expect(sets).toEqual(['', ''])
})

test('a denied save shows its reason', async ($, on) => {
  config(on, '', { deny: 'locked' })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'off:.cs' })
  expect((await ui.find({ type: 'Text', text: /Not saved/ }))?.text).toBe('Not saved: locked')
  await ui.unmount()
})

test('mobile shows the list without buttons', async ($, on) => {
  config(on, '')
  const ui = await $.ui.mount({ ...PANE, surface: 'mobile' })
  expect(await ui.find({ type: 'Text', text: /\.cs/ })).toBeDefined()
  expect(await ui.find({ type: 'Button' })).toBeUndefined()
  await ui.unmount()
})

test('the command opens the pane', async ($, on) => {
  const opened: unknown[] = []
  on('ui.open', (_: unknown, e: any) => {
    opened.push(e.id)
    return { value: { isPlaced: true } }
  })
  const r = await $.command.run({ command: 'sentinel-types' } as any)
  expect(opened).toEqual(['sentinel-types'])
  expect((r as any).text).toBe('Sentinel file types pane opened.')
})

test('draftProblems names an empty line prefix', () => {
  expect(draftProblems({ key: '.x', style: 'line', prefix: '', suffix: '', jsonKey: '', skip: ['', '', ''] })).toEqual(['missing prefix'])
})

test('preview of an unplaceable json sample says why', () => {
  const rule = compileEntry('.json', PRESETS['.json']) as Rule
  expect(preview(rule, '[1]\n')).toBe('unsupported: top level is not an object')
})

test('edit view previews and saves a changed prefix on terminal and desktop', async ($, on) => {
  const sets = config(on, '')
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    await ui.press({ key: 'edit:.sql' })
    await ui.input({ key: 'prefix', text: '#' })
    const code = await ui.find({ type: 'Code' })
    expect(String(code?.props.source).startsWith(`# ${TAIL}`)).toBe(true)
    await ui.press({ key: 'save' })
    await ui.unmount()
  }
  expect(sets).toEqual(['{".sql":{"style":"line","prefix":"#"}}', '{".sql":{"style":"line","prefix":"#"}}'])
})

test('renaming a key replaces the old entry', async ($, on) => {
  const sets = config(on, '{".md":{"style":"markdown"}}')
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'edit:.md' })
  await ui.input({ key: 'key', text: '.markdown' })
  await ui.press({ key: 'save' })
  expect(sets).toEqual(['{".markdown":{"style":"markdown"}}'])
  await ui.unmount()
})

test('invalid draft blocks save', async ($, on) => {
  config(on, '')
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'add' })
  await ui.input({ key: 'key', text: 'a/b' })
  expect(await ui.find({ type: 'Text', text: /key must be a file name or \.extension/ })).toBeDefined()
  expect(await ui.find({ key: 'save' })).toBeUndefined()
  await ui.unmount()
})

test('add from preset', async ($, on) => {
  const sets = config(on, '')
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'add' })
  await ui.select({ key: 'preset', value: '.jsonc' })
  await ui.press({ key: 'save' })
  const saved = JSON.parse(String(sets[0]))
  expect(saved['.jsonc']).toEqual({ style: 'line', prefix: '//', skip: ['^\\s*[\\[{]\\s*$'] })
  await ui.unmount()
})

test('a sample file that cannot be read falls back to the built-in sample', async ($, on) => {
  config(on, '')
  on('fs.read', () => {
    throw new Error('ENOENT')
  })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'edit:.sql' })
  await ui.input({ key: 'sample', text: 'C:/nope.sql' })
  expect(await ui.find({ type: 'Text', text: /cannot read C:\/nope\.sql/ })).toBeDefined()
  expect(String((await ui.find({ type: 'Code' }))?.props.source).startsWith(`-- ${TAIL}`)).toBe(true)
  await ui.unmount()
})

test('a pane save keeps an invalid entry typed by hand', () => {
  const option = '{".css":{"style":"block","prefix":"/*","sufix":"*/"}}'
  expect(nextOption(option, { key: '.cs', entry: false })).toBe('{".cs":false,".css":{"style":"block","prefix":"/*","sufix":"*/"}}')
})

test('reset on an invalid entry removes it', () => {
  expect(nextOption('{".css":{"style":"block","prefix":"/*","sufix":"*/"}}', { key: '.css', entry: 'reset' })).toBe('')
})

test('a denied save keeps the draft and shows the reason', async ($, on) => {
  config(on, '', { deny: 'locked' })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'edit:.sql' })
  await ui.input({ key: 'prefix', text: '#' })
  await ui.press({ key: 'save' })
  expect((await ui.find({ type: 'Text', text: /Not saved/ }))?.text).toBe('Not saved: locked')
  expect((await ui.find({ key: 'prefix' }))?.props.value).toBe('#')
  await ui.unmount()
})
