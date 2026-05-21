# Security policy

## Reporting a vulnerability

If you find a security issue in `tokens-metric` — anything that could leak credentials, run unintended code on a user's machine, or otherwise compromise a Claude Code installation — please **do not open a public issue**.

Instead, open a private security advisory on GitHub:

https://github.com/Annibal48/Tokens-Metric/security/advisories/new

Include:

1. A clear description of the issue and its impact.
2. Steps to reproduce, or a proof of concept.
3. The version of `tokens-metric` you observed it in (`tokens-metric --help`).
4. Your OS, Node version, and Claude Code version if relevant.

You can expect an initial acknowledgement within a few days. Critical issues will be patched and released as a new version on npm; the original report stays private until a fix ships.

## Scope

In scope:

- Anything in this repository's source code.
- The published `tokens-metric` package on npm.
- Information disclosure via the TUI or statusline output (paths, credentials, IDs).

Out of scope:

- Vulnerabilities in upstream dependencies (`ink`, `react`, Node itself). Report those to their respective maintainers.
- Issues that require an attacker to already have write access to the user's home directory or `~/.claude/`. We treat that level of access as game-over outside of our threat model.
- Claude Code itself. Report those to Anthropic directly.

## Threat model

`tokens-metric` reads local files under `~/.claude/projects/` and `~/.claude.json` belonging to the user running it. It does **not**:

- Make network requests.
- Write to disk.
- Execute user-controlled commands.
- Forward credentials anywhere.

If a future change introduces any of those behaviors, that is itself a security-relevant change and should be reviewed carefully.
