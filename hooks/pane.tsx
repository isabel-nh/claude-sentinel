import { atom, read, update } from 'claude-code'
import type { On } from 'claude-code'
import type { DraftEntry, PaneView } from '../types/pane-state'
import { insertSentinel } from './apply.ts'
import { decodeUtf8, encodeText } from './encoding.ts'
import { BUILTIN_ENTRIES, compileEntry, diffAgainstBuiltins, parseEntries, PRESETS, type Entry, type Problem, type Rule, type StyleName } from './types.ts'

export const PANE = 'sentinel-types'
const OPTION = 'sentinel.fileTypes'
const SAMPLE_CHARS = 4096
const PREVIEW_LINES = 6
// Cells per list button column: the widest label drawn as `[ label ]`.
const SLOT = { edit: 8, toggle: 7, reset: 9 } as const

export type TypeRow = {
  key: string
  entry: Entry | false
  source: 'built-in' | 'custom' | 'overrides built-in' | 'off'
  problem?: string
}

type Change = { key: string; entry: Entry | false | 'reset' }

// Change the tag when PaneView changes: it declines what an earlier version
// stored, which outlives a reload.
const view = atom({ plugin: 'sentinel', key: 'view' } as const, { mode: 'list' } as PaneView, { shape: 'view-1' })

const same = (a: Entry | false, b: Entry | false) => JSON.stringify(a) === JSON.stringify(b)
const isProblem = (x: Rule | Problem): x is Problem => 'reason' in x

export const SAMPLES: Record<StyleName, string> = {
  line: '#!/usr/bin/env sh\necho hi\n',
  block: '#!/usr/bin/env sh\necho hi\n',
  'json-property': '{\n  "name": "x"\n}\n',
  markdown: '---\nname: x\n---\nbody\n',
}

const STYLES: readonly StyleName[] = ['line', 'block', 'json-property', 'markdown']

export function rows(optionJson: string): TypeRow[] {
  const { entries, problems } = parseEntries(optionJson)
  const out: TypeRow[] = Object.entries({ ...BUILTIN_ENTRIES, ...entries }).map(([key, entry]) => {
    const builtin = BUILTIN_ENTRIES[key]
    const source = entry === false ? 'off' : builtin === undefined ? 'custom' : same(builtin, entry) ? 'built-in' : 'overrides built-in'
    return { key, entry, source }
  })
  for (const p of problems) out.push({ key: p.key || '(option)', entry: false, source: 'custom', problem: p.reason })
  return out.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
}

export function summary(entry: Entry): string {
  switch (entry.style) {
    case 'line':
      return entry.skip?.length ? `${entry.prefix} · skip ${entry.skip.join(' ')}` : entry.prefix
    case 'block':
      return `${entry.prefix} … ${entry.suffix}`
    case 'json-property':
      return `json "${entry.key ?? '_comment'}"`
    case 'markdown':
      return 'markdown'
  }
}

// Entries parseEntries dropped as invalid, as the person typed them: a pane
// save carries them through untouched so a typo is fixed, not erased.
function invalidEntries(optionJson: string): Record<string, unknown> {
  const { problems } = parseEntries(optionJson)
  if (problems.every(p => p.key === '')) return {}
  const raw = JSON.parse(optionJson) as Record<string, unknown>
  return Object.fromEntries(problems.filter(p => p.key !== '').map(p => [p.key, raw[p.key]]))
}

export function nextOption(optionJson: string, change: Change): string {
  const next: Record<string, Entry | false> = { ...BUILTIN_ENTRIES, ...parseEntries(optionJson).entries }
  if (change.entry !== 'reset') next[change.key] = change.entry
  else if (BUILTIN_ENTRIES[change.key] !== undefined) next[change.key] = BUILTIN_ENTRIES[change.key]!
  else delete next[change.key]
  const kept = invalidEntries(optionJson)
  delete kept[change.key]
  const out = { ...diffAgainstBuiltins(next), ...kept }
  return Object.keys(out).length === 0 ? '' : JSON.stringify(out)
}

export const EMPTY_DRAFT: DraftEntry = { key: '', style: 'line', prefix: '#', suffix: '', jsonKey: '', skip: ['', '', ''] }

export function entryToDraft(key: string, entry: Entry): DraftEntry {
  const skip = 'skip' in entry ? (entry.skip ?? []) : []
  return {
    key,
    style: entry.style,
    prefix: 'prefix' in entry ? entry.prefix : '',
    suffix: entry.style === 'block' ? entry.suffix : '',
    jsonKey: entry.style === 'json-property' ? (entry.key ?? '') : '',
    skip: [skip[0] ?? '', skip[1] ?? '', skip[2] ?? ''],
  }
}

