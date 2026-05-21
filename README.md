# tokens-metric

Real-time token usage meter for [Claude Code](https://claude.com/claude-code) — a terminal UI plus a one-line statusline you can wire into Claude Code itself.

It tails the transcripts Claude Code writes under `~/.claude/projects/**/*.jsonl`, aggregates the `usage` field of each message in-memory, and renders it live. No API calls, no telemetry.

## What it shows

- **Active session**: model, message count, time since last event, total tokens, equivalent API cost, tokens-per-minute rate, and an activity sparkline.
- **Breakdown**: input / output / cache-write / cache-read tokens with proportional bars, plus per-model totals.
- **Plan detection** (best-effort, local-only): API key vs. OAuth subscription, and a hint between Free, Pro/Max, or Team/Enterprise, inferred from flags in `~/.claude.json`.
- **Recent transcripts**: last five sessions across all your projects.

## Install

```bash
npm install -g tokens-metric
```

Or run without installing:

```bash
npx tokens-metric
```

Requires Node 18+ and an existing Claude Code installation.

## Usage

### TUI

```bash
tokens-metric
```

Press `q` (or `Esc`, or `Ctrl-C`) to quit.

### Privacy defaults

Starting in v0.2.0, the TUI masks identifying information by default so screenshots can be shared safely:

- `cwd` paths are shown as `~/…` instead of `/Users/<you>/…`.
- The user ID is masked to `●●●●●●●●`.

Pass `--reveal` to show everything unmasked on your own machine:

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

1. **Plan tier is heuristic.** We read flags Claude Code writes locally (e.g. `opusProMigrationComplete`, `cachedExtraUsageDisabledReason`). Anthropic can rename these at any release; if they change, the detector falls back to `unknown` instead of breaking.
2. **Pro vs. Max are not distinguishable locally.** Both look identical from the config file.
3. **The USD figure is API-equivalent pricing, not what you actually pay.** On Pro/Max/Team you pay a flat subscription — the dollar number is purely a reference for what the same tokens would cost on the API.
4. **Prices are hardcoded.** See `src/core/format.ts`. If Anthropic updates pricing, the numbers drift until you bump the package.
5. **The transcript format is not a public API.** It works today; it may shift. The parser is intentionally tolerant of unexpected shapes.

## How it works

```
~/.claude/projects/<encoded-cwd>/<session-id>.jsonl
                 │
                 ▼
        src/core/parser.ts      reads + aggregates usage per message
        src/core/tailer.ts      watches the active file with fs.watch
        src/core/detect.ts      reads ~/.claude.json for auth + plan hints
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

## License

MIT — see [LICENSE](./LICENSE).
