import type { PromptAutocompleteSuggestion } from 'claude-code'
import type { SkillModesActive, SkillModesExit, SkillModesState } from '../types'
import { normPath, type InvalidSkill, type ScannedSkill, type ValidSkill } from './catalog.ts'

export const COMMAND = 'mode'
export const OFF_WORDS = ['off', 'exit', 'none', 'stop']
export const DEFAULT_GLYPH = '◆'
export const INITIAL: SkillModesState = { active: null, pendingAttach: null, pendingExit: null }

export const isInitial = (s: SkillModesState) =>
  s.active === null && s.pendingAttach === null && s.pendingExit === null

export function glyph(icon: string | null | undefined): string {
  const t = (icon ?? '').trim()
  if (t === '' || /^[A-Za-z0-9_-]+$/.test(t) || Array.from(t).length > 4) return DEFAULT_GLYPH
  return t
}

// ---- reducers ----

export function toActive(s: ValidSkill): SkillModesActive {
  return {
    name: s.name,
    description: s.description,
    path: s.path,
    dir: s.dir,
    scope: s.scope,
    icon: s.icon,
    color: s.color,
  }
}

export const sameActive = (a: SkillModesActive | null, b: SkillModesActive | null) =>
  a !== null && b !== null && a.path === b.path

export function enterMode(
  s: SkillModesState,
  skill: ValidSkill,
): { state: SkillModesState; outcome: 'entered' | 'switched' | 'already'; left?: string } {
  const next = toActive(skill)
  if (s.active && s.active.path === next.path) return { state: { ...s, active: next }, outcome: 'already' }
  if (s.pendingExit && s.pendingExit.path === next.path) {
    return {
      state: { active: next, pendingAttach: null, pendingExit: null },
      outcome: s.active ? 'switched' : 'entered',
      ...(s.active ? { left: s.active.name } : {}),
    }
  }
  const leaving = s.active
  const pendingExit: SkillModesExit | null =
    leaving && s.pendingAttach !== 'enter'
      ? { name: leaving.name, path: leaving.path, reason: 'switch' }
      : s.pendingExit
  return {
    state: { active: next, pendingAttach: 'enter', pendingExit },
    outcome: leaving ? 'switched' : 'entered',
    ...(leaving ? { left: leaving.name } : {}),
  }
}

export function exitMode(
  s: SkillModesState,
  reason: 'user' | 'missing' = 'user',
): { state: SkillModesState; outcome: 'exited' | 'none'; name?: string; wasDelivered?: boolean } {
  if (!s.active) return { state: s, outcome: 'none' }
  const told = s.pendingAttach !== 'enter'
  return {
    state: {
      active: null,
      pendingAttach: null,
      pendingExit: told ? { name: s.active.name, path: s.active.path, reason } : s.pendingExit,
    },
    outcome: 'exited',
    name: s.active.name,
    wasDelivered: told,
  }
}

export function afterDelivery(cur: SkillModesState, sent: SkillModesState): SkillModesState {
  return {
    pendingAttach:
      cur.pendingAttach !== null && cur.pendingAttach === sent.pendingAttach && sameActive(cur.active, sent.active)
        ? null
        : cur.pendingAttach,
    pendingExit:
      cur.pendingExit &&
      sent.pendingExit &&
      cur.pendingExit.path === sent.pendingExit.path &&
      cur.pendingExit.reason === sent.pendingExit.reason
        ? null
        : cur.pendingExit,
    active: cur.active,
  }
}

export function markCompacted(s: SkillModesState): SkillModesState {
  if (s.active && s.pendingAttach === null) return { ...s, pendingAttach: 'reattach' }
  return s
}

// ---- context blocks ----

export function attachBlock(a: SkillModesActive, body: string, reason: 'enter' | 'reattach'): string {
  const lead =
    reason === 'enter'
      ? `The user turned on the "${a.name}" mode. Follow the skill below on this message and every later one, until a skill_mode block says the mode is off.`
      : `The "${a.name}" mode is still on. The summary dropped its skill, so here it is again. Keep following it until a skill_mode block says the mode is off.`
  return `<skill_mode name="${a.name}" event="${reason === 'enter' ? 'entered' : 'reattached'}">
${lead}
Skill file: ${a.path} (relative paths in the skill resolve against its folder)

<skill>
${body.trim()}
</skill>
</skill_mode>`
}

export function reminderBlock(a: SkillModesActive): string {
  return `<skill_mode name="${a.name}" event="reminder">
The "${a.name}" mode is still on: keep following its skill. Re-read ${a.path} when unsure of a rule.
</skill_mode>`
}

export function exitBlock(x: SkillModesExit): string {
  const why = x.reason === 'missing' ? `ended: its skill file (${x.path}) was deleted` : 'is off'
  return `<skill_mode name="${x.name}" event="${x.reason === 'missing' ? 'ended' : 'exited'}">
The "${x.name}" mode ${why}. From this message on, its skill applies only if the user asks for it again.
</skill_mode>`
}

export function blocksFor(s: SkillModesState, body: string | null): string[] {
  const out: string[] = []
  if (s.pendingExit) out.push(exitBlock(s.pendingExit))
  if (s.active) {
    out.push(s.pendingAttach ? attachBlock(s.active, body ?? '', s.pendingAttach) : reminderBlock(s.active))
  }
  return out
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

/** What turning a skill on came to, for the surface that asked to say in its own words. */
export type Activation =
  | { kind: 'on'; skill: ValidSkill; outcome: 'entered' | 'switched' | 'already'; left?: string; attachesNext: boolean }
  | { kind: 'invalid'; skill: InvalidSkill }
  | { kind: 'ambiguous'; names: string[] }
  | { kind: 'none' }

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