// Empty fields are left out, so compileEntry reports a missing one by name.
export function draftToEntry(d: DraftEntry): Entry {
  const skip = d.skip.filter(s => s !== '')
  const withSkip = skip.length > 0 ? { skip } : {}
  const prefix = d.prefix !== '' ? { prefix: d.prefix } : {}
  switch (d.style) {
    case 'line':
      return { style: 'line', ...prefix, ...withSkip } as Entry
    case 'block':
      return { style: 'block', ...prefix, ...(d.suffix !== '' ? { suffix: d.suffix } : {}), ...withSkip } as Entry
    case 'json-property':
      return d.jsonKey !== '' ? { style: 'json-property', key: d.jsonKey } : { style: 'json-property' }
    case 'markdown':
      return { style: 'markdown' }
  }
}

export function draftProblems(d: DraftEntry): string[] {
  const out: string[] = []
  const keyed = compileEntry(d.key, { style: 'markdown' })
  if (isProblem(keyed)) out.push(keyed.reason)
  const rule = compileEntry('.x', draftToEntry(d))
  if (isProblem(rule)) out.push(rule.reason)
  return out
}

export function preview(rule: Rule, sample: string): string {
  const out = insertSentinel(encodeText(sample, 'UTF-8'), rule)
  if ('unsupported' in out) return `unsupported: ${out.unsupported}`
  const text = 'bytes' in out ? decodeUtf8(out.bytes, 0) : sample
  return text.split('\n').slice(0, PREVIEW_LINES).join('\n')
}

