// Runs the generated pre-commit scan (git-hooks.ts scanScript) directly
// against throwaway repositories and checks its exact verdict and message.
// No model, no network, no mod handler. Run explicitly: node integration/scan.ts
// `--keep` leaves the repositories in place.
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { gitBashFromExecPath } from '../hooks/host.ts'
import { scanScript } from '../hooks/git-hooks.ts'
import { MARKER, TAIL } from '../hooks/rules.ts'
import { BUILTIN_TABLE } from '../hooks/types.ts'
import { git, seedRepo } from './audit.ts'

const root = mkdtempSync(join(tmpdir(), 'sentinel-scan-')).replace(/\\/g, '/')
const bash = process.platform === 'win32' ? gitBashFromExecPath(git(root, ['--exec-path'])) : 'bash'
const script = `${root}/sentinel-scan`
writeFileSync(script, scanScript(BUILTIN_TABLE))

const PAST = new Date('2001-01-01T00:00:00Z')
const FUTURE = new Date(Date.now() + 3600_000)

class Repo {
  readonly dir: string
  readonly base: string
  readonly lines: string[] = []
  constructor(dir: string) {
    this.dir = dir
    this.base = `${dir}.baseline.tsv`
  }
  get top(): string {
    return git(this.dir, ['rev-parse', '--show-toplevel']).trim().toLowerCase()
  }
  get head(): string {
    return git(this.dir, ['rev-parse', 'HEAD']).trim()
  }
  write(path: string, content: string | Buffer, mtime = PAST): this {
    const full = join(this.dir, path)
    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, content)
    utimesSync(full, mtime, mtime)
    return this
  }
  add(...paths: string[]): this {
    git(this.dir, ['add', '--', ...paths])
    return this
  }
  commit(): this {
    git(this.dir, ['add', '-A'])
    git(this.dir, ['commit', '-q', '-m', 'step'])
    return this
  }
  rm(path: string, cached = false): this {
    git(this.dir, ['rm', '-q', ...(cached ? ['--cached'] : []), '--', path])
    return this
  }
  // A blob stored unfiltered, as the mod stores a reviewed copy.
  blob(content: string | Buffer): string {
    return execFileSync('git', ['hash-object', '-w', '--no-filters', '--stdin'], { cwd: this.dir, input: content, encoding: 'utf8' }).trim()
  }
  // Puts content in the index without touching the working tree.
  stage(path: string, content: string | Buffer): this {
    git(this.dir, ['update-index', '--add', '--cacheinfo', `100644,${this.blob(content)},${path}`])
    return this
  }
  staged(path: string): string {
    return git(this.dir, ['rev-parse', `:${path}`]).trim()
  }
  R(top = this.top, head = this.head): this {
    this.lines.push(`R\t${top}\t${head}`)
    return this
  }
  F(path: string, sha: string): this {
    this.lines.push(`F\t${this.top}\t${path}\t${sha}`)
    return this
  }
  I(path: string, sha: string): this {
    this.lines.push(`I\t${this.top}\t${path}\t${sha}`)
    return this
  }
  writeBaseline(): void {
    writeFileSync(this.base, this.lines.map(l => `${l}\n`).join(''))
  }
}

type Case = {
  name: string
  // false: run without a baseline file.
  baseline?: boolean
  // The baseline file disappears once the scan starts reading the index, as
  // when the mod's command ends while a backgrounded commit still runs.
  vanish?: boolean
  setup(r: Repo): void
  hits?: string[]
  origin?: string[]
}

const lines = (n: number, tag: string) => Array.from({ length: n }, (_, i) => `// ${tag} ${i}\n`).join('')
const CS = 'namespace App;\n\npublic static class Program\n{\n    public static int Main() => 0;\n}\n'
const CS_MORE = CS.replace('=> 0;', '=> 0;\n    public static int More() => 1;')
const CS_REORDERED = 'namespace App;\n\n{\npublic static class Program\n    public static int Main() => 0;\n}\n'

