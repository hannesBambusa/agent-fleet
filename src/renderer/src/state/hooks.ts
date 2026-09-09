import { useCallback, useEffect, useState } from 'react'
import type { HookStatus } from '../../../shared/types'

export function useHookStatus(): { status: HookStatus | null; install: () => Promise<void>; uninstall: () => Promise<void> } {
  const [status, setStatus] = useState<HookStatus | null>(null)
  useEffect(() => {
    void window.api.hookStatus().then(setStatus)
  }, [])
  const install = useCallback(async () => setStatus(await window.api.installHooks()), [])
  const uninstall = useCallback(async () => setStatus(await window.api.uninstallHooks()), [])
  return { status, install, uninstall }
}
