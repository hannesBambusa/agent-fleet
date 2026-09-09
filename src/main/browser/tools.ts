import type { BrowserManager } from './manager'

// injected into the page; kept as source strings so they stay dependency-free
const FIND_FN = `(function find(sel){
  try { const el = document.querySelector(sel); if (el) return el } catch (e) {}
  const want = String(sel).trim().toLowerCase()
  const nodes = [...document.querySelectorAll('button,a,[role=button],input,textarea,select,label,summary,[onclick]')]
  return nodes.find(n => (n.innerText||n.value||n.getAttribute('aria-label')||n.placeholder||'').trim().toLowerCase() === want)
      || nodes.find(n => (n.innerText||n.value||n.getAttribute('aria-label')||n.placeholder||'').trim().toLowerCase().includes(want))
      || null
})`

export interface ToolResult {
  text?: string
  image?: { data: string; mimeType: string }
}

export async function runTool(
  browser: BrowserManager,
  agentId: string,
  name: string,
  args: Record<string, unknown>
): Promise<ToolResult> {
  const str = (k: string): string => String(args[k] ?? '')
  switch (name) {
    case 'browser_navigate': {
      const landed = await browser.navigate(agentId, str('url'))
      return { text: `navigated to ${landed}` }
    }
    case 'browser_back': {
      await browser.back(agentId)
      return { text: `back to ${browser.state(agentId)?.url ?? ''}` }
    }
    case 'browser_get_url': {
      const st = browser.state(agentId)
      return { text: st ? `${st.url}\n${st.title}` : 'no page' }
    }
    case 'browser_click': {
      const ok = await browser.js<boolean>(
        agentId,
        `(() => { const el = ${FIND_FN}(${JSON.stringify(str('selector'))});
          if (!el) return false;
          el.scrollIntoView({block:'center'});
          el.focus && el.focus();
          el.click();
          return true })()`
      )
      if (!ok) throw new Error(`no element matching ${str('selector')}`)
      return { text: `clicked ${str('selector')}` }
    }
    case 'browser_type': {
      const ok = await browser.js<boolean>(
        agentId,
        `(() => { const el = ${FIND_FN}(${JSON.stringify(str('selector'))});
          if (!el) return false;
          el.scrollIntoView({block:'center'});
          el.focus();
          const set = Object.getOwnPropertyDescriptor(el.constructor.prototype, 'value');
          if (set && set.set) set.set.call(el, ${JSON.stringify(str('text'))}); else el.value = ${JSON.stringify(str('text'))};
          el.dispatchEvent(new Event('input', {bubbles:true}));
          el.dispatchEvent(new Event('change', {bubbles:true}));
          return true })()`
      )
      if (!ok) throw new Error(`no input matching ${str('selector')}`)
      return { text: `typed into ${str('selector')}` }
    }
    case 'browser_press': {
      const key = str('key') || 'Enter'
      const base = { type: 'keyDown', key, windowsVirtualKeyCode: key === 'Enter' ? 13 : undefined, text: key === 'Enter' ? '\r' : undefined }
      await browser.cdp(agentId, 'Input.dispatchKeyEvent', base)
      await browser.cdp(agentId, 'Input.dispatchKeyEvent', { ...base, type: 'keyUp' })
      return { text: `pressed ${key}` }
    }
    case 'browser_scroll': {
      const amount = Number(args.amount ?? 600)
      await browser.js(agentId, `window.scrollBy({top:${amount},behavior:'instant'}), document.title`)
      return { text: `scrolled ${amount}px` }
    }
    case 'browser_read_page': {
      const text = await browser.js<string>(
        agentId,
        `(() => {
          const body = document.body ? document.body.innerText.replace(/\\n{3,}/g,'\\n\\n').slice(0, 12000) : '';
          const parts = [...document.querySelectorAll('button,a,input,textarea,select,[role=button]')].slice(0,120).map(n => {
            const label = (n.innerText||n.value||n.getAttribute('aria-label')||n.placeholder||'').trim().replace(/\\s+/g,' ').slice(0,60);
            const id = n.id ? '#'+n.id : '';
            return label || id ? \`- <\${n.tagName.toLowerCase()}\${id}> \${label}\` : null }).filter(Boolean);
          return \`URL: \${location.href}\\nTITLE: \${document.title}\\n\\n--- TEXT ---\\n\${body}\\n\\n--- INTERACTIVE ---\\n\${parts.join('\\n')}\`
        })()`
      )
      return { text }
    }
    case 'browser_screenshot': {
      // Chromium only renders a view that is actually on screen. A parked pane has no surface and
      // every capture path (captureScreenshot, Emulation overrides, capturePage) hangs on it, so
      // say so instead of stalling the agent.
      if (!browser.isVisible(agentId)) {
        throw new Error('the browser pane for this agent is not on screen; open this agent in agent-fleet to take a screenshot')
      }
      const res = (await browser.cdp(agentId, 'Page.captureScreenshot', { format: 'png' }, 8000)) as { data: string }
      return { image: { data: res.data, mimeType: 'image/png' } }
    }
    case 'browser_read_console': {
      const list = browser.consoleOf(agentId).slice(-Number(args.limit ?? 50))
      return { text: list.length ? list.map((c) => `[${c.level}] ${c.text}`).join('\n') : 'console empty' }
    }
    case 'browser_read_network': {
      const list = browser.netOf(agentId).slice(-Number(args.limit ?? 50))
      return { text: list.length ? list.map((n) => `${n.status ?? '...'} ${n.method} ${n.url}`).join('\n') : 'no requests recorded' }
    }
    default:
      throw new Error(`unknown tool ${name}`)
  }
}

export const TOOLS = [
  {
    name: 'browser_navigate',
    description: "Open a URL in this agent's own browser pane, visible to the user inside agent-fleet.",
    inputSchema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] }
  },
  {
    name: 'browser_read_page',
    description: 'Read the current page: URL, title, visible text and a list of interactive elements.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'browser_click',
    description: 'Click an element by CSS selector, or by its visible text / label / placeholder.',
    inputSchema: { type: 'object', properties: { selector: { type: 'string' } }, required: ['selector'] }
  },
  {
    name: 'browser_type',
    description: 'Type text into an input or textarea, found by CSS selector or visible label.',
    inputSchema: {
      type: 'object',
      properties: { selector: { type: 'string' }, text: { type: 'string' } },
      required: ['selector', 'text']
    }
  },
  {
    name: 'browser_press',
    description: 'Press a key, e.g. Enter, Tab, Escape.',
    inputSchema: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'] }
  },
  {
    name: 'browser_scroll',
    description: 'Scroll the page vertically by a number of pixels (negative scrolls up).',
    inputSchema: { type: 'object', properties: { amount: { type: 'number' } } }
  },
  {
    name: 'browser_screenshot',
    description: 'Take a PNG screenshot of the current page.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'browser_get_url',
    description: 'Return the current URL and page title.',
    inputSchema: { type: 'object', properties: {} }
  },
  { name: 'browser_back', description: 'Go back one entry in history.', inputSchema: { type: 'object', properties: {} } },
  {
    name: 'browser_read_console',
    description: 'Read recent console output from the page.',
    inputSchema: { type: 'object', properties: { limit: { type: 'number' } } }
  },
  {
    name: 'browser_read_network',
    description: 'Read recent network requests made by the page, with status codes.',
    inputSchema: { type: 'object', properties: { limit: { type: 'number' } } }
  }
]
