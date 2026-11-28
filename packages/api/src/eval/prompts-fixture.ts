/**
 * Realistic prompts for the fixture memories in fixture.ts. Unlike `queries`
 * (short questions), these read like what a person types to an agent mid-task:
 * long, conversational, often indirect. `expect` lists every memory that should
 * be injected. `none` prompts are ordinary requests that no memory should answer,
 * so injecting anything for them is noise.
 */
export const prompts: { q: string; expect: string[] }[] = [
  {
    q: "ok the CI run went red on the lint step, can you take a look and get it green again",
    expect: ["biome"],
  },
  {
    q: "i added a column to the memories table, what do i need to do before this works on my machine",
    expect: ["migrate"],
  },
  {
    q: "let's get this out to users today",
    expect: ["deploy"],
  },
  {
    q: "my local db connection is being refused, nothing is listening where the app expects",
    expect: ["pg-port"],
  },
  {
    q: "I want to try swapping in a newer embedding model, what's the blast radius",
    expect: ["embed"],
  },
  {
    q: "someone pasted an AWS key into a memory, what actually happens to it when it's saved",
    expect: ["scrub"],
  },
  {
    q: "add a test for the new endpoint, how do the existing ones set up their data",
    expect: ["tests"],
  },
  {
    q: "can you add a typescript package so we get better types in the web app",
    expect: ["tsrs", "ui"],
  },
  {
    q: "curl keeps returning 401, what am I missing in the request",
    expect: ["auth"],
  },
  {
    q: "the exit hook crashed and now my editor won't close",
    expect: ["hooks"],
  },
  {
    q: "start a new piece of work for the review screen, set me up",
    expect: ["branch"],
  },
  {
    q: "memory says a file exists but I deleted it last week, why is it still showing as fine",
    expect: ["stale"],
  },
  {
    q: "run the formatter and then push this so I can open a PR",
    expect: ["biome"],
  },
  {
    q: "new teammate is cloning the repo, what's the first command they should run",
    expect: ["pnpm"],
  },
];

export const noMemoryPrompts = [
  "make the save button blue",
  "can you explain what a closure is",
  "yes go ahead",
  "rename the variable foo to count in this function",
  "what's the difference between a Map and a plain object in JavaScript",
  "write a haiku about databases",
  "that looks great, thanks",
  "why is my css grid overflowing on mobile",
  "summarise the last three commits",
  "add a loading spinner while the list fetches",
];
