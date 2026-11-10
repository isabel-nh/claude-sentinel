import { expect, test } from 'claude-code/testing'
import { envScript, scanScript, typedPatterns, withHooks } from '../hooks/git-hooks.ts'
import { MARKER } from '../hooks/rules.ts'
import { buildTable } from '../hooks/types.ts'

test('typed patterns are case-blind suffixes for extensions and path components for names', () => {
  const { table } = buildTable('{"Makefile":{"style":"line","prefix":"#"},".c+":{"style":"line","prefix":"//"}}')
  const patterns = typedPatterns(table)
  expect(patterns).toContain('*.[cC][sS]')
  expect(patterns).toContain('[mM][aA][kK][eE][fF][iI][lL][eE]')
  expect(patterns).toContain('*/[mM][aA][kK][eE][fF][iI][lL][eE]')
  expect(patterns).toContain('*.[cC]\\+')
})

test('the generated scan never holds the marker whole', () => {
  expect(scanScript(buildTable('').table).includes(MARKER)).toBe(false)
})

test('the env file appends core.hooksPath after any config the caller set', () => {
  const env = envScript('C:/Users/u/.claude/sentinel/git-hooks')
  expect(env).toContain('SENTINEL_GIT_CONFIG_COUNT=${GIT_CONFIG_COUNT:-0}')
  expect(env).toContain('"GIT_CONFIG_KEY_${SENTINEL_GIT_CONFIG_COUNT}=core.hooksPath"')
  expect(env).toContain('GIT_CONFIG_COUNT=$((SENTINEL_GIT_CONFIG_COUNT + 1))')
})

test('withHooks sources the env file on its own line ahead of the command', () => {
  expect(withHooks('git commit -m x', "C:/it's/git-env")).toBe(". 'C:/it'\\''s/git-env'\ngit commit -m x")
})

test('the generated scan also checks the working-tree copy of every staged file', () => {
  const script = scanScript(buildTable('').table)
  expect(script).toContain('head -n 4 -- "$p"')
  expect(script).toContain('done <<< "$staged"')
  expect(script).not.toContain('[ -n "$marked" ] || exit 0')
})
