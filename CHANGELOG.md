# Changelog

What changed in each release of `@aglowinthefield/impression`, for people who use it. pi shows the new entries once, at the first session after an update.

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
