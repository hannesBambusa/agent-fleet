import { useEffect, useRef, useState } from 'react'
import type * as Monaco from 'monaco-editor'
import { THEME_EVENT } from '../state/theme'

/**
 * The file viewer, on Monaco.
 *
 * Worth the weight here and nowhere else: a file is read whole, scrolled, searched and folded, and
 * that is exactly what Monaco is for. The chat's diffs stay on the small tokenizer, where the
 * content is a three-line fragment and an editor would be absurd.
 *
 * Loaded on demand, the first time this pane is opened, so it costs nothing at startup.
 *
 * No web workers. Workers drive Monaco's *language services* — type checking, completions, JSON
 * validation — none of which a read-only viewer needs, while the colouring itself is Monarch and
 * runs on this thread. A stub keeps Monaco from reaching for one, which also keeps the app inside
 * its own content security policy.
 */

type Api = typeof Monaco

interface Defaults {
  setDiagnosticsOptions: (o: { noSemanticValidation: boolean; noSyntaxValidation: boolean }) => void
}

let loading: Promise<Api> | null = null

function load(): Promise<Api> {
  if (!loading) {
    self.MonacoEnvironment = {
      getWorker: () =>
        ({
          postMessage: () => undefined,
          terminate: () => undefined,
          addEventListener: () => undefined,
          removeEventListener: () => undefined,
          onmessage: null,
          onmessageerror: null,
          onerror: null,
          dispatchEvent: () => false
        }) as unknown as Worker
    }
    loading = import('monaco-editor').then((monaco) => {
      // Belt and braces: with no worker there is nothing to answer a validation request, so the
      // features that would ask are turned off rather than left to time out on a hover. These
      // namespaces are contributed at runtime and are not on the editor's own type, hence the cast.
      const langs = monaco.languages as unknown as {
        typescript?: { typescriptDefaults: Defaults; javascriptDefaults: Defaults }
        json?: { jsonDefaults: { setDiagnosticsOptions: (o: { validate: boolean }) => void } }
      }
      const off = { noSemanticValidation: true, noSyntaxValidation: true }
      langs.typescript?.typescriptDefaults.setDiagnosticsOptions(off)
      langs.typescript?.javascriptDefaults.setDiagnosticsOptions(off)
      langs.json?.jsonDefaults.setDiagnosticsOptions({ validate: false })
      return monaco
    })
  }
  return loading
}

const THEME = 'agent-fleet'

/** Monaco wants hex; the app's colours are CSS variables resolved against the live document. */
function cssVar(name: string, fallback: string): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return /^#[0-9a-f]{3,8}$/i.test(v) ? v : fallback
}

function defineTheme(monaco: Api, dark: boolean): void {
  monaco.editor.defineTheme(THEME, {
    base: dark ? 'vs-dark' : 'vs',
    inherit: true,
    // the same token colours the chat diffs use, so the two never disagree about what a string is
    rules: [
      { token: 'comment', foreground: cssVar('--code-comment', '#7a8b99').slice(1) },
      { token: 'string', foreground: cssVar('--code-string', '#c3e88d').slice(1) },
      { token: 'number', foreground: cssVar('--code-number', '#f78c6c').slice(1) },
      { token: 'keyword', foreground: cssVar('--code-keyword', '#c792ea').slice(1) },
      { token: 'type', foreground: cssVar('--code-fn', '#82aaff').slice(1) },
      { token: 'delimiter', foreground: cssVar('--code-punct', '#9aa4b2').slice(1) }
    ],
    colors: {
      'editor.background': cssVar('--panel', dark ? '#12151a' : '#ffffff'),
      'editor.foreground': cssVar('--fg', dark ? '#e6e9ef' : '#16171a'),
      'editorLineNumber.foreground': cssVar('--dim', '#666'),
      'editorLineNumber.activeForeground': cssVar('--muted', '#999'),
      'editor.lineHighlightBackground': cssVar('--raised', dark ? '#171b21' : '#eee'),
      'editorGutter.background': cssVar('--panel', dark ? '#12151a' : '#ffffff'),
      'editorWidget.background': cssVar('--panel', dark ? '#12151a' : '#ffffff'),
      'editorWidget.border': cssVar('--line', '#333'),
      'input.background': cssVar('--ink', dark ? '#0b0d10' : '#f7f7f5'),
      'scrollbarSlider.background': `${cssVar('--line', '#333')}aa`
    }
  })
  monaco.editor.setTheme(THEME)
}

