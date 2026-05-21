export interface CliOpts {
  reveal: boolean;
  help: boolean;
}

export function parseArgs(argv: readonly string[]): CliOpts {
  const args = argv.slice(2);
  return {
    reveal: args.includes('--reveal'),
    help: args.includes('--help') || args.includes('-h'),
  };
}

export const HELP_TEXT = `tokens-metric — real-time Claude Code token meter

Usage:
  tokens-metric [--reveal] [--help]
  tokens-metric-statusline [--reveal]

Options:
  --reveal     Show the full user ID and the unredacted cwd. By default these
               are masked so screenshots don't expose identifying info.
  -h, --help   Show this help.

Privacy:
  By default the UI shows ~/… instead of /Users/<you>/… and masks the user ID
  to "●●●●●●●●". Pass --reveal to disable masking on your own machine.
`;
