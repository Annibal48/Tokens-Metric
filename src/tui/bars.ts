/**
 * Tiny visual helpers — no dependencies, just unicode block characters.
 */

const BAR_BLOCKS = ['', '▏', '▎', '▍', '▌', '▋', '▊', '▉', '█'];

/**
 * Render a horizontal bar of `width` cells filled to `ratio` (0..1) using
 * partial-block characters for sub-cell precision.
 */
export function bar(ratio: number, width: number): string {
  if (!Number.isFinite(ratio) || ratio < 0) ratio = 0;
  if (ratio > 1) ratio = 1;
  const total = ratio * width;
  const full = Math.floor(total);
  const remainder = total - full;
  const partialIdx = Math.round(remainder * 8);
  const partial = partialIdx > 0 ? BAR_BLOCKS[partialIdx] : '';
  const empty = Math.max(0, width - full - (partial ? 1 : 0));
  return '█'.repeat(full) + partial + ' '.repeat(empty);
}

const SPARK = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];

/**
 * Map a numeric series into a fixed-width sparkline. Auto-scales to the
 * series max. Returns empty cells when there's no data yet.
 */
export function sparkline(values: number[], width: number): string {
  return sparklineCells(values, width)
    .map((c) => c.char)
    .join('');
}

export interface SparkCell {
  char: string;
  /** 0..1 — fraction of the window's peak. 0 means empty/no data. */
  intensity: number;
}

/**
 * Per-cell version of `sparkline` so the caller can color each character
 * individually based on intensity.
 */
export function sparklineCells(values: number[], width: number): SparkCell[] {
  if (width <= 0) return [];
  const tail = values.slice(-width);
  const padded =
    tail.length < width ? Array(width - tail.length).fill(0).concat(tail) : tail;
  const max = Math.max(1, ...padded);
  return padded.map((v) => {
    if (v <= 0) return { char: ' ', intensity: 0 };
    const ratio = v / max;
    const idx = Math.min(SPARK.length - 1, Math.floor(ratio * (SPARK.length - 1)));
    return { char: SPARK[idx], intensity: ratio };
  });
}
