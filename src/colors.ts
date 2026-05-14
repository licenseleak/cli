// Tiny ANSI color helper. Honors NO_COLOR and disables when stdout is not a TTY.

const enabled =
  !process.env.NO_COLOR &&
  process.env.TERM !== "dumb" &&
  process.stdout.isTTY === true;

function wrap(open: number, close: number) {
  return (s: string | number): string =>
    enabled ? `\x1b[${open}m${s}\x1b[${close}m` : String(s);
}

export const c = {
  bold: wrap(1, 22),
  dim: wrap(2, 22),
  red: wrap(31, 39),
  green: wrap(32, 39),
  yellow: wrap(33, 39),
  blue: wrap(34, 39),
  magenta: wrap(35, 39),
  cyan: wrap(36, 39),
  gray: wrap(90, 39),
};

export function colorSeverity(sev: string): string {
  switch (sev) {
    case "critical":
      return c.bold(c.red(sev.toUpperCase()));
    case "high":
      return c.red(sev.toUpperCase());
    case "medium":
      return c.yellow(sev.toUpperCase());
    case "low":
      return c.blue(sev.toUpperCase());
    default:
      return c.gray(sev.toUpperCase());
  }
}
