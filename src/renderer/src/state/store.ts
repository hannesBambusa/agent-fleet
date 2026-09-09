const PREFIX = 'agent-fleet.'

/**
 * The bit of remembered state that is not a hook: plain reads and writes, so it can be used from
 * module scope and tested without React.
 */
export function key(name: string): string {
  return `${PREFIX}${name}`
}

/** Reads a persisted value once, for code that is not a hook. */
export function readPersisted<T>(name: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key(name))
    return raw === null ? fallback : (JSON.parse(raw) as T)
  } catch {
    return fallback
  }
}

export function writePersisted<T>(name: string, value: T): void {
  try {
    localStorage.setItem(key(name), JSON.stringify(value))
  } catch {
    // storage unavailable
  }
}

/** Clears everything this app remembers, for a real reset. */
export function forgetAll(): void {
  try {
    // the indexed Storage API rather than Object.keys: the latter happens to work on a real Storage
    // and on nothing else, which makes it both surprising and untestable
    const doomed: string[] = []
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)
      if (k && k.startsWith(PREFIX)) doomed.push(k)
    }
    for (const k of doomed) localStorage.removeItem(k)
  } catch {
    // storage unavailable
  }
}
