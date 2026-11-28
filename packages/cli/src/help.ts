import { c, type CliHelp, paint } from "./cli-help.js";

// Every command `impression` lists, and its help. Adding a command means adding an entry here;
// help.test.ts checks that bin.ts routes exactly these, plus the internal ones in HIDDEN.

/** Routed by bin.ts but left out of help: agents and evals call them, people don't. */
export const HIDDEN = ["hook", "eval"];

const ID = "the id `impression list` prints, or enough of it to be unique";

// A pale cloud, like the GitHub app icon, in braille dots: white at the top, cyan underneath.
const CLOUD = [
  "⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⣀⣀⡀⠀⠀⠀⠀⠀⠀⠀",
  "⠀⠀⠀⠀⠀⠀⣠⠖⠋⠉⠓⠒⠋⠁⠀⠉⢷⡀⠀⠀⠀⠀⠀",
  "⠀⠀⠀⢀⣀⣰⠏⠀⠀⠀⠀⠀⠀⠀⠀⠀⠈⠓⠒⢦⡀⠀⠀",
  "⠀⠀⣴⠋⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⣿⠀⠀",
  "⠀⠀⣿⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⣿⠀⠀",
  "⠀⠀⠛⠒⠒⠒⠒⠒⠒⠒⠒⠒⠒⠒⠒⠒⠒⠒⠒⠒⠛⠀⠀",
];
const SHADES = ["97", "97", "37", "37", "36", "36"];

function banner(version?: string) {
  const beside = [
    "",
    "",
    c.bold("i m p r e s s i o n"),
    "Memory for coding agents.",
    version ? c.dim(version) : "",
    "",
  ];
  return CLOUD.map(
    (row, i) =>
      `  ${paint(SHADES[i] ?? "36")(row)}${beside[i] ? `   ${beside[i]}` : ""}`,
  ).join("\n");
}

