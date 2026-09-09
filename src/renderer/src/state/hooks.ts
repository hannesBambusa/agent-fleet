import { useCallback, useEffect, useState } from 'react'
import type { HookStatus } from '../../../shared/types'

export function useHookStatus(): { status: HookStatus | null; install: () => Promise<void>; uninstall: () => Promise<void> } {
  const [status, setStatus] = useState<HookStatus | null>(null)
  useEffect(() => {
    void window.api.hooks.hookStatus().then(setStatus)
  }, [])
  const install = useCallback(async () => setStatus(await window.api.hooks.installHooks()), [])
  const uninstall = useCallback(async () => setStatus(await window.api.hooks.uninstallHooks()), [])
  return { status, install, uninstall }
}
