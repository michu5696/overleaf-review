/**
 * Overleaf range positions are character offsets into the flattened document
 * text (`lines.join("\n")`). These helpers turn an offset into a line number
 * and a readable snippet of surrounding context.
 */

export function offsetToLine(lines: string[], offset: number): number {
  let remaining = offset;
  for (let i = 0; i < lines.length; i++) {
    const len = lines[i].length;
    if (remaining <= len) return i;
    remaining -= len + 1; // account for the "\n"
  }
  return Math.max(0, lines.length - 1);
}

/** A few lines around `line`, with the anchored line marked by `>`. */
export function lineContext(lines: string[], line: number, radius = 1): string {
  const start = Math.max(0, line - radius);
  const end = Math.min(lines.length - 1, line + radius);
  const out: string[] = [];
  for (let i = start; i <= end; i++) {
    out.push(`${i === line ? '>' : ' '} ${String(i + 1).padStart(3)}  ${lines[i]}`);
  }
  return out.join('\n');
}
