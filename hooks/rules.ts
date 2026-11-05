// Assembled, never written whole: this file's own first lines would otherwise
// read as a sentinel and block every commit that includes it.
export const MARKER = ['TODO:', 'Manual', 'review', 'needed'].join(' ')

export const TAIL = `${MARKER}. Please delete this line after review.`

const PRUNED = ['/.git/', '/node_modules/', '/bin/', '/obj/', '/packages/', '/dist/', '/build/', '/target/', '/.vs/', '/.idea/']

export const VCS_VERBS: readonly string[] = [
  'pull', 'fetch', 'merge', 'rebase', 'checkout', 'switch', 'restore', 'stash',
  'reset', 'cherry-pick', 'revert', 'apply', 'am', 'clone', 'commit',
]

export const PEEK_CHARS = 512

// A BOM plus four lines (styles.ts MAX_LINES) of at most PEEK_CHARS
// characters, each up to four bytes.
export const BLOB_CEILING = 4 + 4 * PEEK_CHARS * 4

export function basename(path: string): string {
  const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return path.slice(cut + 1)
}

export function extension(path: string): string {
  const name = basename(path)
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot) : ''
}

export function isPruned(relPath: string): boolean {
  const probe = `/${relPath}`
  return PRUNED.some(dir => probe.includes(dir))
}
