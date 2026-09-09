import { useCallback, useEffect, useState } from 'react'

export interface Theme {
  id: string
  name: string
  dark: boolean
  vars: Record<string, string>
}

/**
 * A theme is only a set of variables. Everything else in the app, including the animated washes and
 * the terminal, is expressed against those, so nothing has to be restyled per theme.
 */
export const THEMES: Theme[] = [
  {
    // Colours borrowed from each vendor's own look so a theme is recognisable at a glance. Inspired
    // by them, not endorsed by them, and the state roles still come first: green means running
    // whatever the brand does.
    id: 'anthropic',
    name: 'Anthropic',
    dark: true,
    vars: {
      ink: '#141110',
      panel: '#1c1815',
      raised: '#26211d',
      line: '#332c27',
      fg: '#f0ebe4',
      muted: '#a49a8e',
      dim: '#7a6f64',
      accent: '#d97757',
      warn: '#e0a33c',
      danger: '#e2645c'
    }
  },
  {
    id: 'openai',
    name: 'OpenAI',
    dark: true,
    vars: {
      ink: '#0d0f11',
      panel: '#141618',
      raised: '#1c1f23',
      line: '#282c31',
      fg: '#ececf1',
      muted: '#8e9299',
      dim: '#666c74',
      accent: '#10a37f',
      warn: '#e5a03c',
      danger: '#ef5350'
    }
  },
  {
    id: 'gemini',
    name: 'Gemini',
    dark: true,
    vars: {
      ink: '#0d1017',
      panel: '#12161f',
      raised: '#1a1f2b',
      line: '#262c3a',
      fg: '#e8eaed',
      muted: '#9aa0a6',
      dim: '#70767e',
      accent: '#8ab4f8',
      warn: '#fdd663',
      danger: '#f28b82'
    }
  },
  {
    id: 'grok',
    name: 'Grok',
    dark: true,
    vars: {
      ink: '#0a0a0a',
      panel: '#101010',
      raised: '#191919',
      line: '#262626',
      fg: '#f5f5f5',
      muted: '#9b9b9b',
      dim: '#6e6e6e',
      accent: '#9ecbff',
      warn: '#e8b64c',
      danger: '#e35b52'
    }
  },
  {
    id: 'midnight',
    name: 'Midnight',
    dark: true,
    vars: {
      ink: '#0b0d10',
      panel: '#12151a',
      raised: '#171b21',
      line: '#1f242c',
      fg: '#e6e9ef',
      muted: '#7c8592',
      dim: '#444b56',
      accent: '#5ee0a0',
      warn: '#f2b84b',
      danger: '#f2685c'
    }
  },
  {
    // The lightness ladder: a mid-grey ground with light text, softer than the dark themes.
    id: 'dusk',
    name: 'Dusk',
    dark: true,
    vars: {
      ink: '#2b2f36',
      panel: '#343941',
      raised: '#3f454e',
      line: '#4d545f',
      fg: '#f2f4f7',
      muted: '#b8c0cb',
      dim: '#8d95a1',
      accent: '#5fd39b',
      warn: '#e9b44c',
      danger: '#ef6f68'
    }
  },
  {
    // Between Dusk and Paper: a mid-grey ground with dark ink, so the state colours darken too.
    id: 'overcast',
    name: 'Overcast',
    dark: false,
    vars: {
      ink: '#adb5bf',
      panel: '#bcc3cc',
      raised: '#cdd3da',
      line: '#98a1ad',
      fg: '#0f1319',
      muted: '#2f3640',
      dim: '#4d5560',
      accent: '#08543a',
      warn: '#6a3f00',
      danger: '#7d1a17'
    }
  },
  {
    id: 'paper',
    name: 'Paper',
    dark: false,
    vars: {
      ink: '#f7f7f5',
      panel: '#ffffff',
      raised: '#eeeeeb',
      line: '#dcdcd7',
      fg: '#16171a',
      muted: '#5f6470',
      dim: '#9aa0ab',
      accent: '#127a52',
      warn: '#a06400',
      danger: '#b3312c'
    }
  }
]

