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

/**
 * A pointer you can watch.
 *
 * The agent's clicks used to be `el.click()`, which fires no pointer events, moves nothing and leaves
 * no trace: the page changed and you had no idea what was touched. This paints a cursor into the page
 * and moves it to the target before the click lands, so the pane shows the same thing a person doing
 * it by hand would show. It is decoration only — `pointer-events: none`, no text, aria-hidden — so it
 * cannot be clicked, read back by browser_read_page, or intercept anything.
 */
const CURSOR_FN = `(function cursor(x, y, click){
  var id = '__agent_fleet_cursor'
  var el = document.getElementById(id)
  if (!el) {
    el = document.createElement('div')
    el.id = id
    el.setAttribute('aria-hidden', 'true')
    el.style.cssText = 'position:fixed;left:0;top:0;width:22px;height:22px;z-index:2147483647;' +
      'pointer-events:none;transition:transform .22s cubic-bezier(.4,0,.2,1);will-change:transform'
    el.innerHTML = '<svg width="22" height="22" viewBox="0 0 22 22" fill="none">' +
      '<path d="M4 2 L4 17 L8 13.4 L10.6 19 L13.4 17.7 L10.8 12.3 L16 12.2 Z" ' +
      'fill="#ffffff" stroke="#111111" stroke-width="1.4" stroke-linejoin="round"/></svg>'
    document.documentElement.appendChild(el)
  }
  el.style.transform = 'translate(' + (x - 3) + 'px,' + (y - 2) + 'px)'
  if (click) {
    var ring = document.createElement('div')
    ring.setAttribute('aria-hidden', 'true')
    ring.style.cssText = 'position:fixed;left:' + (x - 13) + 'px;top:' + (y - 13) + 'px;width:26px;height:26px;' +
      'border-radius:50%;border:2px solid #d97757;z-index:2147483646;pointer-events:none;' +
      'animation:__af_ping .5s ease-out forwards'
    if (!document.getElementById('__af_ping_style')) {
      var st = document.createElement('style')
      st.id = '__af_ping_style'
      st.textContent = '@keyframes __af_ping{0%{transform:scale(.4);opacity:1}100%{transform:scale(1.9);opacity:0}}'
      document.documentElement.appendChild(st)
    }
    document.documentElement.appendChild(ring)
    setTimeout(function(){ ring.remove() }, 520)
  }
  return true
})`

interface Spot {
  x: number
  y: number
  w: number
  h: number
}

/** Where an element is on screen right now, after scrolling it into view. Null when it is not there. */
async function locate(browser: BrowserManager, agentId: string, selector: string): Promise<Spot | null> {
  return browser.js<Spot | null>(
    agentId,
    `(() => { const el = ${FIND_FN}(${JSON.stringify(selector)});
      if (!el) return null;
      el.scrollIntoView({block:'center'});
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height } })()`
  )
}

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** Moves the drawn cursor to a point and lets the move finish, so the click is visible as a gesture. */
async function point(browser: BrowserManager, agentId: string, at: Spot, click = false): Promise<void> {
  await browser.js(agentId, `${CURSOR_FN}(${at.x}, ${at.y}, ${click})`).catch(() => undefined)
  if (!click) await wait(240)
}

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
      const sel = str('selector')
      const at = await locate(browser, agentId, sel)
      if (!at) throw new Error(`no element matching ${sel}`)

      // A hidden or zero-sized element has no place to click; fall back to the DOM call for it
      if (at.w < 1 || at.h < 1) {
        await browser.js(agentId, `(() => { const el = ${FIND_FN}(${JSON.stringify(sel)}); el && el.click() })()`)
        return { text: `clicked ${sel} (offscreen, dispatched directly)` }
      }

      await point(browser, agentId, at)
      // real mouse events, not el.click(): hover styles, pointer handlers and native widgets all
      // depend on them, and a menu that opens on mousedown never opened for the old path
      const base = { x: Math.round(at.x), y: Math.round(at.y), button: 'left', buttons: 1, clickCount: 1 }
      try {
        await browser.cdp(agentId, 'Input.dispatchMouseEvent', { ...base, type: 'mouseMoved', buttons: 0 })
        await point(browser, agentId, at, true)
        await browser.cdp(agentId, 'Input.dispatchMouseEvent', { ...base, type: 'mousePressed' })
        await wait(60)
        await browser.cdp(agentId, 'Input.dispatchMouseEvent', { ...base, type: 'mouseReleased', buttons: 0 })
      } catch {
        await browser.js(agentId, `(() => { const el = ${FIND_FN}(${JSON.stringify(sel)}); el && el.click() })()`)
      }
      return { text: `clicked ${sel}` }
    }
    case 'browser_type': {
      const spot = await locate(browser, agentId, str('selector'))
      if (spot && spot.w >= 1) await point(browser, agentId, spot, true)
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
      await browser.js(agentId, `window.scrollBy({top:${amount},behavior:'smooth'}), document.title`)
      await wait(320)
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
