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
    want: [["ollama", "nomic"], ["shared"]],
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
    name: "chatter only",
    transcript: `user: yes
assistant: ok
user: continue
assistant: Running the tests now. All 129 pass.`,
    want: [],
    avoid: [/./],
  },
];