export function registerPane(on: On): void {
  on('command.run', { command: PANE }, async $ => {
    await $.ui.open({ id: PANE, title: 'Sentinel file types' })
    return { text: 'Sentinel file types pane opened.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const table = $.ui.resolve(e)
    const { Box, Text, Button } = table
    const row = (await $.config.list()).find(r => r.key === OPTION)
    const option = typeof row?.value === 'string' ? row.value : ''
    const state = await read($, view)
    const buttons = e.surface !== 'mobile'

    // The list view is written before config.set: a written option reloads the
    // mod, which may end this handler. A deny puts back the view it came from.
    const save = async (value: string) => {
      const from = state
      await update($, view, (): PaneView => ({ mode: 'list' }))
      const r = await $.config.set({ key: OPTION, value })
      if (r.deny !== undefined) await update($, view, (): PaneView => ({ ...from, error: `Not saved: ${r.deny}` }))
    }
    const edit = (originalKey: string | undefined, draft: DraftEntry) =>
      update($, view, (): PaneView => ({ mode: 'edit', originalKey, draft, samplePath: '' }))

    // Mobile draws no Input or Select: it stays on the list.
    if (state.mode === 'edit' && 'Input' in table && 'Select' in table) {
      const { Input, Select, Code } = table
      const d = state.draft
      const problems = draftProblems(d)
      const setDraft = (patch: Partial<DraftEntry>) =>
        update($, view, (v): PaneView => (v.mode === 'edit' ? { ...v, draft: { ...v.draft, ...patch } } : v))
      const setSkip = (i: number, s: string) => setDraft({ skip: d.skip.map((x, j) => (j === i ? s : x)) as DraftEntry['skip'] })
      const setSample = (samplePath: string) => update($, view, (v): PaneView => (v.mode === 'edit' ? { ...v, samplePath } : v))

      let sample = SAMPLES[d.style]
      let sampleNote: string | undefined
      if (state.samplePath !== '') {
        try {
          sample = String(await $.fs.read(state.samplePath)).slice(0, SAMPLE_CHARS)
        } catch {
          sampleNote = `cannot read ${state.samplePath}`
        }
      }
      const rule = problems.length === 0 ? compileEntry(d.key, draftToEntry(d)) : undefined
      const shown = rule !== undefined && !isProblem(rule) ? preview(rule, sample) : sample

      const onSave = () => {
        const entry = draftToEntry(d)
        const base = state.originalKey !== undefined && state.originalKey !== d.key ? nextOption(option, { key: state.originalKey, entry: 'reset' }) : option
        return save(nextOption(base, { key: d.key, entry }))
      }
      const field = (key: keyof DraftEntry & string, label: string, value: string) => (
        <Input key={key} label={label} value={value} onInput={v => setDraft({ [key]: v })} onSubmit={v => setDraft({ [key]: v })} />
      )

      return (
        <Box flexDirection="column">
          <Text>{state.originalKey !== undefined ? `Edit ${state.originalKey}` : 'New file type'}</Text>
          {state.error !== undefined && <Text color="red">{state.error}</Text>}
          {state.originalKey === undefined && (
            <Select
              key="preset"
              label="Preset"
              options={Object.keys(PRESETS).map(k => ({ value: k }))}
              onSelect={k => (PRESETS[k] !== undefined ? setDraft(entryToDraft(k, PRESETS[k]!)) : undefined)}
            />
          )}
          {field('key', 'File name or .extension', d.key)}
          <Select key="style" label="Style" value={d.style} options={STYLES.map(s => ({ value: s }))} onSelect={s => setDraft({ style: s as StyleName })} />
          {(d.style === 'line' || d.style === 'block') && field('prefix', 'Prefix', d.prefix)}
          {d.style === 'block' && field('suffix', 'Suffix', d.suffix)}
          {d.style === 'json-property' && field('jsonKey', 'Property name (default _comment)', d.jsonKey)}
          {(d.style === 'line' || d.style === 'block') &&
            d.skip.map((s, i) => (
              <Input key={`skip${i}`} label={`Skip pattern ${i + 1}`} value={s} onInput={v => setSkip(i, v)} onSubmit={v => setSkip(i, v)} />
            ))}
          <Input key="sample" label="Sample file path" value={state.samplePath} onInput={setSample} onSubmit={setSample} />
          {sampleNote !== undefined && <Text dimColor>{sampleNote}</Text>}
          {problems.map(p => (
            <Text color="red">{p}</Text>
          ))}
          <Code key="preview" source={shown} />
          <Box key="actions" flexDirection="row" gap={1} justifyContent="flex-end">
            {problems.length === 0 && (
              <Button key="save" variant="primary" onPress={onSave}>
                Save
              </Button>
            )}
            <Button key="cancel" role="dismiss" onPress={() => update($, view, (): PaneView => ({ mode: 'list' }))}>
              Cancel
            </Button>
          </Box>
        </Box>
      )
    }

    const change = (c: Change) => save(nextOption(option, c))
    return (
      <Box flexDirection="column">
        {state.error !== undefined && <Text color="red">{state.error}</Text>}
        {buttons && (
          <Button key="add" onPress={() => edit(undefined, EMPTY_DRAFT)}>
            Add
          </Button>
        )}
        {rows(option).map(r => {
          const ok = buttons && r.problem === undefined
          const editable = r.entry !== false ? r.entry : BUILTIN_ENTRIES[r.key]
          return (
            <Box flexDirection="row" gap={1}>
              <Box key={`label:${r.key}`} flexGrow={1} flexShrink={1}>
                <Text dimColor={r.entry === false}>
                  {r.problem !== undefined ? '⚠ ' : ''}
                  {r.key} {r.problem ?? (r.entry === false ? 'off' : `${summary(r.entry)} · ${r.source}`)}
                </Text>
              </Box>
              {buttons && (
                <Box flexDirection="row" gap={1} flexShrink={0}>
                  {/* Fixed-width slots, empty when a row lacks that action, keep the columns aligned. */}
                  <Box key={`edit-slot:${r.key}`} width={SLOT.edit} justifyContent="flex-end">
                    {ok && editable !== undefined && (
                      <Button key={`edit:${r.key}`} onPress={() => edit(r.key, entryToDraft(r.key, editable))}>
                        Edit
                      </Button>
                    )}
                  </Box>
                  <Box key={`toggle-slot:${r.key}`} width={SLOT.toggle} justifyContent="flex-end">
                    {ok && r.entry !== false && (
                      <Button key={`off:${r.key}`} onPress={() => change({ key: r.key, entry: false })}>
                        Off
                      </Button>
                    )}
                    {ok && r.entry === false && BUILTIN_ENTRIES[r.key] !== undefined && (
                      <Button key={`on:${r.key}`} onPress={() => change({ key: r.key, entry: 'reset' })}>
                        On
                      </Button>
                    )}
                  </Box>
                  <Box key={`reset-slot:${r.key}`} width={SLOT.reset} justifyContent="flex-end">
                    {ok && (r.source === 'overrides built-in' || r.source === 'custom') && (
                      <Button key={`reset:${r.key}`} onPress={() => change({ key: r.key, entry: 'reset' })}>
                        Reset
                      </Button>
                    )}
                  </Box>
                </Box>
              )}
            </Box>
          )
        })}
      </Box>
    )
  })
}
