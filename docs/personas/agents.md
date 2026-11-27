---
domain: agents
owner: aglowinthefield
status: confirmed
---

## Scope

How Impression runs inside each coding agent: the pi extension in `packages/pi`, which oh-my-pi (omp) also loads, the Claude Code and Codex plugins and their hooks, the CLI's `impression hook` commands, how the MCP server starts, `impression setup` and `login`, the upload of a transcript from the agent to the API, and project identity from a working directory.

Which memories an agent gets belongs to retrieval. What happens to a transcript once the API has it belongs to memories.

## Invariants

What this domain refuses. Each id is written in full as `agents/I1` elsewhere. Ids are permanent; a retired invariant keeps its id out of use.

| Id | Rule | Sources |
|---|---|---|
| I1 | An integration never breaks, blocks or errors the agent's session. Every failure in a hook, the extension or an upload ends quietly with no context, because the person's work doesn't depend on Impression. | [hook.ts:31](https://github.com/aglowinthefield/impression/blob/main/packages/cli/src/hook.ts#L31)<br>[session-end.ts:264](https://github.com/aglowinthefield/impression/blob/main/packages/cli/src/session-end.ts#L264)<br>[impression.ts:93](https://github.com/aglowinthefield/impression/blob/main/packages/pi/impression.ts#L93) |
| I2 | Work on the path to the agent's reply is time-boxed. The per-prompt search gives up after 2 s, and prompts under 15 characters skip it, so a slow server costs each prompt at most 2 s. | [impression.ts:118](https://github.com/aglowinthefield/impression/blob/main/packages/pi/impression.ts#L118)<br>[impression.ts:283](https://github.com/aglowinthefield/impression/blob/main/packages/pi/impression.ts#L283)<br>[hook-run.ts:101](https://github.com/aglowinthefield/impression/blob/main/packages/cli/src/hook-run.ts#L101) |
| I3 | Session upload and extraction run in a detached process that outlives the agent, on a copy of the transcript. Agents give exit handlers one or two seconds (omp gives 2 s), and pi deletes the transcript or keeps appending to it. | [hook-run.ts:130](https://github.com/aglowinthefield/impression/blob/main/packages/cli/src/hook-run.ts#L130)<br>[impression.ts:68](https://github.com/aglowinthefield/impression/blob/main/packages/pi/impression.ts#L68) |
| I4 | Exactly one integration acts in each agent. Every hook names its agent with `--agent` and does nothing without it or in another host, setup removes what earlier versions wrote, and the API stores a chunk sent twice once. | [hook-run.ts:51](https://github.com/aglowinthefield/impression/blob/main/packages/cli/src/hook-run.ts#L51)<br>[hook-io.ts:28](https://github.com/aglowinthefield/impression/blob/main/packages/cli/src/hook-io.ts#L28)<br>[setup.ts:254](https://github.com/aglowinthefield/impression/blob/main/packages/cli/src/setup.ts#L254)<br>[sessions.ts:81](https://github.com/aglowinthefield/impression/blob/main/packages/api/src/sessions.ts#L81) |
| I5 | Plugins run the CLI and MCP server bundled in their own package with node, not an `impression` found on PATH. omp runs extensions in Bun, so there the extension starts `node` from PATH. | [build.mjs:48](https://github.com/aglowinthefield/impression/blob/main/packages/impression/build.mjs#L48)<br>[impression.ts:64](https://github.com/aglowinthefield/impression/blob/main/packages/pi/impression.ts#L64) |
| I6 | Clones and worktrees of one repo resolve to one project key: the normalized remote, else the main checkout's path. Two keys for one repo split its memories. | [project.ts:62](https://github.com/aglowinthefield/impression/blob/main/packages/shared/src/project.ts#L62) |
| I7 | When nobody is signed in, an integration says so once at session start and does nothing else, so it never looks like it works when it doesn't. | [hook-run.ts:63](https://github.com/aglowinthefield/impression/blob/main/packages/cli/src/hook-run.ts#L63)<br>[impression.ts:236](https://github.com/aglowinthefield/impression/blob/main/packages/pi/impression.ts#L236) |
| I8 | `impression setup` backs up every file it changes before writing it, and a rerun changes nothing that is already right. Setup edits the person's own agent config. | [setup.ts:151](https://github.com/aglowinthefield/impression/blob/main/packages/cli/src/setup.ts#L151) |

## Proposed invariants

- Every entry of a pi session is sent once: none twice, none dropped. The `sent` counter stops duplicates, but a reload drops the unsent tail.
  - Breaks when: under 3000 characters are unsent, the person runs `/reload`, `session_shutdown` returns early for a reload ([impression.ts:313](https://github.com/aglowinthefield/impression/blob/main/packages/pi/impression.ts#L313)), and the new instance's `session_start` sets `sent` to the current entry count ([impression.ts:218](https://github.com/aglowinthefield/impression/blob/main/packages/pi/impression.ts#L218)).
  - To confirm: reload a session with a short unsent tail, then look for it in the sessions table.
- A mid-session chunk reaches the API even when the agent exits right after.
  - Breaks when: a run settles and its chunk send starts, attached to the agent through `execFile` ([impression.ts:200](https://github.com/aglowinthefield/impression/blob/main/packages/pi/impression.ts#L200)), then the person closes the terminal. The hangup likely reaches the child, which shares the agent's process group. `sent` has already moved past the chunk ([impression.ts:180](https://github.com/aglowinthefield/impression/blob/main/packages/pi/impression.ts#L180)), so the shutdown flush doesn't resend it.
  - To confirm: close the terminal within a few seconds of a run ending, then look for the chunk.

## Standing questions

- What does the person see when the API is down, slow, or they aren't signed in?
- Does it work in every agent Impression ships for: Claude Code, Codex, pi and omp? omp runs extensions in Bun, gives exit handlers 2 s, and can't register MCP servers, so setup writes `~/.omp/agent/mcp.json`.
- Does it add a send per prompt or per chunk, and so an extraction call on the server?

## Cost model

The client spends nothing itself. Each chunk sent with `--extract` costs one extraction call on the server (see the memories Persona's cost model), so `CHUNK_CHARS` (3000) in the pi extension and how often a hook sends set the extraction spend.

## Key files

- `packages/pi/impression.ts`: the pi and omp extension. Loads the CLI library in-process for search, shells out to the CLI for uploads.
- `packages/cli/src/hook-run.ts`: `impression hook <sub> --agent <agent>`, and the detached upload.
- `packages/cli/src/hook-io.ts`: what differs between agents' hooks: input fields, output shape, host detection.
- `packages/cli/src/session-end.ts`: reads every agent's transcript format and uploads a chunk.
- `packages/cli/src/setup.ts`, `setup-cli.ts`: `impression setup`.
- `packages/shared/src/project.ts`: project identity from a directory.
- `packages/shared/src/saved-client.ts`: the client that picks up a new `impression login` without a restart.
- `packages/mcp/src/server.ts`: the MCP server's `search` and `add` tools, and Codex's workspace lookup.
- `packages/impression/build.mjs`: bundles the npm package and writes the Claude Code and Codex plugin files.

## Recent decisions

The decision log lives in the vault: `Impression/Decisions.md`.

- 2026-11-12: agents get Impression through per-agent plugins, not hooks that setup writes. Gemini CLI, OpenCode, Cursor and Copilot are paused.
- 2026-11-12: no double hooks. Every hook names its agent, and the API keeps one copy of a chunk sent twice.

## How to run things here

`pnpm lint && pnpm typecheck && pnpm test` from the root. CLI, shared and MCP tests run under vitest without Docker.

The pi extension has no automated tests. To try it from a checkout, run `pnpm build`, then `pi -e packages/pi/impression.ts` in any git repo. It finds `packages/cli/dist` next to it.

Point it at a local API with `IMPRESSION_URL=http://localhost:3000` and `IMPRESSION_TOKEN`, and at another CLI build with `IMPRESSION_CLI`. `impression setup --dry-run` prints what setup would change without writing.
