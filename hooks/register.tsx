import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderElement } from 'claude-code'
import type { SkillModesState } from '../types'
import {
  COMMAND,
  INITIAL,
  OFF_WORDS,
  toActive,
  enterMode,
  exitMode,
  afterDelivery,
  markCompacted,
  blocksFor,
  listing,
  suggest,
  modeToken,
  missedModeKey,
  activationText,
  activationToast,
  type Activation,
  glyph,
  isInitial,
  sameActive,
} from './lib.ts'
import { listSkills, forgetSkills, searchedFolders, findSkill, loadSkill } from './catalog.ts'

const mode = atom({ plugin: 'skill-modes', key: 'mode' } as const, INITIAL, { shape: 'mode-1' })
type $T = EngineInterface
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

async function activate($: $T, token: string, match: 'exact' | 'prefix'): Promise<Activation> {
  const r = await findSkill($, token, match)
  if (r.kind !== 'skill') return r
  const skill = r.skill
  let out!: ReturnType<typeof enterMode>
  await commit($, cur => (out = enterMode(cur, skill)).state)
  return { kind: 'on', skill, outcome: out.outcome, left: out.left, attachesNext: out.state.pendingAttach === 'enter' }
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

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: COMMAND,
      description: 'Use a skill as a mode: /mode <skill> turns it on (or Option/Alt+Enter on /<skill>), /mode off turns it off, /mode lists skills',
      argumentHint: '[skill | off]',
      immediate: true,
    })
    let s = await read($, mode)
    if (isInitial(s)) {
      try {
        const saved = (await $.store.get(`mode:${await $.session.id()}`)) as { state?: SkillModesState } | undefined
        if (saved?.state && 'active' in saved.state) {
          const st = saved.state
          s = await update($, mode, () => st)
        }
      } catch {}
    }
    await prune($)
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      try {
        await $.store.delete(`mode:${await $.session.id()}`)
      } catch {}
      await update($, mode, () => INITIAL)
      forgetSkills()
    }
    return next(e)
  })

  on('command.run', { command: COMMAND }, async ($, e) => {
    const arg = e.args.trim()
    if (arg === '') {
      const all = await listSkills($, { fresh: true })
      const { dirs, home } = await searchedFolders($)
      return { text: listing(await read($, mode), all, dirs, home) }
    }
    if (OFF_WORDS.includes(arg.toLowerCase())) {
      let r!: ReturnType<typeof exitMode>
      await commit($, cur => (r = exitMode(cur)).state)
      if (r.outcome === 'none') return { text: 'No mode is active.' }
      return {
        text: r.wasDelivered
          ? `**${r.name}** mode off. Your next message tells Claude to stop following it.`
          : `**${r.name}** mode off.`,
      }
    }
    return activationText(await activate($, arg, 'exact'), arg)
  }).catch(() => ({ text: 'skill-modes: /mode failed (see claude --debug).' }))

  on('prompt.submit', async ($, e, next) => {
    let sent: SkillModesState | null = null
    let blocks: string[] = []
    try {
      const cmd = e.command
      const skip =
        cmd !== undefined &&
        (cmd.name === COMMAND ||
          !(await listSkills($)).some(k => k.isValid && (k.name === cmd.name || k.folder === cmd.name)))
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
    if (!sent || blocks.length === 0) return next(e)
    const res = await next({ ...e, context: [...(e.context ?? []), ...blocks] })
    if (res.drop === undefined) {
      const snap = sent
      await commit($, cur => afterDelivery(cur, snap))
    }
    return res
  })

  on('session.compact', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    const s = await read($, mode)
    if (!s.active) return next(e)
    const note = `Record in the summary that the "${s.active.name}" mode is on (skill file: ${s.active.path}).`
    const res = await next({ ...e, instructions: e.instructions ? `${e.instructions}\n\n${note}` : note })
    if (e.trigger !== 'precompute' && 'messages' in res && res.messages) await commit($, cur => markCompacted(cur))
    return res
  })

  on('prompt.autocomplete', async ($, e, next) => {
    const base = await next(e)
    try {
      return { suggestions: [...base.suggestions, ...suggest(e, await listSkills($))] }
    } catch {
      return base
    }
  })

  on('prompt.edit', async ($, e, next) => {
    const tok = modeToken(e) // sync; every ordinary keystroke leaves here
    if (tok === null) {
      const miss = missedModeKey(e)
      if (miss) $.ui.log(miss, { to: 'debug' })
      return next(e)
    }
    let a: Activation
    try {
      a = await activate($, tok, 'prefix')
    } catch {
      return next(e)
    }
    const toast = activationToast(a, tok)
    if (toast === null) return next(e)
    $.ui.toast(toast)
    return a.kind === 'on' ? { text: '', cursor: 0 } : { text: e.text, cursor: e.cursor }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const s = await read($, mode)
    if (!s.active || e.props.hasSurvey || e.props.view.agentId !== undefined) return next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    const a = s.active
    const badge = (
      <Box flexDirection="row">
        <Text color={a.color ?? 'suggestion'} weight="bold">{`${glyph(a.icon)} ${a.name}`}</Text>
        <Text dimColor wrap="truncate-end">
          {' mode '}
        </Text>
        <Button
          key="exit-mode"
          label="Exit mode"
          hotkey="x"
          onPress={async () => {
            await commit($, cur => exitMode(cur).state)
            $.ui.toast(`${a.name} mode off`)
          }}
        />
      </Box>
    )
    let below: RenderElement | null = null
    try {
      below = await next(e)
    } catch {}
    return below ? (
      <Box flexDirection="column">
        {badge}
        {below}
      </Box>
    ) : (
      badge
    )
  })
}
