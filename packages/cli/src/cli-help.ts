// House CLI help, shared in shape with bakery-cli and unconscious (house-style's references/cli.md).
// Layout and colour only on a terminal, so agents and scripts that capture the output get plain
// text. NO_COLOR drops the colour but keeps the layout; FORCE_COLOR wins over both.

export interface CommandHelp {
  name: string;
  group: string;
  /** Arguments shown in the overview, e.g. `ID TEXT...`. */
  args?: string;
  /** Lowercase, no full stop: what the command does or shows. */
  summary: string;
  /** Every argument and option, for the command's usage line. Defaults to `args`. */
  full?: string;
  /** Paragraphs separated by \n. */
  details?: string;
  options?: [flag: string, what: string][];
  examples?: [command: string, what: string][];
}

export interface CliHelp {
  /** The command people type. */
  bin: string;
  groups: readonly string[];
  commands: CommandHelp[];
  /** Options every command takes, listed after the commands. */
  options?: [flag: string, what: string][];
  env?: [name: string, what: string][];
  /** Shown above the overview on a terminal. */
  banner?: () => string;
  /** Closing line of the overview. */
  footer?: string;
}

type Stream = { isTTY?: boolean; columns?: number };
const env = () => process.env;
const forced = () =>
  env().FORCE_COLOR !== undefined && env().FORCE_COLOR !== "";
export const pretty = (stream: Stream = process.stdout) =>
  forced() ? env().FORCE_COLOR !== "0" : Boolean(stream.isTTY);
export const useColor = (stream: Stream = process.stdout) =>
  forced()
    ? env().FORCE_COLOR !== "0"
    : Boolean(stream.isTTY) && !env().NO_COLOR;

export const paint =
  (code: string, stream: Stream = process.stdout) =>
  (text: string) =>
    useColor(stream) ? `\x1b[${code}m${text}\x1b[0m` : text;

// The terminal's own 16 colours, so its theme picks shades that read on light and dark.
export const c = {
  bold: paint("1"),
  dim: paint("2"),
  head: paint("1;35"),
  cmd: paint("35"),
  arg: paint("33"),
  ok: paint("32"),
  warn: paint("33"),
  bad: paint("31"),
  info: paint("36"),
};

// oxlint-disable-next-line no-control-regex
const visible = (text: string) => text.replace(/\x1b\[[\d;]*m/g, "");
export const pad = (text: string, width: number) =>
  text + " ".repeat(Math.max(1, width - visible(text).length));
export const columns = () =>
  process.stdout.columns || Number(env().COLUMNS) || 80;

export function wrap(text: string, width: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (line && line.length + word.length + 1 > width) {
      lines.push(line);
      line = word;
    } else line = line ? `${line} ${word}` : word;
  }
  if (line) lines.push(line);
  return lines;
}

/** Two columns: yellow flags or names, wrapped descriptions. */
function table(rows: [string, string][]): string[] {
  const w = Math.max(...rows.map((row) => row[0].length)) + 2;
  return rows.flatMap(([a, b]) =>
    wrap(b, Math.max(30, columns() - w - 2)).map((line, i) =>
      i ? " ".repeat(w + 2) + line : `  ${c.arg(pad(a, w))}${line}`,
    ),
  );
}

const signature = (cmd: CommandHelp) =>
  `${cmd.name}${cmd.args ? ` ${cmd.args}` : ""}`;

/** `tool`, `tool help`, `tool --help`: the banner, then every command by group. */
export function overview(cli: CliHelp): string {
  const width =
    Math.max(...cli.commands.map((cmd) => signature(cmd).length)) + 2;
  const out: string[] = [];
  if (cli.banner && pretty()) out.push("", cli.banner(), "");
  out.push(
    `${c.head("Usage")}  ${cli.bin} ${c.cmd("<command>")} ${c.arg("[options]")}`,
  );
  for (const group of cli.groups) {
    out.push("", c.head(group));
    for (const cmd of cli.commands.filter((item) => item.group === group)) {
      const sig = signature(cmd);
      const [first, ...more] = wrap(
        cmd.summary,
        Math.max(30, columns() - width - 2),
      );
      out.push(
        `  ${c.cmd(cmd.name)}${c.arg(pad(sig.slice(cmd.name.length), width - cmd.name.length))}${first}`,
      );
      for (const line of more) out.push(" ".repeat(width + 2) + line);
    }
  }
  if (cli.options?.length)
    out.push("", c.head("Options"), ...table(cli.options));
  if (cli.env?.length) out.push("", c.head("Environment"), ...table(cli.env));
  out.push(
    "",
    `  ${cli.footer ?? `${cli.bin} help <command> for its options and examples.`}`,
  );
  return out.join("\n");
}

/** `tool help <command>`, `tool <command> --help`. Undefined for an unknown command. */
export function commandHelp(cli: CliHelp, name: string): string | undefined {
  const cmd = cli.commands.find((item) => item.name === name);
  if (!cmd) return undefined;
  const full = cmd.full ?? cmd.args;
  const out = [
    `${c.cmd(`${cli.bin} ${cmd.name}`)}  ${cmd.summary}`,
    "",
    c.head("Usage"),
    `  ${cli.bin} ${cmd.name}${full ? ` ${c.arg(full)}` : ""}`,
  ];
  if (cmd.details)
    out.push(
      "",
      ...cmd.details
        .split("\n")
        .flatMap((para, i) => [
          ...(i ? [""] : []),
          ...wrap(para, Math.min(columns(), 100) - 4).map(
            (line) => `  ${line}`,
          ),
        ]),
    );
  if (cmd.options?.length)
    out.push("", c.head("Options"), ...table(cmd.options));
  if (cmd.examples?.length) {
    const w = Math.max(...cmd.examples.map((row) => row[0].length)) + 3;
    out.push(
      "",
      c.head("Examples"),
      ...cmd.examples.map(
        ([ex, what]) =>
          `  ${c.dim("$")} ${what ? pad(ex, w) + c.dim(`# ${what}`) : ex}`,
      ),
    );
  }
  return out.join("\n");
}

/** One command's usage line, for argument errors. */
export function usageLine(cli: CliHelp, name: string): string {
  const cmd = cli.commands.find((item) => item.name === name);
  const full = cmd?.full ?? cmd?.args;
  return cmd ? `Usage: ${cli.bin} ${cmd.name}${full ? ` ${full}` : ""}` : "";
}

/** The closest command name, for a typo. */
export function suggest(cli: CliHelp, name: string): string | undefined {
  const distance = (a: string, b: string) => {
    let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
    for (let i = 1; i <= a.length; i++) {
      const row = [i];
      for (let j = 1; j <= b.length; j++)
        row[j] = Math.min(
          (prev[j] ?? 0) + 1,
          (row[j - 1] ?? 0) + 1,
          (prev[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1),
        );
      prev = row;
    }
    return prev[b.length] ?? 0;
  };
  const best = cli.commands
    .map((cmd) => ({ name: cmd.name, d: distance(name, cmd.name) }))
    .sort((a, b) => a.d - b.d)[0];
  return best && best.d <= Math.max(2, Math.floor(name.length / 3))
    ? best.name
    : undefined;
}

/** The message for a command the CLI doesn't know. */
export const unknownCommand = (cli: CliHelp, name: string) => {
  const near = suggest(cli, name);
  return `${cli.bin}: Unknown command: ${name}.${near ? ` Did you mean ${near}?` : ""} Run ${cli.bin} help to see them all.`;
};
