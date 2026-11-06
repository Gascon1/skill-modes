import type { PromptAutocompleteSuggestion } from 'claude-code'
import type { SkillModesActive, SkillModesExit, SkillModesState } from '../types'

export const COMMAND = 'mode'
export const OFF_WORDS = ['off', 'exit', 'none', 'stop']
export const DEFAULT_GLYPH = '◆'
export const INITIAL: SkillModesState = { active: null, pendingAttach: null, pendingExit: null }

export type SkillScope = 'project' | 'user' | 'plugin'
export type ValidSkill = {
  isValid: true
  name: string
  description: string
  icon: string | null
  color: string | null
  folder: string
  dir: string
  path: string
  scope: SkillScope
}
export type InvalidSkill = { isValid: false; folder: string; path: string; scope: SkillScope; problem: string }
export type ScannedSkill = ValidSkill | InvalidSkill
export type ParsedSkill = { fields: Record<string, string>; body: string; problem?: string }

export const isInitial = (s: SkillModesState) =>
  s.active === null && s.pendingAttach === null && s.pendingExit === null

// ---- paths ----

export function normPath(p: string): string {
  let r = p.replace(/\\/g, '/')
  while (r.length > 1 && r.endsWith('/')) r = r.slice(0, -1)
  return r
}

export function ancestors(start: string, stopAt?: string): string[] {
  const out: string[] = []
  let cur = normPath(start)
  const stop = stopAt ? normPath(stopAt) : undefined
  for (let i = 0; i < 64; i++) {
    if (cur === '' || cur === '/' || /^[A-Za-z]:$/.test(cur)) break
    if (stop !== undefined && cur === stop) break
    out.push(cur)
    const idx = cur.lastIndexOf('/')
    if (idx < 0) break
    cur = idx === 0 ? '/' : cur.slice(0, idx)
  }
  return out
}

// ---- frontmatter ----

export function parseSkillFile(raw: string): ParsedSkill {
  const text = raw.replace(/^﻿/, '').replace(/\r\n?/g, '\n')
  const lines = text.split('\n')
  if (lines[0]?.trimEnd() !== '---') {
    return { fields: {}, body: text, problem: 'SKILL.md has no frontmatter block (--- on the first line)' }
  }
  let close = -1
  for (let i = 1; i < lines.length; i++) {
    const l = (lines[i] ?? '').trimEnd()
    if (l === '---' || l === '...') {
      close = i
      break
    }
  }
  if (close < 0) {
    return { fields: {}, body: '', problem: 'the frontmatter block is not closed with ---' }
  }
  const fm = lines.slice(1, close)
  const fields: Record<string, string> = {}
  for (let i = 0; i < fm.length; i++) {
    const line = fm[i] ?? ''
    const m = /^([A-Za-z0-9_-]+)\s*:(?:\s+(.*))?$/.exec(line)
    if (!m) continue
    const key = m[1] as string
    const value = (m[2] ?? '').trim()
    const cont: string[] = []
    let j = i + 1
    while (j < fm.length) {
      const c = fm[j] ?? ''
      if (c.trim() === '' || /^\s/.test(c)) {
        cont.push(c)
        j++
      } else break
    }
    i = j - 1
    while (cont.length > 0 && (cont[cont.length - 1] ?? '').trim() === '') cont.pop()

    if (/^[|>][+-]?\d*$|^[|>]\d*[+-]?$/.test(value)) {
      const indents = cont.filter(c => c.trim() !== '').map(c => (/^\s*/.exec(c) as RegExpExecArray)[0].length)
      const ind = indents.length ? Math.min(...indents) : 0
      const ls = cont.map(c => (c.trim() === '' ? '' : c.slice(ind)))
      if (value.startsWith('|')) {
        fields[key] = ls.join('\n').trimEnd()
      } else {
        let acc = ''
        let pendingBreak = false
        for (const l of ls) {
          if (l === '') {
            acc += '\n'
            pendingBreak = false
            continue
          }
          if (acc !== '' && !acc.endsWith('\n') && !pendingBreak) acc += ' '
          acc += l
        }
        fields[key] = acc.trimEnd()
      }
      continue
    }
    if (value.startsWith('"')) {
      const q = /^"((?:[^"\\]|\\.)*)"/.exec(value)
      if (q) {
        let v = q[1] as string
        try {
          v = JSON.parse('"' + v + '"') as string
        } catch {}
        fields[key] = v
        continue
      }
    }
    if (value.startsWith("'")) {
      const q = /^'((?:[^']|'')*)'/.exec(value)
      if (q) {
        fields[key] = (q[1] as string).replace(/''/g, "'")
        continue
      }
    }
    if (value === '') continue
    const parts = [value, ...cont.map(c => c.trim()).filter(c => c !== '')]
    fields[key] = parts.join(' ').replace(/\s+#.*$/, '').trim()
  }
  return { fields, body: lines.slice(close + 1).join('\n') }
}

