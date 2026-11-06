import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderElement } from 'claude-code'
import type { SkillModesState } from '../types'
import {
  COMMAND,
  INITIAL,
  OFF_WORDS,
  ancestors,
  normPath,
  parseSkillFile,
  toSkill,
  toActive,
  findSkill,
  enterMode,
  exitMode,
  afterDelivery,
  markCompacted,
  blocksFor,
  statusText,
  listing,
  suggest,
  modeToken,
  missedModeKey,
  resolveToken,
  enteredToast,
  ambiguousToast,
  glyph,
  isInitial,
  sameActive,
  type ScannedSkill,
  type SkillScope,
} from './lib.ts'

const mode = atom({ plugin: 'skill-modes', key: 'mode' } as const, INITIAL, { shape: 'mode-1' })
type $T = EngineInterface
let scanCache: { at: number; skills: ScannedSkill[] } | null = null

type Root = { dir: string; scope: SkillScope }

async function roots($: $T): Promise<{ roots: Root[]; home: string | undefined }> {
  const home = (await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE'))
  const config = (await $.env.get('CLAUDE_CONFIG_DIR')) ?? (home ? home + '/.claude' : undefined)
  const cwd = normPath(await $.session.cwd())
  const root = normPath(await $.session.root())
  const out: Root[] = []
  for (const base of [cwd, root]) {
    for (const d of ancestors(base, home)) out.push({ dir: `${d}/.claude/skills`, scope: 'project' })
  }
  if (config) out.push({ dir: `${normPath(config)}/skills`, scope: 'user' })
  const seen = new Set<string>()
  return {
    roots: out.filter(r => (seen.has(r.dir) ? false : (seen.add(r.dir), true))),
    home,
  }
}

async function scanSkills($: $T): Promise<ScannedSkill[]> {
  const { roots: rs } = await roots($)
  const out: ScannedSkill[] = []
  const names = new Set<string>()
  for (const r of rs) {
    let entries
    try {
      entries = await $.fs.list(r.dir)
    } catch {
      continue
    }
    entries = [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    for (const en of entries) {
      if (en.name.startsWith('.')) continue
      if (en.kind !== 'dir' && !en.isLink) continue
      const path = `${r.dir}/${en.name}/SKILL.md`
      let raw: string
      try {
        raw = await $.fs.read(path)
      } catch {
        continue
      }
      const s = toSkill(parseSkillFile(raw), { folder: en.name, dir: `${r.dir}/${en.name}`, path, scope: r.scope })
      if (s.isValid) {
        if (names.has(s.name)) continue
        names.add(s.name)
      }
      out.push(s)
    }
  }
  for (const s of await scanPluginSkills($)) {
    if (s.isValid) {
      if (names.has(s.name)) continue
      names.add(s.name)
    }
    out.push(s)
  }
  scanCache = { at: await $.clock.now(), skills: out }
  return out
}

async function readJson($: $T, path: string): Promise<any> {
  try {
    return JSON.parse(await $.fs.read(path))
  } catch {
    return null
  }
}

async function listDirs($: $T, dir: string): Promise<string[]> {
  try {
    return (await $.fs.list(dir))
      .filter(en => !en.name.startsWith('.') && (en.kind === 'dir' || en.isLink))
      .map(en => en.name)
      .sort()
  } catch {
    return []
  }
}

const under = (p: string, base: string) => p === base || p.startsWith(base + '/')

/** Installed plugins (user scope, or project/local scope for this checkout) and account-synced plugins. */
async function pluginDirs($: $T): Promise<{ name: string | null; dir: string }[]> {
  const home = (await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE'))
  const config = (await $.env.get('CLAUDE_CONFIG_DIR')) ?? (home ? home + '/.claude' : undefined)
  if (!config) return []
  const base = normPath(config) + '/plugins'
  const here = [normPath(await $.session.cwd()), normPath(await $.session.root())]
  const out: { name: string | null; dir: string }[] = []
  const inst = await readJson($, `${base}/installed_plugins.json`)
  for (const [key, rows] of Object.entries((inst?.plugins ?? {}) as Record<string, any[]>)) {
    for (const r of Array.isArray(rows) ? rows : []) {
      if (typeof r?.installPath !== 'string') continue
      if (typeof r.projectPath === 'string' && !here.some(h => under(h, normPath(r.projectPath)))) continue
      out.push({ name: key.split('@')[0] ?? null, dir: normPath(r.installPath) })
    }
  }
  for (const a of await listDirs($, `${base}/synced`)) {
    for (const b of await listDirs($, `${base}/synced/${a}`)) out.push({ name: null, dir: `${base}/synced/${a}/${b}` })
  }
  return out
}

async function scanPluginSkills($: $T): Promise<ScannedSkill[]> {
  let enabled: { name: string; plugin?: string }[] | null = null
  try {
    enabled = (await $.command.list()).filter(c => c.source === 'plugin')
  } catch {}
  const isEnabled = (plugin: string, skill: string, folder: string) =>
    enabled === null ||
    enabled.some(
      c =>
        c.name === `${plugin}:${skill}` ||
        c.name === `${plugin}:${folder}` ||
        (c.plugin === plugin && (c.name === skill || c.name === folder)),
    )
  const out: ScannedSkill[] = []
  const seen = new Set<string>()
  for (const p of await pluginDirs($)) {
    if (seen.has(p.dir)) continue
    seen.add(p.dir)
    const manifest = await readJson($, `${p.dir}/.claude-plugin/plugin.json`)
    const plugin: string | null = typeof manifest?.name === 'string' ? manifest.name : p.name
    if (!plugin || plugin === 'skill-modes') continue
    const declared = typeof manifest?.skills === 'string' ? [manifest.skills] : Array.isArray(manifest?.skills) ? manifest.skills : []
    const rels = declared.filter((x: unknown): x is string => typeof x === 'string')
    if (!rels.includes('./skills') && !rels.includes('skills')) rels.push('./skills')
    const dirs: string[] = []
    for (const rel of rels) {
      const d = normPath(`${p.dir}/${rel.replace(/^\.\//, '')}`)
      if ((await tryRead($, `${d}/SKILL.md`)) !== null) dirs.push(d)
      else for (const c of await listDirs($, d)) dirs.push(`${d}/${c}`)
    }
    for (const dir of [...new Set(dirs)]) {
      const path = `${dir}/SKILL.md`
      const raw = await tryRead($, path)
      if (raw === null) continue
      const folder = dir.slice(dir.lastIndexOf('/') + 1)
      const s = toSkill(parseSkillFile(raw), { folder, dir, path, scope: 'plugin' })
      if (!s.isValid) {
        if (isEnabled(plugin, folder, folder)) out.push(s)
        continue
      }
      if (!isEnabled(plugin, s.name, folder)) continue
      out.push({ ...s, name: s.name.includes(':') ? s.name : `${plugin}:${s.name}` })
    }
  }
  return out
}

async function cachedSkills($: $T): Promise<ScannedSkill[]> {
  if (scanCache && (await $.clock.now()) - scanCache.at < 5000) return scanCache.skills
  return scanSkills($)
}

const showStatus = ($: $T, s: SkillModesState) => $.ui.status(s.active ? statusText(s.active, s) : undefined)

async function commit($: $T, change: (s: SkillModesState) => SkillModesState): Promise<SkillModesState> {
  const s = await update($, mode, change)
  try {
    const key = `mode:${await $.session.id()}`
    if (s.active === null && s.pendingExit === null) await $.store.delete(key)
    else await $.store.set(key, { state: s, savedAt: await $.clock.now() })
  } catch {}
  showStatus($, s)
  return s
}

async function tryRead($: $T, path: string): Promise<string | null> {
  try {
    return await $.fs.read(path)
  } catch {
    return null
  }
}

async function prepare($: $T, s: SkillModesState): Promise<{ state: SkillModesState; body: string | null }> {
  const active = s.active
  if (!active) return { state: s, body: null }
  let cur = active
  let raw = await tryRead($, cur.path)
  if (raw === null) {
    const found = (await scanSkills($)).find(k => k.isValid && k.name === active.name)
    if (found && found.isValid) {
      raw = await tryRead($, found.path)
      if (raw !== null) cur = toActive(found)
    }
  }
  if (raw === null) {
    $.ui.toast(`${active.name} mode ended: its SKILL.md is gone`)
    const state = await commit($, c => (c.active?.path === active.path ? exitMode(c, 'missing').state : c))
    return { state, body: null }
  }
  const parsed = parseSkillFile(raw)
  let state = s
  if (!parsed.problem) {
    const sk = toSkill(parsed, { folder: '', dir: cur.dir, path: cur.path, scope: cur.scope })
    if (sk.isValid) {
      const fresh = { ...toActive(sk), path: cur.path, dir: cur.dir, scope: cur.scope }
      if (JSON.stringify(fresh) !== JSON.stringify(active)) {
        state = await commit($, c => (sameActive(c.active, active) ? { ...c, active: fresh } : c))
      }
    }
  }
  return { state, body: parsed.body }
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
    showStatus($, s)
    await prune($)
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      try {
        await $.store.delete(`mode:${await $.session.id()}`)
      } catch {}
      await update($, mode, () => INITIAL)
      $.ui.status(undefined)
      scanCache = null
    }
    return next(e)
  })

  on('command.run', { command: COMMAND }, async ($, e) => {
    const arg = e.args.trim()
    if (arg === '') {
      const skills = await scanSkills($)
      const { roots: rs, home } = await roots($)
      return {
        text: listing(
          await read($, mode),
          skills,
          rs.map(r => r.dir),
          home,
        ),
      }
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
    const hit = findSkill(await scanSkills($), arg)
    if (!hit) return { text: `No skill named "${arg}". Run /mode to list the skills you can use as a mode.`, exitCode: 1 }
    if (!hit.isValid) return { text: `"${hit.folder}" can't be used as a mode: ${hit.problem} (${hit.path}).`, exitCode: 1 }
    let r!: ReturnType<typeof enterMode>
    await commit($, cur => (r = enterMode(cur, hit)).state)
    if (r.outcome === 'already') return { text: `Already in the **${hit.name}** mode.` }
    return {
      text: `${r.left ? `Left the **${r.left}** mode. ` : ''}${glyph(hit.icon)} **${hit.name}** mode on. The skill is attached to your next message and stays on every turn until /mode off or another /mode.`,
    }
  }).catch(() => ({ text: 'skill-modes: /mode failed (see claude --debug).' }))

  on('prompt.submit', async ($, e, next) => {
    let sent: SkillModesState | null = null
    let blocks: string[] = []
    try {
      const cmd = e.command
      const skip =
        cmd !== undefined &&
        (cmd.name === COMMAND ||
          !(await cachedSkills($)).some(k => k.isValid && (k.name === cmd.name || k.folder === cmd.name)))
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
    const note = `The conversation is in the "${s.active.name}" skill mode (skill file: ${s.active.path}). Keep in the summary that this mode is on and its skill must still be followed.`
    const res = await next({ ...e, instructions: e.instructions ? `${e.instructions}\n\n${note}` : note })
    if (e.trigger !== 'precompute' && 'messages' in res && res.messages) await commit($, cur => markCompacted(cur))
    return res
  })

  on('prompt.autocomplete', async ($, e, next) => {
    const base = await next(e)
    try {
      return { suggestions: [...base.suggestions, ...suggest(e, await cachedSkills($))] }
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
    let r: ReturnType<typeof resolveToken>
    try {
      r = resolveToken(await cachedSkills($), tok)
    } catch {
      return next(e)
    }
    if (r.kind === 'none') return next(e)
    if (r.kind === 'invalid') {
      $.ui.toast(`"${r.skill.folder}" can't be used as a mode: ${r.skill.problem}`)
      return { text: e.text, cursor: e.cursor }
    }
    if (r.kind === 'ambiguous') {
      $.ui.toast(ambiguousToast(tok, r.names))
      return { text: e.text, cursor: e.cursor }
    }
    const hit = r.skill
    let out!: ReturnType<typeof enterMode>
    try {
      await commit($, cur => (out = enterMode(cur, hit)).state)
    } catch {
      return next(e)
    }
    $.ui.toast(enteredToast(hit, out))
    return { text: '', cursor: 0 }
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
          {s.pendingAttach === 'enter' ? ' mode · attaches to your next message ' : ' mode '}
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
