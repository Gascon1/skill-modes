import type { EngineInterface } from 'claude-code'

type $T = EngineInterface

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
export type SkillAt = { path: string; dir: string; scope: SkillScope }

export type Resolved =
  | { kind: 'skill'; skill: ValidSkill }
  | { kind: 'invalid'; skill: InvalidSkill }
  | { kind: 'ambiguous'; names: string[] }
  | { kind: 'none' }

/** `skillUsage` from Claude Code's global config: what the typeahead ranks its rows by. */
export type SkillUsage = Record<string, { usageCount?: number; lastUsedAt?: number }>

const CACHE_MS = 5000
let cache: { at: number; skills: ScannedSkill[] } | null = null

/** Every project, user and enabled plugin skill, first found wins on a name clash. */
export async function listSkills($: $T, opts?: { fresh?: boolean }): Promise<ScannedSkill[]> {
  if (!opts?.fresh && cache && (await $.clock.now()) - cache.at < CACHE_MS) return cache.skills
  const where = await places($)
  const names = new Set<string>()
  const out: ScannedSkill[] = []
  for (const s of [...(await scanRoots($, where)), ...(await scanPlugins($, where))]) {
    if (s.isValid) {
      if (names.has(s.name)) continue
      names.add(s.name)
    }
    out.push(s)
  }
  cache = { at: await $.clock.now(), skills: out }
  return out
}

export function forgetSkills(): void {
  cache = null
}

/** The project and user folders searched, for telling the user where nothing was found. */
export async function searchedFolders($: $T): Promise<{ dirs: string[]; home: string | undefined }> {
  const where = await places($)
  return { dirs: skillRoots(where).map(r => r.dir), home: where.home }
}

/** `exact` is `/mode <tok>`: name, then folder. `prefix` is Alt+Enter: also a unique prefix, ties broken by usage; it reads the cache because it runs on a keystroke. */
export async function findSkill($: $T, token: string, match: 'exact' | 'prefix'): Promise<Resolved> {
  if (match === 'exact') {
    const hit = exactMatch(await listSkills($, { fresh: true }), token)
    if (!hit) return { kind: 'none' }
    return hit.isValid ? { kind: 'skill', skill: hit } : { kind: 'invalid', skill: hit }
  }
  const all = await listSkills($)
  const r = resolveToken(all, token)
  if (r.kind !== 'ambiguous') return r
  const usage = await skillUsage($)
  const now = await $.clock.now()
  return resolveToken(all, token, s => usageScore(s, usage, now))
}

/** The skill file at `at` with its body, or null when it can't be read. */
export async function loadSkill($: $T, at: SkillAt): Promise<{ skill: ScannedSkill; body: string } | null> {
  const raw = await tryRead($, at.path)
  if (raw === null) return null
  const parsed = parseSkillFile(raw)
  return { skill: toSkill(parsed, { ...at, folder: at.dir.slice(at.dir.lastIndexOf('/') + 1) }), body: parsed.body }
}

// ---- where skills live ----

type Places = { home: string | undefined; config: string | undefined; state: string | undefined; here: string[] }
type Root = { dir: string; scope: SkillScope }

