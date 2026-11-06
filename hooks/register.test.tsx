import { expect, mock, test } from 'claude-code/testing'
import type { FsEntry } from 'claude-code'
import type { SkillModesState } from '../types'
import { activationText, activationToast, glyph } from './replies.ts'
import { isModeKey, missedModeKey, modeToken, suggest, type EditLike } from './draft.ts'
import {
  ancestors,
  normColor,
  parseSkillFile,
  resolveToken,
  toSkill,
  usageScore,
  type ScannedSkill,
  type ValidSkill,
} from './catalog.ts'
import { INITIAL, afterDelivery, enterMode, exitMode } from './mode.ts'

const REVIEWER = '/work/app/.claude/skills/reviewer/SKILL.md'
const WRITER = '/home/u/.claude/skills/writer/SKILL.md'

const baseFiles = (): Record<string, string> => ({
  [REVIEWER]: '---\nname: reviewer\ndescription: Reviews code\nicon: 🔍\ncolor: purple\n---\nREVIEW-BODY\n',
  [WRITER]: '---\nname: writer\ndescription: >\n  Writes\n  prose well\n---\nWRITER-BODY\n',
  '/home/u/.claude/skills/broken/SKILL.md': '---\nname: broken\n---\nbody\n',
  '/home/u/.claude/skills/reviewer/SKILL.md': '---\nname: reviewer\ndescription: User copy\n---\nUSER-BODY\n',
})

type Sent = { text: string; context?: readonly string[] }

function world(on: any, files: Record<string, string>, initialStore?: Record<string, unknown>) {
  const statuses: (string | undefined)[] = []
  const toasts: string[] = []
  const sent: Sent[] = []
  const seen: any[] = []
  mock.env(on, { HOME: '/home/u' })
  mock.store(on, initialStore)
  mock.clock(on, { now: 1000 })
  on('session.cwd', () => ({ value: '/work/app' }))
  on('session.root', () => ({ value: '/work/app' }))
  on('session.id', () => ({ value: 's1' }))
  on('command.register', (_: any, e: any) => ({ value: { command: e.name } }))
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }))
  on('session.end', () => ({ sessionId: 's1' }))
  on('ui.status', (_: any, e: any) => {
    statuses.push(e.text)
    return { value: undefined }
  })
  on('ui.toast', (_: any, e: any) => {
    toasts.push(e.text ?? e.message ?? JSON.stringify(e))
    return { value: undefined }
  })
  on('ui.log', () => ({ value: undefined }))
  on('fs.list', (_: any, e: any) => {
    const dir = String(e.path).replace(/\/$/, '')
    const kids = new Set<string>()
    for (const p of Object.keys(files)) if (p.startsWith(dir + '/')) kids.add(p.slice(dir.length + 1).split('/')[0] as string)
    if (kids.size === 0) return { deny: 'ENOENT' }
    const value: FsEntry[] = [...kids].map(name => ({ name, kind: 'dir', size: 0, mtimeMs: 0, isLink: false }))
    return { value }
  })
  on('fs.read', (_: any, e: any) => {
    const c = files[String(e.path)]
    return c === undefined ? { deny: 'ENOENT' } : { value: c }
  })
  on('prompt.submit', (_: any, e: any) => {
    sent.push(e)
    return { text: e.text, context: e.context }
  })
  on('ui.render', ($: any, e: any) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  on('session.compact', (_: any, e: any) => {
    seen.push(e)
    return { messages: MSGS }
  })
  return { statuses, toasts, sent, seen, last: () => statuses[statuses.length - 1] }
}

const MSGS = [{ role: 'user', text: 'hi', toolUses: [] }] as any
const START = { cwd: '/work/app', surface: 'terminal', isInteractive: true } as const
const run = ($: any, args: string) => $.command.run({ command: 'mode', args, origin: 'composer', presentation: 'text' })
const submit = async ($: any, text: string) => $.prompt.submit({ text })