export function normColor(c: string | undefined | null): string | null {
  const t = (c ?? '').trim()
  if (/^#?[0-9a-f]{3}([0-9a-f]{3})?([0-9a-f]{2})?$/i.test(t)) return t.startsWith('#') ? t : '#' + t
  if (/^[a-z]+$/i.test(t)) return t
  return null
}

export function glyph(icon: string | null | undefined): string {
  const t = (icon ?? '').trim()
  if (t === '' || /^[A-Za-z0-9_-]+$/.test(t) || Array.from(t).length > 4) return DEFAULT_GLYPH
  return t
}

export function toSkill(
  parsed: ParsedSkill,
  where: { folder: string; dir: string; path: string; scope: SkillScope },
): ScannedSkill {
  const base = { folder: where.folder, dir: where.dir, path: where.path, scope: where.scope }
  if (parsed.problem) return { isValid: false, folder: base.folder, path: base.path, scope: base.scope, problem: parsed.problem }
  const name = (parsed.fields.name ?? '').trim()
  const description = (parsed.fields.description ?? '').trim()
  let problem: string | null = null
  if (!name && !description) problem = 'frontmatter has no name and no description'
  else if (!name) problem = 'frontmatter has no name'
  else if (!description) problem = 'frontmatter has no description'
  if (problem) return { isValid: false, folder: base.folder, path: base.path, scope: base.scope, problem }
  return {
    isValid: true,
    name,
    description,
    icon: parsed.fields.icon?.trim() || null,
    color: normColor(parsed.fields.color),
    ...base,
  }
}

export function findSkill(skills: ScannedSkill[], arg: string): ScannedSkill | undefined {
  const a = arg.replace(/^\//, '')
  const valid = skills.filter((s): s is ValidSkill => s.isValid)
  return (
    valid.find(s => s.name === a) ??
    valid.find(s => s.name.toLowerCase() === a.toLowerCase()) ??
    skills.find(s => s.folder === a)
  )
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
  return `<skill_mode name="${a.name}" event="${reason === 'enter' ? 'entered' : 'reattached'}">
${
  reason === 'enter'
    ? `The user turned on the "${a.name}" mode. The mode is the skill "${a.name}", attached below in full.`
    : `The "${a.name}" mode is still on. The conversation was summarized, so the skill "${a.name}" is attached again below in full.`
}
Follow this skill for this message and every message after it, until the user exits the mode or switches to another one. While the mode is on, each later message carries a short reminder.
Skill file: ${a.path}
Skill directory (relative paths in the skill resolve against it): ${a.dir}

<skill>
${body.trim()}
</skill>
</skill_mode>`
}

export function reminderBlock(a: SkillModesActive): string {
  return `<skill_mode name="${a.name}" event="reminder">
You are still in the "${a.name}" mode: keep following the "${a.name}" skill. If you have lost track of its rules, re-read the skill at ${a.path} before you continue.
</skill_mode>`
}

export function exitBlock(x: SkillModesExit): string {
  if (x.reason === 'missing') {
    return `<skill_mode name="${x.name}" event="ended">\nThe "${x.name}" mode has ended because its skill file (${x.path}) no longer exists. Stop following the "${x.name}" skill from this message on.\n</skill_mode>`
  }
  return `<skill_mode name="${x.name}" event="exited">\nThe user exited the "${x.name}" mode${x.reason === 'switch' ? ' and switched to another mode' : ''}. Stop following the "${x.name}" skill (${x.path}) from this message on; its instructions no longer apply unless the user asks for them again.\n</skill_mode>`
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

export function statusText(a: SkillModesActive, s: SkillModesState): string {
  return `${glyph(a.icon)} ${a.name} mode${s.pendingAttach === 'enter' ? ' (attaches to your next message)' : ''} · /mode off to exit`
}

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

export type Resolved =
  | { kind: 'skill'; skill: ValidSkill }
  | { kind: 'invalid'; skill: InvalidSkill }
  | { kind: 'ambiguous'; names: string[] }
  | { kind: 'none' }

/** Exact (findSkill), then a unique case-insensitive prefix of a valid skill's name or folder. */
export function resolveToken(skills: ScannedSkill[], tok: string): Resolved {
  const exact = findSkill(skills, tok)
  if (exact) return exact.isValid ? { kind: 'skill', skill: exact } : { kind: 'invalid', skill: exact }
  const t = tok.replace(/^\//, '').toLowerCase()
  if (t === '') return { kind: 'none' }
  const hits = skills.filter(
    (s): s is ValidSkill => s.isValid && (s.name.toLowerCase().startsWith(t) || s.folder.toLowerCase().startsWith(t)),
  )
  if (hits.length === 1) return { kind: 'skill', skill: hits[0] as ValidSkill }
  if (hits.length > 1) return { kind: 'ambiguous', names: hits.map(s => s.name) }
  return { kind: 'none' }
}

export function enteredToast(
  skill: ValidSkill,
  r: { state: SkillModesState; outcome: 'entered' | 'switched' | 'already'; left?: string },
): string {
  if (r.outcome === 'already') return `Already in the ${skill.name} mode`
  const tail = r.state.pendingAttach === 'enter' ? ' — attaches to your next message' : ''
  return `${r.left ? `Left ${r.left} · ` : ''}${glyph(skill.icon)} ${skill.name} mode on${tail}`
}

export function ambiguousToast(tok: string, names: string[]): string {
  const shown = names.slice(0, 4).join(', ') + (names.length > 4 ? ', …' : '')
  return `/${tok} matches ${shown} — type more of the name`
}
