export type SkillModesActive = {
  name: string
  description: string
  path: string
  dir: string
  scope: 'project' | 'user' | 'plugin'
  icon: string | null
  color: string | null
}
export type SkillModesExit = { name: string; path: string; reason: 'user' | 'switch' | 'missing' }
export type SkillModesState = {
  active: SkillModesActive | null
  /** non-null: the next message carries the full skill body. 'enter' = never delivered yet */
  pendingAttach: 'enter' | 'reattach' | null
  /** non-null: the next message tells the agent to stop following this skill */
  pendingExit: SkillModesExit | null
}
declare module 'claude-code' {
  interface PluginState {
    'skill-modes': { mode: Shaped<SkillModesState> }
  }
}
