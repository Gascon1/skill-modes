# Security policy

skill-modes runs inside Claude Code and reads `SKILL.md` files from your project, user and plugin skill folders, then attaches their text to your prompts. A bug that leaks file contents, attaches a file that is not a skill, or lets a crafted skill escape its folder is a security issue.

## Reporting a vulnerability

Please do not open a public issue. Report it privately through GitHub: the repository's **Security** tab → **Report a vulnerability**.

Include the version (`plugin.json`), your OS and terminal, and steps to reproduce. You should hear back within a week.

## Supported versions

Only the latest release gets fixes.
