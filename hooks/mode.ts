import { atom, read, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'
import type { SkillModesActive, SkillModesExit, SkillModesState } from '../types'
import { findSkill, forgetSkills, listSkills, loadSkill, type InvalidSkill, type ValidSkill } from './catalog.ts'

type $T = EngineInterface

export const COMMAND = 'mode'
export const OFF_WORDS = ['off', 'exit', 'none', 'stop']

export const INITIAL: SkillModesState = { active: null, pendingAttach: null, pendingExit: null }
const isInitial = (s: SkillModesState) => s.active === null && s.pendingAttach === null && s.pendingExit === null

/** What turning a skill on came to, for the surface that asked to say in its own words. */
export type Activation =
  | { kind: 'on'; skill: ValidSkill; outcome: 'entered' | 'switched' | 'already'; left?: string; attachesNext: boolean }
  | { kind: 'invalid'; skill: InvalidSkill }
  | { kind: 'ambiguous'; names: string[] }
  | { kind: 'none' }

// ---- the mode's interface ----

export async function currentMode($: $T): Promise<SkillModesState> {
  return read($, mode)
}

/** Resolve `token` and turn that skill on. `exact` is `/mode <tok>`, `prefix` is Alt+Enter. */
export async function activate($: $T, token: string, match: 'exact' | 'prefix'): Promise<Activation> {
  const r = await findSkill($, token, match)
  if (r.kind !== 'skill') return r
  const skill = r.skill
  let out!: ReturnType<typeof enterMode>
  await commit($, cur => (out = enterMode(cur, skill)).state)
  return { kind: 'on', skill, outcome: out.outcome, left: out.left, attachesNext: out.state.pendingAttach === 'enter' }
}

export async function deactivate($: $T): Promise<ReturnType<typeof exitMode>> {
  let r!: ReturnType<typeof exitMode>
  await commit($, cur => (r = exitMode(cur)).state)
  return r
}

/**
 * Sends the message with the mode's blocks: the full skill until it has been delivered once, a reminder after,
 * and an exit notice once. Pending blocks clear only when the message was not dropped, so a dropped message
 * carries them again next time. `command` is the slash command the message runs, if any: only skills get blocks.
 */
export async function deliver<R extends { drop?: unknown }>(
  $: $T,
  command: string | undefined,
  send: (blocks: string[] | null) => Promise<R>,
): Promise<R> {
  let sent: SkillModesState | null = null
  let blocks: string[] = []
  try {
    const skip =
      command !== undefined &&
      (command === COMMAND || !(await listSkills($)).some(k => k.isValid && (k.name === command || k.folder === command)))
    if (!skip) {
      const s0 = await read($, mode)
      if (s0.active || s0.pendingExit) {
        const { state, body } = await prepare($, s0)
        sent = state
        blocks = blocksFor(state, body)
      }
    }
  } catch {
    sent = null
    blocks = []
  }
  if (!sent || blocks.length === 0) return send(null)
  const res = await send(blocks)
  if (res.drop === undefined) {
    const snap = sent
    await commit($, cur => afterDelivery(cur, snap))
  }
  return res
}

/** The line the compaction summary needs, or null when no mode is on. */
export async function compactionNote($: $T): Promise<string | null> {
  const s = await read($, mode)
  return s.active ? `Record in the summary that the "${s.active.name}" mode is on (skill file: ${s.active.path}).` : null
}

/** The summary dropped the skill, so the next message carries it in full again. */
export async function compacted($: $T): Promise<void> {
  await commit($, cur => markCompacted(cur))
}

/** On session start: bring back this session's saved mode (a resume) and drop the oldest saved sessions past 50. */
export async function resumeMode($: $T): Promise<void> {
  if (isInitial(await read($, mode))) {
    try {
      const saved = (await $.store.get(`mode:${await $.session.id()}`)) as { state?: SkillModesState } | undefined
      if (saved?.state && 'active' in saved.state) {
        const st = saved.state
        await update($, mode, () => st)
      }
    } catch {}
  }
  await prune($)
}

/** `/clear`: no mode, nothing saved, skills scanned afresh. */
export async function clearMode($: $T): Promise<void> {
  try {
    await $.store.delete(`mode:${await $.session.id()}`)
  } catch {}
  await update($, mode, () => INITIAL)
  forgetSkills()
}

// ---- inside: state, persistence, delivery ----

const mode = atom({ plugin: 'skill-modes', key: 'mode' } as const, INITIAL, { shape: 'mode-1' })
async function commit($: $T, change: (s: SkillModesState) => SkillModesState): Promise<SkillModesState> {
  const s = await update($, mode, change)
  try {
    const key = `mode:${await $.session.id()}`
    if (s.active === null && s.pendingExit === null) await $.store.delete(key)
    else await $.store.set(key, { state: s, savedAt: await $.clock.now() })
  } catch {}
  return s
}

async function prepare($: $T, s: SkillModesState): Promise<{ state: SkillModesState; body: string | null }> {
  const active = s.active
  if (!active) return { state: s, body: null }
  let loaded = await loadSkill($, active)
  if (loaded === null) {
    const moved = (await listSkills($, { fresh: true })).find(k => k.isValid && k.name === active.name)
    if (moved?.isValid) loaded = await loadSkill($, moved)
  }
  if (loaded === null) {
    $.ui.toast(`${active.name} mode ended: its SKILL.md is gone`)
    const state = await commit($, c => (c.active?.path === active.path ? exitMode(c, 'missing').state : c))
    return { state, body: null }
  }
  let state = s
  if (loaded.skill.isValid) {
    const fresh = toActive(loaded.skill)
    if (JSON.stringify(fresh) !== JSON.stringify(active)) {
      state = await commit($, c => (sameActive(c.active, active) ? { ...c, active: fresh } : c))
    }
  }
  return { state, body: loaded.body }
}

async function prune($: $T) {
  try {
    const keys = (await $.store.keys()).filter(k => k.startsWith('mode:'))
    if (keys.length <= 50) return
    const rows: { k: string; at: number }[] = []
    for (const k of keys) {
      const v = (await $.store.get(k)) as { savedAt?: number } | undefined
      rows.push({ k, at: v?.savedAt ?? 0 })
    }
    rows.sort((a, b) => a.at - b.at)
    for (const r of rows.slice(0, rows.length - 50)) await $.store.delete(r.k)
  } catch {}
}

// ---- reducers ----

function toActive(s: ValidSkill): SkillModesActive {
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

const sameActive = (a: SkillModesActive | null, b: SkillModesActive | null) =>
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

function markCompacted(s: SkillModesState): SkillModesState {
  if (s.active && s.pendingAttach === null) return { ...s, pendingAttach: 'reattach' }
  return s
}

// ---- context blocks ----

function attachBlock(a: SkillModesActive, body: string, reason: 'enter' | 'reattach'): string {
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

function reminderBlock(a: SkillModesActive): string {
  return `<skill_mode name="${a.name}" event="reminder">
The "${a.name}" mode is still on: keep following its skill. Re-read ${a.path} when unsure of a rule.
</skill_mode>`
}

function exitBlock(x: SkillModesExit): string {
  const why = x.reason === 'missing' ? `ended: its skill file (${x.path}) was deleted` : 'is off'
  return `<skill_mode name="${x.name}" event="${x.reason === 'missing' ? 'ended' : 'exited'}">
The "${x.name}" mode ${why}. From this message on, its skill applies only if the user asks for it again.
</skill_mode>`
}

function blocksFor(s: SkillModesState, body: string | null): string[] {
  const out: string[] = []
  if (s.pendingExit) out.push(exitBlock(s.pendingExit))
  if (s.active) {
    out.push(s.pendingAttach ? attachBlock(s.active, body ?? '', s.pendingAttach) : reminderBlock(s.active))
  }
  return out
}

