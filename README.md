# tokens-metric

Real-time token usage meter for [Claude Code](https://claude.com/claude-code) and [OpenAI Codex CLI](https://github.com/openai/codex) — a terminal UI plus a one-line statusline you can wire into Claude Code itself.

It tails the transcripts both tools write to disk, aggregates usage in-memory, and renders it live. No API calls, no telemetry.

| Source | Transcript path |
|--------|----------------|
| Claude Code | `~/.claude/projects/**/*.jsonl` |
| Codex CLI | `~/.codex/sessions/YYYY/MM/DD/*.jsonl` |

## What it shows

### Always-visible status bars

One bar per active source, always on screen regardless of which panel is open:

```
● sonnet-4-6  ·  33.4M tok  ·  ~$23.21  ·  351 msgs  ·  since 17:23  ● live  2s ago
● codex       ·  236M tok   ·  ~$165.35 ·  896 msgs  ·  since 18:19  ○ idle  3m ago
```

### [1] Breakdown

- Input / output / cache-write / cache-read bars with percentages and per-category cost
- Cache hit ratio with quality rating (excellent / degraded / poor)
- Context window fill gauge for the last turn
- Per-model totals when multiple models were used in a session
- 32-second activity sparkline with peak and avg rate
- **30-minute timeline chart** — vertical bar chart, one bucket per minute, stacked cyan (Claude) / magenta (Codex), oldest bars dimmed, current minute highlighted

### [2] History

Today / 7-day / 30-day aggregate: tokens, estimated cost, session count. Dual bar chart (Claude vs Codex) for the last 7 days. Data persisted in `~/.tokens-metric/history.json` so totals survive transcript rotation.

### [3] Sessions

Today's sessions sorted by start time. Navigate with `↑↓` — the selected session expands an inline detail panel showing per-category token bars, percentages, and cost breakdown.

### [4] Transcripts

Last five transcript files with recency timestamps.

### Header

```
● Claude Code detected   ·   ● Codex detected   ·   4 sessions · 3 projects today
```

Codex detection dot is green when `~/.codex/` exists, red when not installed.

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

Requires **Node 18+**. Claude Code and/or Codex CLI must be installed for data to appear.

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
| `↑` / `↓` | Navigate sessions (while Sessions tab is open) |
| `Esc` | Collapse the open panel |
| `q` / `Ctrl-C` | Quit |

### Privacy defaults

Paths are masked by default so screenshots can be shared safely:

- `cwd` paths shown as `~/…` instead of `/Users/<you>/…`
- User IDs masked to `●●●●●●●●`

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

## Pricing

Costs are estimated at **API-equivalent pricing** — a reference figure, not what you pay on Pro/Max/Team subscriptions.

| Provider | Models |
|----------|--------|
| Anthropic | claude-opus-4, claude-sonnet-4, claude-haiku-3.5, and prior generations |
| OpenAI | o4-mini, o3, o3-mini, gpt-4o, gpt-4o-mini (via Codex CLI) |

Prices are hardcoded in `src/core/format.ts`. Update the package when providers change their rates.

## Honest limitations

1. **Plan tier is heuristic.** We read flags Claude Code writes locally. Anthropic can rename these at any release; the detector falls back to `unknown`.
2. **Pro vs. Max are not distinguishable locally.** Both look identical from config.
3. **The transcript format is not a public API.** It works today; it may shift. The parser is intentionally tolerant of unexpected shapes.
4. **Codex CLI model key is always `codex`.** The JSONL does not include a specific model name, so all Codex usage is priced at o4-mini rates.

## How it works

```
~/.claude/projects/<encoded-cwd>/<session>.jsonl   ~/.codex/sessions/YYYY/MM/DD/<session>.jsonl
                        │                                          │
                        └──────────────┬───────────────────────────┘
                                       ▼
                          src/core/parser.ts      reads + aggregates usage per message
                          src/core/tailer.ts      watches active files with fs.watch
                          src/core/detect.ts      auth, plan hints, Codex detection
                          src/core/history.ts     per-day aggregation, mtime cache
                          src/core/history-store  persists daily totals to ~/.tokens-metric/
                          src/core/updater.ts     npm version check, 24h cache
                                       │
                          ┌────────────┴────────────┐
                          ▼                         ▼
                    src/tui (Ink)            src/statusline
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

- **Windows support** — Claude Code on Windows stores transcripts under `%APPDATA%\Claude\`. Requires abstracting `claudeHome()` in `detect.ts` and handling Windows path separators.

## License

MIT — see [LICENSE](./LICENSE).
