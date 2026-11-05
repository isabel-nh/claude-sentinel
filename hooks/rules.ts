// Assembled, never written whole: this file's own lines 1-2 would otherwise
// read as a sentinel and block every commit that includes it.
export const MARKER = ['TODO:', 'Manual', 'review', 'needed'].join(' ')

const TAIL = `${MARKER}. Please delete this line after review.`

const BY_EXTENSION: Readonly<Record<string, string>> = {
  '.cs': `// ${TAIL}`,
  '.js': `// ${TAIL}`,
  '.mjs': `// ${TAIL}`,
  '.ts': `// ${TAIL}`,
  '.jsx': `// ${TAIL}`,
  '.tsx': `// ${TAIL}`,
  '.yaml': `# ${TAIL}`,
  '.yml': `# ${TAIL}`,
  '.sql': `-- ${TAIL}`,
  '.py': `# ${TAIL}`,
  '.ps1': `# ${TAIL}`,
  '.sh': `# ${TAIL}`,
}

const BY_BASENAME: Readonly<Record<string, string>> = {
  '.gitignore': `# ${TAIL}`,
  '.gitattributes': `# ${TAIL}`,
}

const SHEBANG_EXTENSIONS = new Set(['.py', '.sh', '.ps1', '.js', '.mjs', '.ts'])

const PRUNED = ['/.git/', '/node_modules/', '/bin/', '/obj/', '/packages/', '/dist/', '/build/', '/target/', '/.vs/', '/.idea/']

export const VCS_VERBS: readonly string[] = [
  'pull', 'fetch', 'merge', 'rebase', 'checkout', 'switch', 'restore', 'stash',
  'reset', 'cherry-pick', 'revert', 'apply', 'am', 'clone', 'commit',
]

export const PEEK_CHARS = 512

export function basename(path: string): string {
  const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return path.slice(cut + 1)
}

function extension(path: string): string {
  const name = basename(path)
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot) : ''
}

export function sentinelFor(path: string): string | undefined {
  return BY_BASENAME[basename(path)] ?? BY_EXTENSION[extension(path)]
}

export function isShebangExt(path: string): boolean {
  return SHEBANG_EXTENSIONS.has(extension(path))
}

export function isPruned(relPath: string): boolean {
  const probe = `/${relPath}`
  return PRUNED.some(dir => probe.includes(dir))
}

export function blobCeiling(path: string): number {
  return isShebangExt(path) ? 4 + PEEK_CHARS * 4 * 2 : 4 + PEEK_CHARS * 4
}

export function sentinelLineNo(path: string, isUtf8: boolean, firstLine: string): 1 | 2 {
  if (!isUtf8 || !isShebangExt(path)) return 1
  return firstLine.replace(/\r$/, '').startsWith('#!') ? 2 : 1
}
