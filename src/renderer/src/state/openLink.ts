const EVENT = 'agent-fleet:open-link'

/** Only these are worth handing to the embedded view; mailto and the rest belong to the system. */
function webUrl(href: string): boolean {
  return /^https?:\/\//i.test(href)
}

/**
 * Open a link the agent wrote.
 *
 * A link in the chat is almost always about the work in front of you — the dev server it just
 * started, a page it wants you to look at — so it belongs in the agent's own browser pane, beside the
 * conversation, rather than in a Chrome window behind the app. Anything the pane cannot show, and any
 * agent without a browser, still goes to the system browser.
 */
export function openLink(href: string, agentId: string | null): void {
  if (agentId && webUrl(href)) {
    window.dispatchEvent(new CustomEvent(EVENT, { detail: { agentId, url: href } }))
    return
  }
  void window.api.shell.openExternal(href)
}

export function onOpenLink(cb: (agentId: string, url: string) => void): () => void {
  const h = (e: Event): void => {
    const d = (e as CustomEvent<{ agentId: string; url: string }>).detail
    if (d) cb(d.agentId, d.url)
  }
  window.addEventListener(EVENT, h)
  return () => window.removeEventListener(EVENT, h)
}
