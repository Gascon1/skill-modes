import type { SkillModesState } from '../types'
import { normPath, type InvalidSkill, type ScannedSkill, type ValidSkill } from './catalog.ts'
import type { Activation } from './mode.ts'

const DEFAULT_GLYPH = '◆'
export function glyph(icon: string | null | undefined): string {
  const t = (icon ?? '').trim()
  if (t === '' || /^[A-Za-z0-9_-]+$/.test(t) || Array.from(t).length > 4) return DEFAULT_GLYPH
  return t
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
