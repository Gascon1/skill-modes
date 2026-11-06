import type { PromptAutocompleteSuggestion } from 'claude-code'
import type { SkillModesState } from '../types'
import type { Activation } from './mode.ts'
import { normPath, type InvalidSkill, type ScannedSkill, type ValidSkill } from './catalog.ts'

export const COMMAND = 'mode'
export const OFF_WORDS = ['off', 'exit', 'none', 'stop']
export const DEFAULT_GLYPH = '◆'
export function glyph(icon: string | null | undefined): string {
  const t = (icon ?? '').trim()
  if (t === '' || /^[A-Za-z0-9_-]+$/.test(t) || Array.from(t).length > 4) return DEFAULT_GLYPH
  return t
}

// ---- text ----

export function listing(s: SkillModesState, skills: ScannedSkill[], roots: string[], home: string | undefined): string {
  const tilde = (p: string) => (home && normPath(home) !== '' && p.startsWith(normPath(home) + '/') ? '~' + p.slice(normPath(home).length) : p)
  const lines: string[] = []
  lines.push(s.active ? `Active mode: **${s.active.name}** (${s.active.scope}) · /mode off to exit` : 'No mode is active.')
  lines.push('')
  const valid = skills.filter((k): k is ValidSkill => k.isValid)
  const invalid = skills.filter((k): k is InvalidSkill => !k.isValid)
  if (skills.length === 0) {
    lines.push('No skills found in:')
    for (const r of roots) lines.push(`- ${tilde(r)}`)
    return lines.join('\n')
  }
  if (valid.length > 0) {
    lines.push('Skills you can use as a mode (/mode <name>, or Option/Alt+Enter on /<name>):')
    for (const k of valid) lines.push(`- ${k.name}: ${k.description} (${k.scope}, ${tilde(k.path)})`)
  }
  if (invalid.length > 0) {
    if (valid.length > 0) lines.push('')
    lines.push('Not usable as a mode (frontmatter needs name and description):')
    for (const k of invalid) lines.push(`- ${k.folder}: ${k.problem} (${tilde(k.path)})`)
  }
  return lines.join('\n')
}

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

/** `/mode <tok>`'s reply. */
export function activationText(a: Activation, tok: string): { text: string; exitCode?: number } {
  switch (a.kind) {
    case 'none':
      return { text: `No skill named "${tok}". Run /mode to list the skills you can use as a mode.`, exitCode: 1 }
    case 'invalid':
      return { text: `"${a.skill.folder}" can't be used as a mode: ${a.skill.problem} (${a.skill.path}).`, exitCode: 1 }
    case 'ambiguous':
      return { text: ambiguous(tok, a.names), exitCode: 1 }
    case 'on':
      if (a.outcome === 'already') return { text: `Already in the **${a.skill.name}** mode.` }
      return {
        text: `${a.left ? `Left the **${a.left}** mode. ` : ''}${glyph(a.skill.icon)} **${a.skill.name}** mode on. The skill is attached to your next message and stays on every turn until /mode off or another /mode.`,
      }
  }
}

/** Alt+Enter's toast; null when the token named no skill and the key should fall through. */
export function activationToast(a: Activation, tok: string): string | null {
  switch (a.kind) {
    case 'none':
      return null
    case 'invalid':
      return `"${a.skill.folder}" can't be used as a mode: ${a.skill.problem}`
    case 'ambiguous':
      return ambiguous(tok, a.names)
    case 'on':
      if (a.outcome === 'already') return `Already in the ${a.skill.name} mode`
      return `${a.left ? `Left ${a.left} · ` : ''}${glyph(a.skill.icon)} ${a.skill.name} mode on${a.attachesNext ? ' — attaches to your next message' : ''}`
  }
}

function ambiguous(tok: string, names: string[]): string {
  const shown = names.slice(0, 4).join(', ') + (names.length > 4 ? ', …' : '')
  return `/${tok} matches ${shown} — type more of the name`
}
