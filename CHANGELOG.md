# Changelog

What changed in each release of `@aglowinthefield/impression`, for people who use it. pi shows the new entries once, at the first session after an update.

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
