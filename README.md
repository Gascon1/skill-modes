# skill-modes

Cursor's "skill as Custom Mode" for Claude Code. Turn any skill into a mode that stays on for every message until you turn it off.

## Install

At the prompt of a terminal session:

```
/plugin install skill-modes --marketplace Gascon1/skill-modes
```

Press `y` to add the marketplace, then pick a scope. From a shell:

```
claude plugin install skill-modes --marketplace Gascon1/skill-modes
```

## Usage

- `/mode` lists the skills you can use as a mode.
- `/mode <skill>` turns a skill on. Switching to another skill leaves the first.
- `/mode off` (also `exit`, `none`, `stop`) turns the mode off.
- Option/Alt+Enter on a draft that is only `/<skill>` or `/mode <tok>` turns the mode on without sending anything. The token can be a unique prefix of the skill name or folder; if it matches several skills you get a toast listing them. (`/mode <skill>` itself needs the exact name or folder.)
- While a mode is on, a band above the prompt shows the skill (its `icon` and `color` frontmatter are used if set) with an **Exit mode** button.
- Autocomplete: `/mode ` suggests `off` and skill names; typing `/<prefix>` suggests `/mode <skill>`.

## How it works

- The first message after you turn a mode on carries the full `SKILL.md` as extra context, with its path and directory.
- Every later message carries a short reminder naming the skill and its path.
- When you exit or switch, the next message carries an explicit notice to stop following the skill. If the skill file is deleted, the mode ends with a toast.
- After compaction the full skill is attached again on the next message, and the compaction summary is told the mode is on.
- Subagents are unaffected: nothing is attached for them and the band is not shown in their views.
- The mode persists across `--resume` (state is stored per session). `/clear` resets it.
- Edits to `SKILL.md` are picked up on the next message.

## Where skills are found

- Project: `.claude/skills/<name>/SKILL.md` in the working directory and the session root, and in each ancestor folder up to (not including) `$HOME`.
- User: `~/.claude/skills`, or `$CLAUDE_CONFIG_DIR/skills`.
- Plugin: skills of installed plugins that are enabled here (and account-synced plugins), named `<plugin>:<skill>`. `/mode tdd` or `/tdd` + Option/Alt+Enter also finds `mattpocock-skills:tdd` when no project or user skill has that name.
- A skill needs `name` and `description` in its frontmatter; others are listed by `/mode` as not usable. On a name clash the first found wins (project before user).

## Terminal notes for Option/Alt+Enter

- macOS Terminal: enable Profiles → Keyboard → "Use Option as Meta key".
- iTerm2: set Left Option key to "Esc+" (Profiles → Keys).
- VS Code terminal: set `terminal.integrated.macOptionIsMeta` to `true`.
- Windows Terminal: Alt+Enter is bound to fullscreen. Unbind it under Settings → Actions, or add `{ "command": "unbound", "keys": "alt+enter" }` to your actions.
- Still nothing? Run `claude --debug`, press Option/Alt+Enter on `/<skill>`, and look in the debug log for `skill-modes: prompt.edit not taken as Alt+Enter`: it shows the key your terminal sent. No such line means the key never reached the prompt as an edit.

## Known limits

- The highlighted autocomplete row is not detectable. When `/<prefix>` matches several skills, Option/Alt+Enter picks the one you use most (usage decayed by age, from `skillUsage` in `~/.claude.json`), which is how the typeahead ranks them too. A tie is refused as ambiguous.
- The `prompt.edit` hook used for Option/Alt+Enter may be terminal-only; `/mode <skill>` works everywhere.
- No tool or model gating (the skill's `allowed-tools` and model settings are not applied), matching Cursor.

## Development

```
claude plugin validate .
claude plugin test .
claude --plugin-dir .
```
