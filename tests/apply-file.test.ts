import { expect, test } from 'claude-code/testing'
import { applyToFile } from '../hooks/apply.ts'
import { decodeUtf8, encodeText } from '../hooks/encoding.ts'
import { sentinelFor } from '../hooks/rules.ts'
import { fakeHost } from './fake-host.ts'

const S = sentinelFor('a.cs')!
const SQL = sentinelFor('a.sql')!

test('UTF-8 file is written as text', async () => {
  const host = fakeHost({ files: { 'C:/r/a.cs': 'x\n' } })
  expect(await applyToFile(host, 'C:/r/a.cs')).toBe('inserted')
  expect(decodeUtf8(host.written.get('C:/r/a.cs')!, 0)).toBe(`${S}\nx\n`)
})

test('UTF-16LE file is written as bytes', async () => {
  const body = encodeText('x\r\n', 'UTF-16LE')
  const host = fakeHost({ files: { 'C:/r/a.sql': new Uint8Array([0xff, 0xfe, ...body]) } })
  let viaBytes = false
  const writeBytes = host.writeBytes
  host.writeBytes = async (p, b) => ((viaBytes = true), writeBytes(p, b))
  expect(await applyToFile(host, 'C:/r/a.sql')).toBe('inserted')
  expect(viaBytes).toBe(true)
  expect([...host.written.get('C:/r/a.sql')!]).toEqual([0xff, 0xfe, ...encodeText(`${SQL}\r\n`, 'UTF-16LE'), ...body])
})

test('Windows-1252 file is written as bytes with its high bytes intact', async () => {
  const host = fakeHost({ files: { 'C:/r/a.sql': new Uint8Array([0x63, 0xe9, 0x0a]) } })
  let viaText = false
  host.writeText = async () => ((viaText = true), true)
  expect(await applyToFile(host, 'C:/r/a.sql')).toBe('inserted')
  expect(viaText).toBe(false)
  expect([...host.written.get('C:/r/a.sql')!].slice(-3)).toEqual([0x63, 0xe9, 0x0a])
})

test('present sentinel writes nothing', async () => {
  const host = fakeHost({ files: { 'C:/r/a.cs': `${S}\nx\n` } })
  expect(await applyToFile(host, 'C:/r/a.cs')).toBe('present')
  expect(host.written.size).toBe(0)
})

test('skipped extension is not read', async () => {
  const host = fakeHost({ files: { 'C:/r/a.json': '{}' } })
  expect(await applyToFile(host, 'C:/r/a.json')).toBe('skipped')
})

test('missing and too-large files fail with a reason', async () => {
  expect(await applyToFile(fakeHost(), 'C:/r/none.cs')).toEqual({ failed: 'missing' })
  const big = fakeHost({ files: { 'C:/r/big.cs': new Uint8Array(4 * 1024 * 1024 + 1) } })
  expect(await applyToFile(big, 'C:/r/big.cs')).toEqual({ failed: 'larger than 4 MiB' })
})

test('byte write failure is reported', async () => {
  const host = fakeHost({ files: { 'C:/r/a.sql': new Uint8Array([0x63, 0xe9, 0x0a]) }, gitBash: undefined })
  expect(await applyToFile(host, 'C:/r/a.sql')).toEqual({ failed: 'Git Bash unavailable or write failed' })
})