export const help = (version?: string): CliHelp => ({
  bin: "impression",
  groups: ["Memories", "Account", "Install"],
  banner: () => banner(version),
  // Cyan like the cloud, commands plain, arguments blue.
  colors: { head: "1;36", cmd: "", arg: "34" },
  commands: [
    {
      name: "search",
      group: "Memories",
      args: "QUERY...",
      summary: "this project's memories that match",
      details:
        "Searches the memories for the repo you're in and your own, the way your agent's search tool does.",
      examples: [["impression search how do we run migrations", ""]],
    },
    {
      name: "add",
      group: "Memories",
      args: "TEXT...",
      full: "TEXT... [--user]",
      summary: "save a memory for this project",
      details:
        "The words after add become the memory. Agents in this repo get it from their next prompt that matches.",
      options: [["--user", "save it for you, in every project"]],
      examples: [
        ["impression add Run pnpm test before pushing", ""],
        ["impression add Prefer short commit messages --user", "every project"],
      ],
    },
    {
      name: "list",
      group: "Memories",
      summary: "this project's memories, newest 50",
      details:
        "One line each: id, scope (project or user), STALE when it may be out of date, and the text.",
    },
    {
      name: "edit",
      group: "Memories",
      args: "ID TEXT...",
      summary: "change a memory's text",
      details: `ID is ${ID}.`,
      examples: [
        ["impression edit 3f2a91c0 Run pnpm test:all before pushing", ""],
      ],
    },
    {
      name: "keep",
      group: "Memories",
      args: "ID",
      summary: "mark a possibly stale memory as still true",
      details: `Clears the STALE flag that \`impression list\` shows. ID is ${ID}.`,
    },
    {
      name: "retire",
      group: "Memories",
      args: "ID",
      summary: "stop agents getting a memory",
      details: `Retired memories aren't extracted again. ID is ${ID}.`,
    },
    {
      name: "backfill",
      group: "Memories",
      full: "[--since DATE] [--limit N] [--agents LIST] [--repo PATH] [--yes] [--dry-run] [--undo]",
      summary: "learn this repo's memories from your past sessions",
      details:
        "Finds this repo's past pi, Claude Code and Codex sessions, including ones run in its subdirectories and worktrees, and shows how many sessions and pieces it would send and what that would cost before it sends anything. It sends nothing until you say yes.\nBy default it takes the sessions that started in the last 30 days, at most 50, newest kept. It skips sessions your agents already sent, sessions changed in the last hour, and pieces a backfill already extracted, so running it again only sends what is new. Backfill has a budget on the server; a run that would pass it sends the oldest pieces that fit.\nIt prints a line per piece. If it stops midway, run it again to send the rest. impression status shows a backfill's progress while it runs.",
      options: [
        ["--since DATE", "sessions that started on or after this date"],
        ["--limit N", "at most this many sessions, newest kept (default 50)"],
        ["--agents LIST", "agents to read, comma-separated: pi, claude, codex"],
        ["--repo PATH", "the repo to backfill (default: the one you're in)"],
        ["-y, --yes", "send without asking"],
        ["--dry-run", "show the plan, send nothing"],
        ["--undo", "retire every memory a backfill made in this repo"],
      ],
      examples: [
        ["impression backfill", "see the plan, then confirm"],
        [
          "impression backfill --since 2026-09-01 --limit 100",
          "a wider window",
        ],
        ["impression backfill --undo", ""],
      ],
    },
    {
      name: "login",
      group: "Account",
      full: "[--github] [--url URL] [--token TOKEN]",
      summary: "sign in to an Impression server",
      details:
        "Checks the saved sign-in, and signs in with GitHub when there is none or the server refuses it. GitHub sign-in prints a code and opens the page to enter it.",
      options: [
        ["--github", "sign in with GitHub even when the saved sign-in works"],
        [
          "--url URL",
          "the server (default: the saved one, or https://impression.quest)",
        ],
        ["--token TOKEN", "sign in with an API token instead"],
      ],
      examples: [
        ["impression login", ""],
        [
          "impression login --url http://localhost:3000 --token imp_...",
          "your own server",
        ],
      ],
    },
    {
      name: "status",
      group: "Account",
      summary: "the server, your sign-in and this repo's project",
      details:
        "Also says how many memories may be stale, and warns when Impression can't reach this repo, which means its sessions won't be saved. While a backfill runs in this repo it shows its progress, and once more after it finishes.",
    },
    {
      name: "dashboard",
      group: "Account",
      summary: "open this project on the dashboard",
      details: "Prints the URL too, so it works over SSH.",
    },
    {
      name: "setup",
      group: "Install",
      full: "[--agent LIST] [--yes] [--dry-run]",
      summary: "install Impression into your agents",
      details:
        "Signs you in if needed, asks which of the agents it found (Claude Code, pi, Codex, oh-my-pi) should use Impression, and installs each one's plugin. When the impression command isn't on your PATH it offers to install it. Run in a git repo with past sessions, it ends by offering to backfill them in the background.\nIt backs up each file it changes and is safe to run again.",
      options: [
        [
          "--agent LIST",
          "agents to set up, comma-separated: claude, pi, codex, omp",
        ],
        ["-y, --yes", "set up every agent found, without asking"],
        ["--dry-run", "say what would change, write nothing"],
      ],
      examples: [
        ["impression setup", "answer a few questions"],
        ["impression setup --agent claude,pi --yes", ""],
      ],
    },
    {
      name: "update",
      group: "Install",
      summary: "update the impression command",
      details:
        "Runs npm i -g @aglowinthefield/impression@latest. Each agent updates its plugin itself.",
    },
    {
      name: "help",
      group: "Install",
      args: "[COMMAND]",
      summary: "this overview, or one command's options",
    },
  ],
  options: [
    ["-h, --help", "help for the command before it"],
    ["-v, --version", "print the version"],
  ],
  env: [
    ["IMPRESSION_URL", "the server, over the saved one"],
    ["IMPRESSION_TOKEN", "the API token, over the saved one"],
    [
      "IMPRESSION_NO_UPDATE_CHECK=1",
      "skip the daily check for a newer version",
    ],
    ["NO_COLOR", "plain text on a terminal"],
  ],
});
