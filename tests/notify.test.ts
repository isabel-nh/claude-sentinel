import { expect, test } from 'claude-code/testing'
import { createNotifier } from '../hooks/notify.ts'

test('a cause is reported once', async () => {
  const seen: string[] = []
  const notify = createNotifier(async text => void seen.push(text))
  await notify('git-bash', 'sentinel: Git Bash not found')
  await notify('git-bash', 'sentinel: Git Bash not found')
  await notify('apply:missing', 'sentinel: C:/a.cs missing')
  expect(seen).toEqual(['sentinel: Git Bash not found', 'sentinel: C:/a.cs missing'])
})

test('a failing sink does not reject', async () => {
  const notify = createNotifier(async () => { throw new Error('no ui') })
  await notify('x', 'y')
  expect(true).toBe(true)
})
