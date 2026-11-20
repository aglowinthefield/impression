# Changelog

What changed in each release of `@aglowinthefield/impression`, for people who use it. pi shows the new entries once, at the first session after an update.

## 0.9.0

- You can see Impression at work. pi and oh-my-pi show how many memories the agent got this session in the footer. Claude Code and Codex say how many it got at session start and when a prompt matches more.
- Each memory on the dashboard says how often it reached your agents and when it last did, or that it hasn't been used yet.
- The Get started page has a "See it at work" section, including a question to ask your agent about what Impression knows.

## 0.8.0

- impression.quest has a Get started page at /start: what Impression does, the steps to set it up, what leaves your machine, and how to remove it. The sign-in page links to it.
- Until your first memory arrives, the dashboard shows your setup steps and ticks them off as they happen.
- At session start, your agent tells you when Impression is on but has nothing for this repo yet, when it can't reach the repo (so the session won't be saved), or when it isn't signed in. pi and oh-my-pi show it as a notice; Claude Code and Codex as a message.
- `impression status` warns when the current repo's sessions can't be saved.
- The dashboard header has Help and Feedback links. Settings explains the extraction threshold in plain words and says how to delete your data.
- The GitHub sign-in pages match the dashboard, and the Debug tab is only shown to server admins.

## 0.7.0

- `impression setup` asks which agents should use Impression, with every agent it found selected, and installs the Claude Code and Codex plugins itself. You no longer paste their plugin commands.
- `impression setup --agent claude,omp` picks agents without asking, and `--yes` takes every agent found. `--only` still works.

## 0.6.0

- `impression setup` signs you in with GitHub when you aren't signed in yet, so `npx @aglowinthefield/impression setup` is the whole install for oh-my-pi.
- For oh-my-pi, `impression setup` also runs `omp install` for you.
- pi no longer shows what changed in an update twice.
- When GitHub sign-in in the CLI stops because the Impression GitHub app isn't installed, the message includes the install link.

## 0.5.0

- Impression works in oh-my-pi (`omp`). Install it with `omp install npm:@aglowinthefield/impression`, then run `impression setup --only omp` to add the search and add tools.
- pi sends the last part of a session in the background when you exit, so quitting no longer waits on it.
- Dashboard pages fade in as they load.

## 0.4.0

- The dashboard shows all your repos by default. Each page has a repo filter in place of the project dropdown, and repos with no memories are left out.
- Memory text renders as Markdown in the dashboard.
- Pinning is gone. `impression add` no longer takes `--pin`, and memory cards no longer have Pin, Share with team or Edit.
- The dashboard background is lighter and easier to read.

## 0.3.1

- The dashboard has an Activity tab: every change to your memories, newest first, with why it happened and an undo. It replaces the Review and Evals tabs.
- pi now runs the staleness check at session start, like Claude Code and Codex.

## 0.3.0

- Extracted memories go live without review, and the staleness check keeps, rewrites or retires memories whose code has changed.
- Memories are grouped into concepts on a schedule, and the dashboard can browse by concept.
- Each memory is filed under the repo it is about, not only the one the session ran in.
- `impression dashboard` opens the dashboard for the current project.
- `impression login --github` opens GitHub's device page for you.
- The dashboard puts the project in the URL, opens on your last active project, and shows where each token was last used.
