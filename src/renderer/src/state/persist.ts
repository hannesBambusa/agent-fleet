import { useCallback, useEffect, useState } from 'react'

/**
 * A piece of state that outlives the window.
 *
 * Which tab you were on and which panel you had open are not decisions worth making twice, and an
 * app that forgets them on every launch feels like it is not paying attention. Sizes were already
 * remembered; this is the same promise for the choices beside them.
 *
 * Deliberately not for anything about a particular session: which agent is selected belongs to the
 * moment, not to the setup.
 */
export { readPersisted, writePersisted, forgetAll } from './store'
import { key } from './store'

export function usePersisted<T>(name: string, fallback: T, valid?: (v: unknown) => boolean): [T, (v: T) => void] {
  const full = key(name)
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(full)
      if (raw === null) return fallback
      const parsed = JSON.parse(raw) as T
      // a value from an older build can name a tab that no longer exists
      return valid && !valid(parsed) ? fallback : parsed
    } catch {
      return fallback
    }
  })
  const set = useCallback(
    (v: T) => {
      setValue(v)
      try {
        localStorage.setItem(full, JSON.stringify(v))
      } catch {
        // storage unavailable: the choice holds for this window and no longer
      }
    },
    [full]
  )
  return [value, set]
}

/** The same, for a value that must be one of a known set. */
export function usePersistedOneOf<T extends string>(name: string, options: readonly T[], fallback: T): [T, (v: T) => void] {
  return usePersisted<T>(name, fallback, (v) => typeof v === 'string' && (options as readonly string[]).includes(v))
}