const CASES: Case[] = [
  { name: 'clean commit without a baseline', baseline: false, setup: r => void r.write('src/app.cs', CS_MORE).add('src/app.cs') },
  { name: 'staged blob with the marker in line 1', baseline: false, setup: r => void r.stage('src/app.cs', `// ${MARKER}\n${CS}`), hits: ['src/app.cs'] },
  {
    name: 'marker below line 4 blocks only as the full text in a typed file',
    baseline: false,
    setup: r => {
      r.stage('README.md', `# t\n${lines(6, 'x')}${TAIL}\n`)
      r.stage('notes.txt', `a\nb\nc\nd\n${MARKER}\n`)
      r.stage('src/deep.cs', `${lines(6, 'x')}// ${TAIL}\n`)
      r.stage('src/half.cs', `${lines(6, 'x')}// ${MARKER}\n`)
    },
    hits: ['src/deep.cs'],
  },
  {
    name: 'untyped file with the marker in line 4',
    baseline: false,
    setup: r => void r.stage('README.md', `a\nb\nc\n${MARKER}\n`),
    hits: ['README.md'],
  },
  {
    name: 'clean staged blob, working-tree copy carries a sentinel, odd path names',
    baseline: false,
    setup: r => {
      for (const p of ['src/my file.cs', '-lead.cs', 'a=b.cs', 'sub dir/x.py']) r.write(p, `// ${MARKER}\n${CS}`).stage(p, CS)
      r.write('deep.cs', `${lines(6, 'x')}// ${TAIL}\n`).stage('deep.cs', CS)
      r.write('deep.txt', `${lines(6, 'x')}${TAIL}\n`).stage('deep.txt', 'x\n')
      r.write('line5.txt', `a\nb\nc\nd\n${MARKER}\n`).stage('line5.txt', 'x\n')
      r.write('sub/.gitignore', `${lines(6, 'x')}# ${TAIL}\n`).stage('sub/.gitignore', 'x\n')
    },
    hits: ['-lead.cs', 'a=b.cs', 'deep.cs', 'src/my file.cs', 'sub dir/x.py', 'sub/.gitignore'],
  },
  {
    name: 'staged-blob hits come before working-tree hits',
    baseline: false,
    setup: r => {
      r.write('a.cs', `// ${MARKER}\n`).stage('a.cs', CS)
      r.stage('b.cs', `// ${MARKER}\n`)
    },
    hits: ['b.cs', 'a.cs'],
  },
  {
    name: 'a path with a sentinel is not checked again for origin',
    setup: r => {
      r.R()
      r.write('src/app.cs', `// ${MARKER}\n${CS}`).stage('src/app.cs', `${CS}unreviewed\n`)
    },
    hits: ['src/app.cs'],
  },
  {
    name: 'staged blob equals the stored reviewed copy',
    setup: r => {
      r.write('src/app.cs', CS_MORE).add('src/app.cs')
      r.R().F('src/app.cs', r.blob(CS_MORE))
    },
  },
  { name: 'lines that HEAD already holds, in a new order', setup: r => void r.R().stage('src/app.cs', CS_REORDERED) },
  { name: 'unreviewed line against HEAD', setup: r => void r.R().stage('src/app.cs', CS_MORE), origin: ['src/app.cs'] },
  {
    name: 'unreviewed line, path with spaces, untyped files ignored',
    setup: r => {
      r.write('src/my app.cs', CS).commit()
      r.R().stage('src/my app.cs', CS_MORE).stage('README.md', 'new readme\n')
    },
    origin: ['src/my app.cs'],
  },
  {
    name: 'entry staged before the command and left as it was',
    setup: r => {
      r.stage('src/app.cs', CS_MORE)
      r.R().I('src/app.cs', r.staged('src/app.cs'))
    },
  },
  {
    name: 'entry staged before the command, then changed',
    setup: r => {
      r.R().I('src/app.cs', r.blob(CS_REORDERED))
      r.stage('src/app.cs', CS_MORE)
    },
    origin: ['src/app.cs'],
  },
  {
    name: 'a reviewed copy that is not in the object store does not fall back to HEAD',
    setup: r => void r.R().F('src/app.cs', '0123456789abcdef0123456789abcdef01234567').stage('src/app.cs', CS_REORDERED),
    origin: ['src/app.cs'],
  },
  {
    name: 'file moved by delete and add, content from the deleted path',
    setup: r => {
      r.R()
      r.rm('src/app.cs').write('src/main.cs', CS).add('src/main.cs')
      r.write('src/other.cs', CS_REORDERED).add('src/other.cs')
    },
  },
  {
    name: 'two new files, two deleted: each new file may use lines of all deleted ones',
    setup: r => {
      r.write('src/one.cs', 'class One {}\n').write('src/two.cs', 'class Two {}\n').commit()
      r.R()
      r.rm('src/one.cs').rm('src/two.cs')
      r.write('src/a.cs', 'class Two {}\nclass One {}\n').write('src/b.cs', 'class One {}\nnew line\n').add('src/a.cs', 'src/b.cs')
    },
    origin: ['src/b.cs'],
  },
  {
    name: 'reviewed copy still carries a sentinel, working tree clean',
    setup: r => {
      r.write('src/app.cs', CS_MORE).add('src/app.cs')
      r.R().F('src/app.cs', r.blob(`// ${MARKER}\n${CS_MORE}`))
    },
    origin: ['src/app.cs (its working-tree copy still carries a sentinel)'],
  },
  {
    name: 'a deleted file whose HEAD copy carries a sentinel marks every changed file',
    setup: r => {
      r.write('src/old.cs', `${lines(6, 'x')}// ${TAIL}\n`).commit()
      r.R()
      r.rm('src/old.cs')
      r.stage('src/app.cs', CS_MORE)
    },
    origin: ['src/app.cs (its working-tree copy still carries a sentinel)'],
  },
  {
    name: 'binary staged content',
    setup: r => void r.R().stage('src/app.cs', Buffer.from('bin\0ary\nmore\0\n')),
    origin: ['src/app.cs (binary, not a reviewed copy)'],
  },
  {
    name: 'reviewed CRLF copy, staged with LF',
    setup: r => {
      r.write('src/app.cs', CS_MORE.replace(/\n/g, '\r\n')).stage('src/app.cs', CS_MORE)
      r.R().F('src/app.cs', r.blob(CS_MORE.replace(/\n/g, '\r\n')))
    },
  },
  {
    name: 'staged CRLF, reviewed LF',
    setup: r => {
      r.write('src/app.cs', CS_MORE).stage('src/app.cs', CS_MORE.replace(/\n/g, '\r\n'))
      r.R().F('src/app.cs', r.blob(CS_MORE))
    },
  },
  {
    name: 'repository with an empty recorded HEAD',
    setup: r => void r.R(undefined, '').stage('src/app.cs', CS_REORDERED),
    origin: ['src/app.cs'],
  },
  {
    name: 'mode change and empty new file add no lines',
    setup: r => {
      r.R()
      git(r.dir, ['update-index', '--chmod=+x', 'src/app.cs'])
      r.write('src/empty.cs', '').add('src/empty.cs')
    },
  },
  {
    name: 'added lines that look like diff headers',
    setup: r => {
      r.write('src/x.cs', `${CS}++ b/src/y.cs\n`).add('src/x.cs')
      r.write('src/y.cs', `${CS}diff --git a/z b/z\n`).add('src/y.cs')
      r.R().F('src/y.cs', r.blob(`${CS}diff --git a/z b/z\n`))
    },
    origin: ['src/x.cs'],
  },
  {
    name: 'diff.noprefix, diff.mnemonicPrefix and a non-ASCII path',
    setup: r => {
      git(r.dir, ['config', 'diff.noprefix', 'true'])
      git(r.dir, ['config', 'diff.mnemonicPrefix', 'true'])
      r.R().stage('src/café.cs', 'class Café {}\n').stage('src/app.cs', CS_REORDERED)
    },
    origin: ['src/café.cs'],
  },
  {
    name: 'several files, messages in path order',
    setup: r => {
      r.R()
      r.write('a.cs', CS).add('a.cs').F('a.cs', r.blob(`// ${MARKER}\n${CS}`))
      r.stage('b.cs', Buffer.from('x\0y\n'))
      r.stage('src/app.cs', CS_REORDERED)
      r.stage('d.cs', 'unreviewed\n')
    },
    origin: ['a.cs (its working-tree copy still carries a sentinel)', 'b.cs (binary, not a reviewed copy)', 'd.cs'],
  },
  {
    name: 'repository the mod did not see: file written during the command',
    setup: r => {
      r.R('c:/elsewhere', r.head)
      r.write('src/app.cs', CS_MORE, FUTURE).add('src/app.cs')
    },
    origin: ['src/app.cs (written during this command)'],
  },
  {
    name: 'repository the mod did not see: working-tree copy stands in',
    setup: r => {
      r.R('c:/elsewhere', r.head)
      r.write('src/app.cs', CS_MORE).add('src/app.cs')
      r.write('src/b.cs', `${CS}\n// extra\n`).stage('src/b.cs', `// extra\n${CS}`)
      r.write('src/c.cs', CS).stage('src/c.cs', CS_MORE)
      r.stage('src/gone.cs', CS)
    },
    origin: ['src/c.cs', 'src/gone.cs'],
  },
  {
    name: 'repository the mod did not see: a file removed from the index only lends its lines',
    setup: r => {
      r.R('c:/elsewhere', r.head)
      r.write('src/app.cs', `${CS}// kept\n`).rm('src/app.cs', true)
      r.stage('src/new.cs', '// kept\n')
    },
  },
  {
    name: 'baseline removed while the scan runs: verdict from the baseline as it stood',
    vanish: true,
    setup: r => {
      r.R()
      r.write('src/app.cs', CS_MORE).add('src/app.cs').F('src/app.cs', r.blob(CS_MORE))
      r.stage('d.cs', 'unreviewed\n')
    },
    origin: ['d.cs'],
  },
]