const KEY = 'agent-fleet.theme'
export const THEME_EVENT = 'agent-fleet:theme'

function apply(t: Theme): void {
  const root = document.documentElement
  for (const [k, v] of Object.entries(t.vars)) root.style.setProperty(`--${k}`, v)
  root.style.setProperty('--accent-soft', `color-mix(in srgb, ${t.vars.accent} 14%, transparent)`)
  root.style.setProperty('--warn-soft', `color-mix(in srgb, ${t.vars.warn} 16%, transparent)`)
  // A translucent wash that reads on near-black disappears on a light ground, so the moving parts
  // are mixed harder there, and the subagent hue darkens to stay visible against it.
  root.style.setProperty('--sweep', t.dark ? '10%' : '30%')
  root.style.setProperty('--glow', t.dark ? '0.35' : '0.7')
  root.style.setProperty('--sub', t.dark ? '#bb9af7' : '#5b2d91')
  root.style.setProperty('--sub-soft', t.dark ? '16%' : '34%')
  // a diff sits on the panel, so its syntax colours have to survive that ground in both directions
  const code = t.dark
    ? { comment: '#7a8b99', string: '#c3e88d', number: '#f78c6c', keyword: '#c792ea', fn: '#82aaff', punct: '#9aa4b2' }
    : { comment: '#5c6773', string: '#0f7b3f', number: '#a8460a', keyword: '#8b21b0', fn: '#0b56b8', punct: '#4a5461' }
  for (const [k, v] of Object.entries(code)) root.style.setProperty(`--code-${k}`, v)
  // A translucent wash reads on near-black and vanishes on paper, and the pale +/- ink that works on
  // one is invisible on the other, so the diff carries its own pair of palettes.
  const diff = t.dark
    ? {
        'add-bg': 'color-mix(in srgb, #199e70 15%, transparent)',
        'del-bg': 'color-mix(in srgb, #d95926 13%, transparent)',
        'add-word': 'color-mix(in srgb, #199e70 32%, transparent)',
        'del-word': 'color-mix(in srgb, #d95926 28%, transparent)',
        'add-ink': '#8bf0bd',
        'del-ink': '#ff9b93'
      }
    : {
        'add-bg': 'color-mix(in srgb, #0f7b3f 13%, transparent)',
        'del-bg': 'color-mix(in srgb, #b3261e 11%, transparent)',
        'add-word': 'color-mix(in srgb, #0f7b3f 26%, transparent)',
        'del-word': 'color-mix(in srgb, #b3261e 22%, transparent)',
        'add-ink': '#0f7b3f',
        'del-ink': '#b3261e'
      }
  for (const [k, v] of Object.entries(diff)) root.style.setProperty(`--diff-${k}`, v)
  root.style.colorScheme = t.dark ? 'dark' : 'light'
  // the terminal is not styled by CSS, so it listens for this instead
  window.dispatchEvent(new CustomEvent(THEME_EVENT, { detail: t }))
}

function read(): Theme {
  try {
    const id = localStorage.getItem(KEY)
    return THEMES.find((t) => t.id === id) ?? THEMES[0]
  } catch {
    return THEMES[0]
  }
}

export function currentTheme(): Theme {
  return read()
}

export function useTheme(): { theme: Theme; setTheme: (id: string) => void } {
  const [theme, set] = useState(read)
  useEffect(() => {
    apply(theme)
  }, [theme])
  const setTheme = useCallback((id: string) => {
    const next = THEMES.find((t) => t.id === id) ?? THEMES[0]
    set(next)
    try {
      localStorage.setItem(KEY, next.id)
    } catch {
      // storage unavailable
    }
  }, [])
  return { theme, setTheme }
}
