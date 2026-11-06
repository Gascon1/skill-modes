import type { PromptAutocompleteSuggestion } from 'claude-code'
import { COMMAND, OFF_WORDS } from './mode.ts'
import type { ScannedSkill, ValidSkill } from './catalog.ts'

export function suggest(
  e: { text: string; token: string; start: number },
  skills: ScannedSkill[],
): PromptAutocompleteSuggestion[] {
  const before = e.text.slice(0, e.start)
  const valid = skills.filter((k): k is ValidSkill => k.isValid)
  if (/^\s*\/mode\s+$/.test(before)) {
    const cands = [
      { text: 'off', label: 'off', description: 'Exit the current mode' },
      ...valid.map(k => ({ text: k.name, label: k.name, description: k.description })),
    ]
    return cands.filter(c => c.text.toLowerCase().startsWith(e.token.toLowerCase())).slice(0, 20)
  }
  if (before.trim() === '' && e.token.startsWith('/') && e.token.length >= 2) {
    const t = e.token.slice(1).toLowerCase()
    return valid
      .filter(k => k.name.toLowerCase().startsWith(t))
      .slice(0, 5)
      .map(k => ({ text: '/mode ' + k.name, label: '/' + k.name + ' (use as mode)', description: `Or Option/Alt+Enter · ${k.description}` }))
  }
  return []
}

// ---- Option/Alt+Enter (prompt.edit) ----

export type EditLike = {
  key?: { key: string; ctrl?: true; shift?: true; meta?: true }
  text: string
  cursor: number
  start: number
  end: number
  inputText: string
}

/** Option/Alt+Enter as prompt.edit reports it: meta+return, or a keybinding's newline (no key). */
const ENTER_KEYS = ['return', 'enter', '\r', '\n']
const NEWLINES = ['\n', '\r', '\r\n', '\x1b\r', '\x1b\n']
export function isModeKey(e: EditLike): boolean {
  if (e.key) return ENTER_KEYS.includes(e.key.key) && e.key.meta === true && !e.key.ctrl
  return NEWLINES.includes(e.inputText) && e.start === e.end
}

/** A line for the debug log when an edit on a `/token` draft looks like a modified Enter that isModeKey rejected. */
export function missedModeKey(e: EditLike): string | null {
  if (!/^[ \t]*\/\S*[ \t]*$/.test(e.text)) return null
  const odd = e.key?.meta === true || /[\r\n\x1b]/.test(e.inputText)
  return odd ? `skill-modes: prompt.edit not taken as Alt+Enter: ${JSON.stringify({ key: e.key ?? null, inputText: e.inputText, start: e.start, end: e.end, len: e.text.length })}` : null
}

const MODE_DRAFT = new RegExp(`^[ \\t]*\\/${COMMAND}[ \\t]+(\\S+)[ \\t]*$`)
const SLASH_DRAFT = /^[ \t]*\/([^\s/]\S*)[ \t]*$/

/** The skill token when the edit is Option/Alt+Enter on a draft that is only `/<tok>` or `/mode <tok>`, caret at its end. */
export function modeToken(e: EditLike): string | null {
  if (!isModeKey(e)) return null
  if (e.start !== e.end || e.start < e.text.trimEnd().length) return null
  const m = MODE_DRAFT.exec(e.text)
  if (m) {
    const tok = m[1] as string
    return OFF_WORDS.includes(tok.toLowerCase()) ? null : tok
  }
  const s = SLASH_DRAFT.exec(e.text)
  if (!s) return null
  const tok = s[1] as string
  return tok === COMMAND ? null : tok
}
