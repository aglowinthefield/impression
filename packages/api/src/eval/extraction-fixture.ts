/**
 * Transcripts for scoring what extraction keeps. `want`: every term in a group must
 * appear (case-insensitive) in one returned memory. `avoid`: no memory may match.
 */
export interface ExtractionCase {
  name: string;
  transcript: string;
  want: string[][];
  avoid: RegExp[];
}

export const extractionCases: ExtractionCase[] = [
  {
    name: "decision with a reason",
    transcript: `user: should we run embeddings locally?
assistant: Options: keep OpenAI, or run Ollama with nomic-embed-text. Ollama is about 10ms.
user: ill go local for now. the team will use one shared server so they dont need ollama
assistant: Done. The api container reaches the host's Ollama through host.docker.internal.`,
    want: [["ollama"], ["share"]],
    avoid: [/everything is committed/i],
  },
  {
    name: "assistant suggestions the user did not accept",
    transcript: `user: whats next?
assistant: I'd do these: 1. strip impression messages from extraction 2. add a project key to the debug log 3. move to shadcn. Want me to start?
user: ill check the memories first`,
    want: [],
    avoid: [/shadcn/i, /project key/i, /strip/i],
  },
  {
    name: "status and UI state",
    transcript: `user: the buttons look bad
assistant: Fixed. The buttons now use btn-outline and the active tab is bold with an underline. Tests pass, committed as ef26641 and live at http://localhost:3000.
user: much better`,
    want: [],
    avoid: [/ef26641/, /localhost:3000/, /tests pass/i, /btn-outline/i],
  },
  {
    name: "user corrects the assistant",
    transcript: `assistant: The extension re-sends injected memories to extraction, so there is a feedback loop.
user: check, I dont think the parser reads custom messages
assistant: You're right. transcriptText only reads user and assistant messages, so injected blocks never reach extraction.`,
    want: [["parser", "extraction"]],
    avoid: [/feedback (loop|risk)[^.]*(can|get|are sent)/i],
  },
  {
    name: "gotcha with a command",
    transcript: `user: why did the migration fail
assistant: the vector column was 1536 and the new model gives 768
user: right. always run pnpm --filter @impression/api db:reembed after changing the embedding model, otherwise search returns nothing
assistant: noted`,
    want: [["db:reembed", "embedding model"]],
    avoid: [],
  },
  {
    name: "rule restated from AGENTS.md",
    transcript: `assistant: I read AGENTS.md. It reserves merging PRs, pushing and closing for an explicit user request, so I won't do those without you asking.
user: right, never push or merge unless I say so
assistant: Understood. Separately, the api container needs host.docker.internal to reach Ollama on 11434.`,
    want: [["host.docker.internal"]],
    avoid: [/AGENTS\.md/i, /merg/i, /explicit/i],
  },
  // The cases below come from junk the extractor kept on real sessions.
  {
    name: "assistant audit findings",
    transcript: `user: whats next for this project? needs to be feature complete before i invite teammates
assistant: Tests pass (134 api, 24 cli, 14 web). Gaps before inviting anyone:
1. Auto-accept defaults to 0.9 (config.ts:20), so a teammate's session writes straight into shared memory.
2. Any token can edit or hard-delete a shared memory (memories.ts:318), with no edit history.
3. The Debug log shows failed-auth requests to every caller (request-log.ts:39).
4. Team scope is in the schema enum but create rejects it.
I'd fix 1 and 3 first. Do you trust all teammates equally?
user: this is fine but how can i make it better for myself first`,
    want: [],
    avoid: [
      /config\.ts|memories\.ts|request-log/i,
      /auto-accept/i,
      /debug log/i,
      /team scope/i,
      /\b134\b/,
    ],
  },
  {
    name: "deploy progress with one durable reason",
    transcript: `assistant: Deployed to https://impression-cool-ocean-6435.fly.dev. The Neon project morning-art-16997574 is created and migrated, but the database is empty: your local memories haven't been moved yet.
user: ok. keep one machine always running on fly, a cold start makes the session-start hook time out and skip injection
assistant: Done, auto-stop is off in fly.toml.`,
    want: [["cold", "session-start"]],
    avoid: [
      /cool-ocean/i,
      /morning-art/i,
      /empty/i,
      /not (yet )?(been )?(moved|migrated)/i,
    ],
  },
  {
    name: "code walkthrough",
    transcript: `user: how do custom feed pages work?
assistant: Cursors are base64url-encoded {createdAt, mediaCardId}. The API fetches limit+1, defaults to 20 and caps at 50. feedReadableWeb permits public or viewer-owned webs and excludes chatrooms and muted webs. Media is ordered by webToMediaCard.createdAt, the connection time.
user: ok thanks`,
    want: [],
    avoid: [/cursor/i, /feedReadableWeb/, /limit\s*\+\s*1/i, /createdAt/],
  },
  {
    name: "accepted plan and next steps",
    transcript: `assistant: Next steps for the rollout: 1. instrument custom_feed_created and custom_feed_read events 2. create the enable_custom_feeds gate with staff-only access 3. then run the v1 evidence gates.
user: sounds good, start with 1. and use deterministic event ids so retries dont double count
assistant: Starting on the events.`,
    want: [["deterministic", "id"]],
    avoid: [/next step/i, /staff-only/i, /evidence gate/i, /start with/i],
  },
  {
    name: "run results around an API gotcha",
    transcript: `assistant: The dry run found 27,541 eligible cards, about $11.50. Every finished batch was marked failed: the docs say JOB_STATE_SUCCEEDED but the live Gemini batch API returns BATCH_STATE_SUCCEEDED. I fixed collect to accept both.
user: nice. run 200 cards first so i can inspect the rows
assistant: Submitted 200 cards.`,
    want: [["BATCH_STATE"]],
    avoid: [/27,?541/, /11\.50/, /200 cards/i, /submitted/i],
  },
  {
    name: "chatter only",
    transcript: `user: yes
assistant: ok
user: continue
assistant: Running the tests now. All 129 pass.`,
    want: [],
    avoid: [/./],
  },
];
