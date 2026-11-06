import type { Register, RenderElement } from 'claude-code'
import { COMMAND, OFF_WORDS, listing, suggest, modeToken, missedModeKey, activationText, activationToast, glyph } from './lib.ts'
import { listSkills, searchedFolders } from './catalog.ts'
import { activate, clearMode, compacted, compactionNote, currentMode, deactivate, deliver, resumeMode, type Activation } from './mode.ts'

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: COMMAND,
      description: 'Use a skill as a mode: /mode <skill> turns it on (or Option/Alt+Enter on /<skill>), /mode off turns it off, /mode lists skills',
      argumentHint: '[skill | off]',
      immediate: true,
    })
    await resumeMode($)
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      await clearMode($)
    }
    return next(e)
  })

  on('command.run', { command: COMMAND }, async ($, e) => {
    const arg = e.args.trim()
    if (arg === '') {
      const all = await listSkills($, { fresh: true })
      const { dirs, home } = await searchedFolders($)
      return { text: listing(await currentMode($), all, dirs, home) }
    }
    if (OFF_WORDS.includes(arg.toLowerCase())) {
      const r = await deactivate($)
      if (r.outcome === 'none') return { text: 'No mode is active.' }
      return {
        text: r.wasDelivered
          ? `**${r.name}** mode off. Your next message tells Claude to stop following it.`
          : `**${r.name}** mode off.`,
      }
    }
    return activationText(await activate($, arg, 'exact'), arg)
  }).catch(() => ({ text: 'skill-modes: /mode failed (see claude --debug).' }))

  on('prompt.submit', async ($, e, next) =>
    deliver($, e.command?.name, blocks => next(blocks ? { ...e, context: [...(e.context ?? []), ...blocks] } : e)),
  )

  on('session.compact', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    const note = await compactionNote($)
    if (note === null) return next(e)
    const res = await next({ ...e, instructions: e.instructions ? `${e.instructions}\n\n${note}` : note })
    if (e.trigger !== 'precompute' && 'messages' in res && res.messages) await compacted($)
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
    const s = await currentMode($)
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
            await deactivate($)
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
