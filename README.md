# tokens-metric

Real-time token usage meter for [Claude Code](https://claude.com/claude-code) — a terminal UI plus a one-line statusline you can wire into Claude Code itself.

It tails the transcripts Claude Code writes under `~/.claude/projects/**/*.jsonl`, aggregates the `usage` field of each message in-memory, and renders it live. No API calls, no telemetry.

## What it shows

### TUI (tab navigation)

- **Session status bar** — always visible: model, total tokens, estimated cost, message count, time since session start, mini activity sparkline, live/idle indicator.
- **[1] Breakdown** — input / output / cache-write / cache-read token bars with percentages and per-category cost estimates, cache hit ratio, per-model totals, and a 32-second activity sparkline with peak/avg rate.
- **[2] History** — today / 7-day / 30-day aggregate: tokens, estimated cost, session count, top model. Data is persisted locally in `~/.tokens-metric/history.json` so historical totals survive transcript rotation.
- **[3] Sessions** — today's sessions sorted by start time: project path, model, tokens, cost, duration, active indicator.
- **[4] Transcripts** — last five transcript files with recency timestamps.
- **Update notifier** — checks npm once every 24 h (cached) and shows a banner when a newer version is available.

### Statusline

A compact one-line output for embedding in Claude Code's status bar.

## Install

```bash
npm install -g tokens-metric
```

Or run without installing:

```bash
npx tokens-metric
```

Requires **Node 18+** and an existing Claude Code installation.

## Usage

### TUI

```bash
tokens-metric
```

| Key | Action |
|-----|--------|
| `←` / `→` | Move cursor between tabs |
| `Enter` | Open / collapse the focused tab |
| `1` – `4` | Jump directly to a tab and open it |
| `Esc` | Collapse the open panel |
| `q` / `Ctrl-C` | Quit |

### Privacy defaults

Starting in v0.2.0 the TUI masks identifying information by default so screenshots can be shared safely:

- `cwd` paths are shown as `~/…` instead of `/Users/<you>/…`.
- The user ID is masked to `●●●●●●●●`.

Pass `--reveal` to show everything unmasked:

```bash
tokens-metric --reveal
```

### Statusline inside Claude Code

Add to `~/.claude/settings.json`:

```json
{
  "statusLine": {
    "type": "command",
    "command": "tokens-metric-statusline"
  }
}
```

Output looks like:

```
🏢 team opus-4-7 │ in 117 · out 43.5k · cache 3.21M │ Σ 3.25M · ~$12.29 API-eq
```

## Honest limitations

1. **Plan tier is heuristic.** We read flags Claude Code writes locally (e.g. `opusProMigrationComplete`). Anthropic can rename these at any release; the detector falls back to `unknown` instead of breaking.
2. **Pro vs. Max are not distinguishable locally.** Both look identical from the config file.
3. **The USD figure is API-equivalent pricing, not what you actually pay.** On Pro/Max/Team you pay a flat subscription — the dollar number is purely a reference for what the same tokens would cost on the API.
4. **Prices are hardcoded.** See `src/core/format.ts`. If Anthropic updates pricing, the numbers drift until you bump the package.
5. **The transcript format is not a public API.** It works today; it may shift. The parser is intentionally tolerant of unexpected shapes.

## How it works

```
~/.claude/projects/<encoded-cwd>/<session-id>.jsonl
                 │
                 ▼
        src/core/parser.ts        reads + aggregates usage per message
        src/core/tailer.ts        watches the active file with fs.watch
        src/core/detect.ts        reads ~/.claude.json for auth + plan hints
        src/core/history.ts       per-day aggregation with mtime-based cache
        src/core/history-store.ts persists daily aggregates to ~/.tokens-metric/
        src/core/updater.ts       npm version check, 24h cache
                 │
        ┌────────┴────────┐
        ▼                 ▼
  src/tui (Ink)     src/statusline
```

## Development

```bash
git clone https://github.com/Annibal48/Tokens-Metric.git
cd Tokens-Metric
npm install
npm run dev:tui          # hot-runs the TUI from sources
npm run dev:statusline   # prints one line
npm run build            # builds dist/
```

## Roadmap

- **Windows support** — Claude Code on Windows stores transcripts in a different location (`%APPDATA%\Claude\`). This requires abstracting `claudeHome()` in `detect.ts` to resolve the correct path per OS, and handling Windows path separators in project folder names.

- **Multi-provider support (Codex, Gemini, etc.)** — The pricing table in `format.ts` currently covers Claude models only. Adding other providers means extending the table with `gpt-*`, `gemini-*`, `o1-*` prefixes, investigating whether those agents produce compatible `.jsonl` transcripts, and likely allowing the user to point to additional transcript folders.

- **Context window usage** — Show how much of the active session's context window is consumed. Claude Code may log this in the transcript; if not, it can be inferred per model (e.g. claude-3.5-sonnet = 200k tokens). Would appear as a progress bar in the session status bar or breakdown panel.

## License

MIT — see [LICENSE](./LICENSE).
