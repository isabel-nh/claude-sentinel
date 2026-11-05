export type DraftEntry = {
  key: string
  style: 'line' | 'block' | 'json-property' | 'markdown'
  prefix: string
  suffix: string
  jsonKey: string
  skip: [string, string, string]
}

export type PaneView =
  | { mode: 'list'; error?: string }
  | { mode: 'edit'; originalKey?: string; draft: DraftEntry; samplePath: string; error?: string }

declare module 'claude-code' {
  interface PluginState {
    sentinel: { view: Shaped<PaneView> }
  }
}