async function places($: $T): Promise<Places> {
  const home = (await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE'))
  const configDir = await $.env.get('CLAUDE_CONFIG_DIR')
  return {
    home,
    config: configDir ?? (home ? home + '/.claude' : undefined),
    state: configDir ?? home,
    here: [normPath(await $.session.cwd()), normPath(await $.session.root())],
  }
}

function skillRoots(p: Places): Root[] {
  const out: Root[] = []
  for (const base of p.here) {
    for (const d of ancestors(base, p.home)) out.push({ dir: `${d}/.claude/skills`, scope: 'project' })
  }
  if (p.config) out.push({ dir: `${normPath(p.config)}/skills`, scope: 'user' })
  const seen = new Set<string>()
  return out.filter(r => (seen.has(r.dir) ? false : (seen.add(r.dir), true)))
}

async function scanRoots($: $T, p: Places): Promise<ScannedSkill[]> {
  const out: ScannedSkill[] = []
  for (const r of skillRoots(p)) {
    for (const folder of await listDirs($, r.dir)) {
      const dir = `${r.dir}/${folder}`
      const raw = await tryRead($, `${dir}/SKILL.md`)
      if (raw !== null) out.push(toSkill(parseSkillFile(raw), { folder, dir, path: `${dir}/SKILL.md`, scope: r.scope }))
    }
  }
  return out
}

const under = (p: string, base: string) => p === base || p.startsWith(base + '/')

/** Installed plugins (user scope, or project/local scope for this checkout) and account-synced plugins. */
async function pluginDirs($: $T, p: Places): Promise<{ name: string | null; dir: string }[]> {
  if (!p.config) return []
  const base = normPath(p.config) + '/plugins'
  const out: { name: string | null; dir: string }[] = []
  const inst = await readJson($, `${base}/installed_plugins.json`)
  for (const [key, rows] of Object.entries((inst?.plugins ?? {}) as Record<string, any[]>)) {
    for (const r of Array.isArray(rows) ? rows : []) {
      if (typeof r?.installPath !== 'string') continue
      if (typeof r.projectPath === 'string' && !p.here.some(h => under(h, normPath(r.projectPath)))) continue
      out.push({ name: key.split('@')[0] ?? null, dir: normPath(r.installPath) })
    }
  }
  for (const a of await listDirs($, `${base}/synced`)) {
    for (const b of await listDirs($, `${base}/synced/${a}`)) out.push({ name: null, dir: `${base}/synced/${a}/${b}` })
  }
  return out
}

async function scanPlugins($: $T, p: Places): Promise<ScannedSkill[]> {
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
  for (const pd of await pluginDirs($, p)) {
    if (seen.has(pd.dir)) continue
    seen.add(pd.dir)
    const manifest = await readJson($, `${pd.dir}/.claude-plugin/plugin.json`)
    const plugin: string | null = typeof manifest?.name === 'string' ? manifest.name : pd.name
    if (!plugin || plugin === 'skill-modes') continue
    const declared = typeof manifest?.skills === 'string' ? [manifest.skills] : Array.isArray(manifest?.skills) ? manifest.skills : []
    const rels = declared.filter((x: unknown): x is string => typeof x === 'string')
    if (!rels.includes('./skills') && !rels.includes('skills')) rels.push('./skills')
    const dirs: string[] = []
    for (const rel of rels) {
      const d = normPath(`${pd.dir}/${rel.replace(/^\.\//, '')}`)
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

async function skillUsage($: $T): Promise<SkillUsage> {
  const { state } = await places($)
  const cfg = state ? await readJson($, `${normPath(state)}/.claude.json`) : null
  const u = cfg?.skillUsage
  return u && typeof u === 'object' ? (u as SkillUsage) : {}
}

async function tryRead($: $T, path: string): Promise<string | null> {
  try {
    return await $.fs.read(path)
  } catch {
    return null
  }
}

async function readJson($: $T, path: string): Promise<any> {
  const raw = await tryRead($, path)
  if (raw === null) return null
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

async function listDirs($: $T, dir: string): Promise<string[]> {
  try {
    return (await $.fs.list(dir))
      .filter(en => !en.name.startsWith('.') && (en.kind === 'dir' || en.isLink))
      .map(en => en.name)
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  } catch {
    return []
  }
}

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

export function toSkill(parsed: ParsedSkill, where: SkillAt & { folder: string }): ScannedSkill {
  const { folder, dir, path, scope } = where
  if (parsed.problem) return { isValid: false, folder, path, scope, problem: parsed.problem }
  const name = (parsed.fields.name ?? '').trim()
  const description = (parsed.fields.description ?? '').trim()
  let problem: string | null = null
  if (!name && !description) problem = 'frontmatter has no name and no description'
  else if (!name) problem = 'frontmatter has no name'
  else if (!description) problem = 'frontmatter has no description'
  if (problem) return { isValid: false, folder, path, scope, problem }
  return {
    isValid: true,
    name,
    description,
    icon: parsed.fields.icon?.trim() || null,
    color: normColor(parsed.fields.color),
    folder,
    dir,
    path,
    scope,
  }
}

// ---- resolution ----

function exactMatch(skills: ScannedSkill[], arg: string): ScannedSkill | undefined {
  const a = arg.replace(/^\//, '')
  const valid = skills.filter((s): s is ValidSkill => s.isValid)
  return (
    valid.find(s => s.name === a) ??
    valid.find(s => s.name.toLowerCase() === a.toLowerCase()) ??
    skills.find(s => s.folder === a)
  )
}

const HALF_LIFE_MS = 30 * 86_400_000

/** Uses decayed by age, so a skill used often a while ago still beats one used once yesterday, as the typeahead orders them. */
export function usageScore(s: ValidSkill, usage: SkillUsage, now: number): number {
  const keys = new Set([s.name, s.folder, s.name.slice(s.name.indexOf(':') + 1)])
  let score = 0
  for (const k of keys) {
    const u = usage[k]
    if (!u || typeof u.usageCount !== 'number') continue
    const age = Math.max(0, now - (u.lastUsedAt ?? 0))
    score += u.usageCount * Math.pow(0.5, age / HALF_LIFE_MS)
  }
  return score
}

/** Exact (name, then folder), then a unique case-insensitive prefix of a valid skill's name or folder; with `rank`, the clear top-ranked of several. */
export function resolveToken(skills: ScannedSkill[], tok: string, rank?: (s: ValidSkill) => number): Resolved {
  const exact = exactMatch(skills, tok)
  if (exact) return exact.isValid ? { kind: 'skill', skill: exact } : { kind: 'invalid', skill: exact }
  const t = tok.replace(/^\//, '').toLowerCase()
  if (t === '') return { kind: 'none' }
  const hits = skills.filter(
    (s): s is ValidSkill => s.isValid && (s.name.toLowerCase().startsWith(t) || s.folder.toLowerCase().startsWith(t)),
  )
  if (hits.length === 1) return { kind: 'skill', skill: hits[0] as ValidSkill }
  if (hits.length > 1 && rank) {
    const scored = hits.map(skill => ({ skill, score: rank(skill) })).sort((a, b) => b.score - a.score)
    const [top, second] = scored as [{ skill: ValidSkill; score: number }, { score: number }]
    if (top.score > 0 && top.score > second.score) return { kind: 'skill', skill: top.skill }
  }
  if (hits.length > 1) return { kind: 'ambiguous', names: hits.map(s => s.name) }
  return { kind: 'none' }
}