test('parseSkillFile reads the frontmatter subset', () => {
  const p = parseSkillFile(
    [
      '---',
      'name: plain # note',
      'q: "a \\"b\\" c"',
      "s: 'it''s'",
      'f: >',
      '  one',
      '  two',
      '',
      '  three',
      'l: |',
      '  x',
      '  y',
      'metadata:',
      '  k: v',
      '---',
      'BODY',
    ].join('\n'),
  )
  expect(p.fields.name).toBe('plain')
  expect(p.fields.q).toBe('a "b" c')
  expect(p.fields.s).toBe("it's")
  expect(p.fields.f).toBe('one two\nthree')
  expect(p.fields.l).toBe('x\ny')
  expect(p.fields.metadata).toBeUndefined()
  expect(p.body).toBe('BODY')
  const crlf = parseSkillFile('﻿---\r\nname: a\r\n---\r\nB\r\n')
  expect(crlf.fields.name).toBe('a')
  expect(crlf.body.startsWith('B')).toBe(true)
  expect(parseSkillFile('hello').problem).toMatch(/no frontmatter/)
  expect(parseSkillFile('---\nname: a\n').problem).toMatch(/not closed/)
})

test('toSkill, normColor and glyph', () => {
  const where = { folder: 'f', dir: '/d/f', path: '/d/f/SKILL.md', scope: 'user' } as const
  const mk = (fm: string) => toSkill(parseSkillFile(fm), where)
  expect((mk('---\ndescription: d\n---\n') as any).problem).toBe('frontmatter has no name')
  expect((mk('---\nname: n\n---\n') as any).problem).toBe('frontmatter has no description')
  expect((mk('---\nfoo: n\n---\n') as any).problem).toBe('frontmatter has no name and no description')
  expect(normColor('7c3aed')).toBe('#7c3aed')
  expect(normColor('purple')).toBe('purple')
  expect(normColor('(x)')).toBeNull()
  expect(glyph('brain')).toBe('◆')
  expect(glyph('🔍')).toBe('🔍')
})

test('ancestors', () => {
  expect(ancestors('/work/app', '/home/u')).toEqual(['/work/app', '/work'])
  expect(ancestors('/home/u/p', '/home/u')).toEqual(['/home/u/p'])
})

test('reducers', () => {
  const sk = (name: string): ValidSkill => ({
    isValid: true, name, description: 'd', icon: null, color: null, folder: name, dir: `/s/${name}`, path: `/s/${name}/SKILL.md`, scope: 'user',
  })
  const a = sk('a')
  const b = sk('b')
  const entered = enterMode(INITIAL, a).state
  expect(exitMode(entered).state).toEqual(INITIAL)
  const deliveredA: SkillModesState = { ...entered, pendingAttach: null }
  const sw = enterMode(deliveredA, b).state
  expect(sw.pendingExit).toEqual({ name: 'a', path: a.path, reason: 'switch' })
  expect(sw.pendingAttach).toBe('enter')
  const deliveredB: SkillModesState = { active: sw.active, pendingAttach: null, pendingExit: null }
  const back = enterMode(exitMode(deliveredB).state, b).state
  expect(back).toEqual({ active: deliveredB.active, pendingAttach: null, pendingExit: null })
  const snapshot = deliveredA
  const later = enterMode(INITIAL, b).state
  expect(afterDelivery({ ...later }, { ...snapshot, pendingAttach: 'enter' }).pendingAttach).toBe('enter')
})

test('/mode lists skills once each', async ($, on) => {
  world(on, baseFiles())
  await $.session.start(START)
  const r = await run($, '')
  expect(r.text).toContain('reviewer')
  expect(r.text).toContain('(project')
  expect(r.text).toContain('writer')
  expect(r.text).toContain('broken: frontmatter has no description')
  expect(r.text.match(/- reviewer:/g)?.length).toBe(1)
})

test('attach on the first message, reminder after', async ($, on) => {
  const w = world(on, baseFiles())
  await $.session.start(START)
  const r = await run($, 'reviewer')
  expect(r.text).toMatch(/reviewer\*\* mode on/)
  expect(w.statuses).toEqual([])
  await submit($, 'hi')
  const c0 = w.sent[0]!.context!
  expect(c0.length).toBe(1)
  expect(c0[0]).toContain('event="entered"')
  expect(c0[0]).toContain('REVIEW-BODY')
  expect(c0[0]).toContain(REVIEWER)
  await submit($, 'again')
  const c1 = w.sent[1]!.context!
  expect(c1.length).toBe(1)
  expect(c1[0]).toContain('event="reminder"')
  expect(c1[0]).toContain(REVIEWER)
  expect(c1[0]).not.toContain('REVIEW-BODY')
  expect(w.statuses).toEqual([])
})