// what Monaco calls the languages, from what the file is called
const LANG: Record<string, string> = {
  ts: 'typescript',
  tsx: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  json: 'json',
  md: 'markdown',
  css: 'css',
  html: 'html',
  yml: 'yaml',
  yaml: 'yaml',
  sh: 'shell',
  bash: 'shell',
  zsh: 'shell',
  py: 'python',
  rb: 'ruby',
  go: 'go',
  rs: 'rust',
  sql: 'sql',
  swift: 'swift',
  java: 'java',
  php: 'php',
  xml: 'xml',
  toml: 'ini',
  ini: 'ini',
  env: 'ini'
}

export function languageOf(path: string): string {
  const name = path.split('/').pop() ?? ''
  if (name.startsWith('.env')) return 'ini'
  if (name === 'Dockerfile') return 'dockerfile'
  return LANG[name.split('.').pop()?.toLowerCase() ?? ''] ?? 'plaintext'
}

export function MonacoViewer({ path, text }: { path: string; text: string }): JSX.Element {
  const host = useRef<HTMLDivElement>(null)
  const editor = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null)
  const api = useRef<Api | null>(null)
  const [ready, setReady] = useState(false)

  useEffect(() => {
    let alive = true
    void load().then((monaco) => {
      if (!alive || !host.current) return
      api.current = monaco
      defineTheme(monaco, document.documentElement.style.colorScheme !== 'light')
      editor.current = monaco.editor.create(host.current, {
        value: text,
        language: languageOf(path),
        readOnly: true,
        // a viewer, so: no minimap, no suggestions, no lightbulbs, and room to breathe
        minimap: { enabled: false },
        automaticLayout: true,
        scrollBeyondLastLine: false,
        renderLineHighlight: 'line',
        fontSize: 11.5,
        lineHeight: 18,
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        padding: { top: 6, bottom: 12 },
        smoothScrolling: true,
        theme: THEME,
        scrollbar: { verticalScrollbarSize: 9, horizontalScrollbarSize: 9 }
      })
      setReady(true)
    })
    return () => {
      alive = false
      editor.current?.getModel()?.dispose()
      editor.current?.dispose()
      editor.current = null
    }
    // created once; content and language are pushed in below, which keeps the scroll position sane
  }, [])

  // a different file reuses the same editor rather than tearing it down
  useEffect(() => {
    const monaco = api.current
    const ed = editor.current
    if (!monaco || !ed) return
    const model = ed.getModel()
    if (!model) return
    monaco.editor.setModelLanguage(model, languageOf(path))
    if (model.getValue() !== text) {
      model.setValue(text)
      ed.setScrollTop(0)
    }
  }, [path, text, ready])

  // the app's themes are CSS variables, and Monaco reads colours once, so it is told again
  useEffect(() => {
    const h = (e: Event): void => {
      const dark = (e as CustomEvent<{ dark: boolean }>).detail?.dark ?? true
      if (api.current) defineTheme(api.current, dark)
    }
    window.addEventListener(THEME_EVENT, h)
    return () => window.removeEventListener(THEME_EVENT, h)
  }, [])

  return (
    <div className="relative h-full w-full">
      <div ref={host} className="h-full w-full" />
      {!ready && (
        <div className="absolute inset-0 flex items-center justify-center bg-[var(--panel)] text-[11px] text-[var(--dim)]">
          loading the editor…
        </div>
      )}
    </div>
  )
}