// Stands in for git: deletes the baseline on the first index read, then runs the real git.
const vanishDir = `${root}/vanish-bin`
mkdirSync(vanishDir)
writeFileSync(`${vanishDir}/git`, '#!/bin/bash\ncase " $* " in *" --raw "*) rm -f -- "$SENTINEL_BASELINE" ;; esac\nPATH=${PATH#*:}\nexec git "$@"\n', { mode: 0o755 })

let failed = 0
for (const [i, c] of CASES.entries()) {
  const dir = `${root}/repo-${i + 1}`
  seedRepo(dir)
  const r = new Repo(dir)
  let verdict = 'PASS'
  let detail = ''
  try {
    c.setup(r)
    const env: NodeJS.ProcessEnv = { ...process.env }
    if (c.baseline !== false) {
      r.writeBaseline()
      utimesSync(r.base, new Date(), new Date())
      env.SENTINEL_BASELINE = r.base
    }
    if (c.vanish) env.PATH = `${vanishDir}${delimiter}${env.PATH ?? ''}`
    const run = spawnSync(bash, [script], { cwd: dir, env, encoding: 'utf8' })
    const hits = c.hits ?? []
    const origin = c.origin ?? []
    const want =
      (hits.length ? `Commit blocked: sentinel review lines still present in staged files:\n${hits.map(p => `  ${p}\n`).join('')}Remove the sentinel lines after reviewing, then retry.\n` : '') +
      (origin.length ? `Commit blocked: staged content adds lines that no reviewed working-tree copy holds:\n${origin.map(p => `  ${p}\n`).join('')}Write the change into the working tree, where it gets a sentinel for review, and stage it after review.\n` : '')
    const code = hits.length + origin.length ? 1 : 0
    if (run.status !== code || run.stderr !== want) {
      verdict = 'FAIL'
      detail = `    exit ${run.status}, want ${code}\n    got:  ${JSON.stringify(run.stderr)}\n    want: ${JSON.stringify(want)}`
    }
  } catch (err) {
    verdict = 'ERROR'
    detail = `    ${(err as Error).message}`
  }
  if (verdict !== 'PASS') failed++
  console.log(`${verdict.padEnd(6)} ${c.name}`)
  if (detail) console.log(detail)
}
console.log(`\n${failed === 0 ? 'PASS' : 'FAIL'}: ${CASES.length - failed}/${CASES.length} cases as expected.`)
if (!process.argv.includes('--keep')) rmSync(root, { recursive: true, force: true })
else console.log(`Repositories: ${root}`)
process.exit(failed === 0 ? 0 : 1)
