export type Notify = (cause: string, text: string) => Promise<void>

export function createNotifier(sink: (text: string) => Promise<unknown>, reported = new Set<string>()): Notify {
  return async (cause, text) => {
    if (reported.has(cause)) return
    reported.add(cause)
    try {
      await sink(text)
    } catch {
      // A notice that cannot be shown must never fail the hook that raised it.
    }
  }
}

// Causes already reported this session, shared by every hook body's notifier.
const reportedThisSession = new Set<string>()

export function sessionNotifier(sink: (text: string) => Promise<unknown>): Notify {
  return createNotifier(sink, reportedThisSession)
}