test('exit after delivery tells the agent once', async ($, on) => {
  const w = world(on, baseFiles())
  await $.session.start(START)
  await run($, 'reviewer')
  await submit($, 'hi')
  const r = await run($, 'off')
  expect(r.text).toMatch(/stop following/)
  await submit($, 'next')
  const c = w.sent[1]!.context!
  expect(c.length).toBe(1)
  expect(c[0]).toContain('event="exited"')
  await submit($, 'later')
  expect(w.sent[2]!.context).toBeUndefined()
  expect(w.statuses).toEqual([])
})

test('exit before delivery says nothing', async ($, on) => {
  const w = world(on, baseFiles())
  await $.session.start(START)
  await run($, 'reviewer')
  await run($, 'off')
  await submit($, 'hi')
  expect(w.sent[0]!.context).toBeUndefined()
})

test('switching modes', async ($, on) => {
  const w = world(on, baseFiles())
  await $.session.start(START)
  await run($, 'reviewer')
  await submit($, 'hi')
  const r = await run($, 'writer')
  expect(r.text).toContain('Left the **reviewer**')
  await submit($, 'go')
  const c = w.sent[1]!.context!
  expect(c.length).toBe(2)
  expect(c[0]).toContain('event="exited"')
  expect(c[1]).toContain('event="entered"')
  expect(c[1]).toContain('WRITER-BODY')
})

test('entering the active mode again does nothing', async ($, on) => {
  const w = world(on, baseFiles())
  await $.session.start(START)
  await run($, 'reviewer')
  const r = await run($, 'reviewer')
  expect(r.text).toMatch(/Already/)
  await submit($, 'hi')
  await submit($, 'two')
  expect(w.sent[1]!.context![0]).toContain('event="reminder"')
  expect(w.sent[1]!.context!.length).toBe(1)
})

