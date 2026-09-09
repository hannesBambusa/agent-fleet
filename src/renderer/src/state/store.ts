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

/**
 * A stored value that several parts of the screen must agree on.
 *
 * Four modules had each hand-rolled the same thing: read from storage, write, fire a custom event so
 * other components notice, listen for that event and for another window's `storage` event. The
 * details drifted between the copies, which is how a fix in one of them stayed in one of them.
 * Domain logic stays with the caller; this only owns the plumbing.
 */
export interface Broadcast<T> {
  read: () => T
  write: (v: T) => void
  subscribe: (cb: () => void) => () => void
}

export function createBroadcastState<T>(name: string, fallback: T, valid?: (v: unknown) => boolean): Broadcast<T> {
  const event = `agent-fleet:${name}`
  return {
    read: () => {
      const v = readPersisted<T>(name, fallback)
      return valid && !valid(v) ? fallback : v
    },
    write: (v: T) => {
      writePersisted(name, v)
      window.dispatchEvent(new CustomEvent(event))
    },
    subscribe: (cb) => {
      window.addEventListener(event, cb)
      // another window of the same app writes storage instead of dispatching into this one
      window.addEventListener('storage', cb)
      return () => {
        window.removeEventListener(event, cb)
        window.removeEventListener('storage', cb)
      }
    }
  }
}