test('errors do not change the mode', async ($, on) => {
  const w = world(on, baseFiles())
  await $.session.start(START)
  const a = await run($, 'nope')
  expect(a.exitCode).toBe(1)
  expect(a.text).toMatch(/No skill named "nope"/)
  const b = await run($, 'broken')
  expect(b.exitCode).toBe(1)
  expect(b.text).toMatch(/can't be used as a mode/)
  await submit($, 'hi')
  expect(w.sent[0]!.context).toBeUndefined()
})

test('a deleted skill ends the mode', async ($, on) => {
  const files = baseFiles()
  const w = world(on, files)
  await $.session.start(START)
  await run($, 'reviewer')
  await submit($, 'hi')
  delete files[REVIEWER]
  delete files['/home/u/.claude/skills/reviewer/SKILL.md'] // the shadowed user copy would otherwise take over by name
  await submit($, 'again')
  const c = w.sent[1]!.context!
  expect(c.length).toBe(1)
  expect(c[0]).toContain('event="ended"')
  expect(c[0]).toMatch(/was deleted/)
  expect(w.toasts.join('\n')).toMatch(/gone/)
  expect(w.statuses).toEqual([])
})

test('a moved skill keeps the mode on its new path', async ($, on) => {
  const files = baseFiles()
  const w = world(on, files)
  await $.session.start(START)
  await run($, 'reviewer')
  await submit($, 'hi')
  const moved = '/work/app/.claude/skills/review2/SKILL.md'
  files[moved] = files[REVIEWER] as string
  delete files[REVIEWER]
  await submit($, 'again')
  const c = w.sent[1]!.context!
  expect(c.length).toBe(1)
  expect(c[0]).toContain('event="reminder"')
  expect(c[0]).toContain(moved)
})

test('compaction attaches the skill again', async ($, on) => {
  const w = world(on, baseFiles())
  await $.session.start(START)
  await run($, 'reviewer')
  await submit($, 'hi')
  await $.session.compact({ trigger: 'manual', messages: MSGS })
  expect(w.seen[0].instructions).toMatch(/"reviewer" mode is on/)
  await submit($, 'after')
  const c = w.sent[1]!.context!
  expect(c[0]).toContain('event="reattached"')
  expect(c[0]).toContain('REVIEW-BODY')
  await submit($, 'later')
  expect(w.sent[2]!.context![0]).toContain('event="reminder"')
})

test('a subagent compaction leaves the mode alone', async ($, on) => {
  const w = world(on, baseFiles())
  await $.session.start(START)
  await run($, 'reviewer')
  await submit($, 'hi')
  await $.session.compact({ trigger: 'manual', messages: MSGS, agentId: 'a1' })
  expect(w.seen[0].instructions).toBeUndefined()
  await submit($, 'after')
  expect(w.sent[1]!.context![0]).toContain('event="reminder"')
})

const PROPS = {
  hasSurvey: false,
  isWorking: false,
  maxRows: 10,
  bodyColumns: 80,
  scroll: { offset: 0, bodyRows: 10 },
  view: {},
} as const
const BAND = { plugin: 'skill-modes', component: 'AbovePrompt', requestId: 'skill-modes' } as const

test('the band does not say the skill attaches later', async ($, on) => {
  world(on, baseFiles())
  await $.session.start(START)
  await run($, 'reviewer')
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal', props: PROPS })
  expect(await ui.find({ type: 'Text', text: /attaches/ })).toBeUndefined()
  await ui.unmount()
})

for (const surface of ['terminal', 'desktop'] as const) {
  test(`the band on ${surface}`, async ($, on) => {
    const w = world(on, baseFiles())
    await $.session.start({ ...START, surface })
    await run($, 'reviewer')
    await submit($, 'hi')

    const ui = await $.ui.mount({ ...BAND, surface, props: PROPS })
    expect(await ui.find({ type: 'Text', text: /🔍 reviewer/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /engine/ })).toBeDefined()
    await ui.press({ key: 'exit-mode' })
    expect(w.statuses).toEqual([])
    await ui.unmount()
    await submit($, 'next')
    expect(w.sent[1]!.context![0]).toContain('event="exited"')
  })

  test(`the band gives way on ${surface}`, async ($, on) => {
    world(on, baseFiles())
    await $.session.start({ ...START, surface })
    await run($, 'reviewer')
    for (const props of [{ ...PROPS, hasSurvey: true }, { ...PROPS, view: { agentId: 'a1' } }]) {
      const ui = await $.ui.mount({ ...BAND, surface, props })
      expect(await ui.find({ type: 'Text', text: /engine/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /reviewer/ })).toBeUndefined()
      await ui.unmount()
    }
    await run($, 'off')
    const ui = await $.ui.mount({ ...BAND, surface, props: PROPS })
    expect(await ui.find({ type: 'Text', text: /engine/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /reviewer/ })).toBeUndefined()
    await ui.unmount()
  })
}

test('a saved mode is restored on resume', async ($, on) => {
  const state: SkillModesState = {
    active: {
      name: 'reviewer', description: 'Reviews code', path: REVIEWER, dir: '/work/app/.claude/skills/reviewer',
      scope: 'project', icon: '🔍', color: 'purple',
    },
    pendingAttach: null,
    pendingExit: null,
  }
  const w = world(on, baseFiles(), { 'mode:s1': { state, savedAt: 1 } })
  await $.session.start(START)
  expect(w.statuses).toEqual([])
  await submit($, 'hi')
  expect(w.sent[0]!.context!.length).toBe(1)
  expect(w.sent[0]!.context![0]).toContain('event="reminder"')
})

test('suggest completes names and the use-as-mode row', () => {
  const skills: ScannedSkill[] = [
    { isValid: true, name: 'reviewer', description: 'Reviews', icon: null, color: null, folder: 'reviewer', dir: '/s/reviewer', path: '/s/reviewer/SKILL.md', scope: 'user' },
    { isValid: false, folder: 'broken', path: '/s/broken/SKILL.md', scope: 'user', problem: 'x' },
  ]
  expect(suggest({ text: '/mode re', token: 're', start: 6 }, skills).map(s => s.text)).toEqual(['reviewer'])
  expect(suggest({ text: '/mode o', token: 'o', start: 6 }, skills).map(s => s.text)).toEqual(['off'])
  expect(suggest({ text: '/rev', token: '/rev', start: 0 }, skills)).toMatchObject([{ text: '/mode reviewer' }])
  expect(suggest({ text: '/rev', token: '/rev', start: 0 }, skills)[0]!.description).toBe('Or Option/Alt+Enter · Reviews')
  expect(suggest({ text: 'hello /rev', token: '/rev', start: 6 }, skills)).toEqual([])
})

test('/clear resets the mode', async ($, on) => {
  const w = world(on, baseFiles())
  await $.session.start(START)
  await run($, 'reviewer')
  await submit($, 'hi')
  await $.session.end({ reason: 'clear', sessionId: 's1', resume: { id: 's1' } })
  expect(w.statuses).toEqual([])
  await submit($, 'fresh')
  expect(w.sent[1]!.context).toBeUndefined()
})

const ed = (text: string, o: Partial<EditLike> = {}): EditLike =>
  ({ text, cursor: text.length, start: text.length, end: text.length, inputText: '\n', key: { key: 'return', meta: true }, ...o })

test('Option/Alt+Enter detection', () => {
  expect(modeToken(ed('/rev'))).toBe('rev')
  expect(modeToken(ed('  /reviewer  ', { start: 13, end: 13 }))).toBe('reviewer')
  expect(modeToken(ed('/rev', { inputText: '' }))).toBe('rev')
  expect(modeToken(ed('/rev', { key: undefined }))).toBe('rev')
  expect(modeToken(ed('/mode rev'))).toBe('rev')
  expect(modeToken(ed('/mode off'))).toBeNull()
  expect(modeToken(ed('/mode'))).toBeNull()
  expect(modeToken(ed('/rev', { key: { key: 'return', shift: true } }))).toBeNull()
  expect(modeToken(ed('/rev', { key: { key: 'return', meta: true, ctrl: true } }))).toBeNull()
  expect(modeToken(ed('/rev', { key: { key: 'a' }, inputText: 'a' }))).toBeNull()
  expect(modeToken(ed('/rev', { key: undefined, inputText: 'x\n' }))).toBeNull()
  expect(modeToken(ed('hello /rev'))).toBeNull()
  expect(modeToken(ed('/rev\nmore'))).toBeNull()
  expect(modeToken(ed('/rev', { start: 2, end: 2, cursor: 2 }))).toBeNull()
  expect(modeToken(ed('/rev', { start: 2, end: 4 }))).toBeNull()
  expect(modeToken(ed('/'))).toBeNull()
  expect(isModeKey(ed('', { key: { key: 'enter', meta: true } }))).toBe(true)
  // Windows Terminal / WSL: CR instead of LF, or ESC CR folded into one edit with no key
  expect(modeToken(ed('/rev', { key: undefined, inputText: '\r' }))).toBe('rev')
  expect(modeToken(ed('/rev', { key: undefined, inputText: '\x1b\r' }))).toBe('rev')
  expect(modeToken(ed('/rev', { key: { key: '\r', meta: true } }))).toBe('rev')
  expect(missedModeKey(ed('/rev', { key: { key: 'return', meta: true, ctrl: true } }))).toContain('not taken')
  expect(missedModeKey(ed('/rev', { key: { key: 'v' }, inputText: 'v' }))).toBeNull()
})

const PLUG = '/home/u/.claude/plugins/cache/mkt/tools/1.0.0'
const SYNCED = '/home/u/.claude/plugins/synced/acct/p1'
const pluginFiles = (): Record<string, string> => ({
  ...baseFiles(),
  '/home/u/.claude/plugins/installed_plugins.json': JSON.stringify({
    version: 2,
    plugins: {
      'tools@mkt': [{ scope: 'user', installPath: PLUG }],
      'other@mkt': [{ scope: 'project', projectPath: '/elsewhere', installPath: '/home/u/.claude/plugins/cache/mkt/other/1' }],
    },
  }),
  [`${PLUG}/.claude-plugin/plugin.json`]: JSON.stringify({ name: 'tools' }),
  [`${PLUG}/skills/tdd/SKILL.md`]: '---\nname: tdd\ndescription: Test first\n---\nTDD-BODY\n',
  [`${PLUG}/skills/off/SKILL.md`]: '---\nname: disabled-one\ndescription: Not enabled\n---\nx\n',
  ['/home/u/.claude/plugins/cache/mkt/other/1/.claude-plugin/plugin.json']: JSON.stringify({ name: 'other' }),
  ['/home/u/.claude/plugins/cache/mkt/other/1/skills/nope/SKILL.md']: '---\nname: nope\ndescription: Other project\n---\nx\n',
  [`${SYNCED}/.claude-plugin/plugin.json`]: JSON.stringify({ name: 'mp', skills: ['./skills/eng/grill'] }),
  [`${SYNCED}/skills/eng/grill/SKILL.md`]: '---\nname: grill\ndescription: Grills you\n---\nGRILL-BODY\n',
})

test('plugin skills are listed and usable as modes', async ($, on) => {
  const w = world(on, pluginFiles())
  on('command.list', () => ({
    value: [
      { name: 'tools:tdd', description: 'Test first', source: 'plugin', plugin: 'tools' },
      { name: 'mp:grill', description: 'Grills you', source: 'plugin', plugin: 'mp' },
      { name: 'other:nope', description: 'x', source: 'plugin', plugin: 'other' },
    ],
  }))
  await $.session.start(START)
  const r = await run($, '')
  expect(r.text).toContain('- tools:tdd: Test first (plugin,')
  expect(r.text).toContain('- mp:grill: Grills you (plugin,')
  expect(r.text).not.toContain('disabled-one')
  expect(r.text).not.toContain('nope')
  expect(r.text).toContain('- reviewer: Reviews code (project,')
  expect((await run($, 'tdd')).text).toMatch(/tools:tdd\*\* mode on/)
  await submit($, 'hi')
  expect(w.sent[0]!.context![0]).toContain('TDD-BODY')
  expect((await run($, 'mp:grill')).text).toMatch(/mp:grill\*\* mode on/)
})

test('an ambiguous prefix takes the skill the typeahead ranks first', () => {
  const v = (name: string, folder: string): ValidSkill => ({ isValid: true, name, description: 'd', icon: null, color: null, folder, dir: `/p/${folder}`, path: `/p/${folder}/SKILL.md`, scope: 'plugin' })
  const skills: ScannedSkill[] = [v('pstack:poteto-help', 'poteto-help'), v('pstack:poteto-mode', 'poteto-mode')]
  const now = 100 * 86_400_000
  const day = (d: number) => now - d * 86_400_000
  const rank = (u: Record<string, { usageCount: number; lastUsedAt: number }>) => (s: ValidSkill) => usageScore(s, u, now)
  expect(resolveToken(skills, 'poteto')).toMatchObject({ kind: 'ambiguous' })
  expect(resolveToken(skills, 'poteto', rank({ 'pstack:poteto-mode': { usageCount: 44, lastUsedAt: day(0) } })))
    .toMatchObject({ kind: 'skill', skill: { name: 'pstack:poteto-mode' } })
  expect(resolveToken(skills, 'poteto', rank({}))).toMatchObject({ kind: 'ambiguous' })
  const g = [v('m:grill-me', 'grill-me'), v('m:grill-with-docs', 'grill-with-docs')]
  expect(resolveToken(g, 'grill', rank({ 'grill-me': { usageCount: 8, lastUsedAt: day(72) }, 'm:grill-with-docs': { usageCount: 1, lastUsedAt: day(1) } })))
    .toMatchObject({ kind: 'skill', skill: { name: 'm:grill-me' } })
})

test('resolveToken', () => {
  const v = (name: string, folder = name): ValidSkill => ({ isValid: true, name, description: 'd', icon: null, color: null, folder, dir: `/s/${folder}`, path: `/s/${folder}/SKILL.md`, scope: 'user' })
  const skills: ScannedSkill[] = [v('reviewer'), v('refactor'), v('Writer', 'prose'),
    { isValid: false, folder: 'broken', path: '/s/broken/SKILL.md', scope: 'user', problem: 'x' }]
  expect(resolveToken(skills, 'reviewer')).toMatchObject({ kind: 'skill', skill: { name: 'reviewer' } })
  expect(resolveToken(skills, 'writer')).toMatchObject({ kind: 'skill', skill: { name: 'Writer' } })
  expect(resolveToken(skills, 'prose')).toMatchObject({ kind: 'skill', skill: { name: 'Writer' } })
  expect(resolveToken(skills, 'REV')).toMatchObject({ kind: 'skill', skill: { name: 'reviewer' } })
  expect(resolveToken(skills, 'pro')).toMatchObject({ kind: 'skill', skill: { name: 'Writer' } })
  expect(resolveToken(skills, 're')).toEqual({ kind: 'ambiguous', names: ['reviewer', 'refactor'] })
  expect(resolveToken(skills, 'broken')).toMatchObject({ kind: 'invalid' })
  expect(resolveToken(skills, 'bro')).toEqual({ kind: 'none' })
  expect(resolveToken(skills, 'compact')).toEqual({ kind: 'none' })
})

test('activation replies', () => {
  const a: ValidSkill = { isValid: true, name: 'a', description: 'd', icon: null, color: null, folder: 'a', dir: '/s/a', path: '/s/a/SKILL.md', scope: 'user' }
  const on = (outcome: 'entered' | 'switched' | 'already', attachesNext: boolean, left?: string) => ({ kind: 'on', skill: a, outcome, left, attachesNext }) as const
  expect(activationToast(on('entered', true), 'a')).toBe('◆ a mode on — attaches to your next message')
  expect(activationToast(on('already', false), 'a')).toBe('Already in the a mode')
  expect(activationToast(on('entered', false), 'a')).toBe('◆ a mode on')
  expect(activationToast(on('switched', true, 'b'), 'a')).toBe('Left b · ◆ a mode on — attaches to your next message')
  expect(activationToast({ kind: 'ambiguous', names: ['a', 'b', 'c', 'd', 'e'] }, 're')).toBe('/re matches a, b, c, d, … — type more of the name')
  expect(activationToast({ kind: 'none' }, 'zz')).toBeNull()
  expect(activationText(on('switched', true, 'b'), 'a').text).toBe('Left the **b** mode. ◆ **a** mode on. The skill is attached to your next message and stays on every turn until /mode off or another /mode.')
  expect(activationText({ kind: 'none' }, 'zz')).toEqual({ text: 'No skill named "zz". Run /mode to list the skills you can use as a mode.', exitCode: 1 })
})

const altEnter = ($: any, text: string) =>
  $.prompt.edit({ origin: { kind: 'composer' }, text, cursor: text.length, start: text.length, end: text.length, inputText: '\n', key: { key: 'return', meta: true } })

test('Enter on /mode takes the exact name, Alt+Enter also takes a prefix', async ($, on) => {
  const w = world(on, { ...baseFiles(), '/home/u/.claude/skills/refactor/SKILL.md': '---\nname: refactor\ndescription: Refactors\n---\nREF\n' })
  await $.session.start(START)
  expect((await run($, 'rev')).text).toMatch(/No skill named "rev"/)
  expect(await altEnter($, '/mode rev')).toEqual({ text: '', cursor: 0 })
  expect(w.toasts.at(-1)).toBe('🔍 reviewer mode on — attaches to your next message')
  expect(await altEnter($, '/wri')).toEqual({ text: '', cursor: 0 })
  expect(w.toasts.at(-1)).toBe('Left reviewer · ◆ writer mode on — attaches to your next message')
  expect(await altEnter($, '/wri')).toEqual({ text: '', cursor: 0 })
  expect(w.toasts.at(-1)).toBe('Already in the writer mode')
  expect(await altEnter($, '/re')).toEqual({ text: '/re', cursor: 3 })
  expect(w.toasts.at(-1)).toBe('/re matches reviewer, refactor — type more of the name')
  expect(await altEnter($, '/broken')).toEqual({ text: '/broken', cursor: 7 })
  expect(w.toasts.at(-1)).toBe(`"broken" can't be used as a mode: frontmatter has no description`)
  await submit($, 'hi')
  const c = w.sent[0]!.context!
  expect(c.length).toBe(1)
  expect(c[0]).toContain('WRITER-BODY')
})
