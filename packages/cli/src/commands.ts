import { type ApiClient, resolveProject } from "@impression/shared";

interface Mem {
  id: string;
  content: string;
  scope: string;
  status: string;
  pinned: boolean;
  warning?: string | null;
}

const line = (m: Mem) =>
  `${m.id.slice(0, 8)}  ${m.scope}${m.pinned ? " pinned" : ""}${m.status === "possibly_stale" ? " STALE" : ""}  ${m.content}${m.warning ? ` (${m.warning})` : ""}`;

export async function search(client: ApiClient, cwd: string, query: string) {
  const p = resolveProject(cwd);
  const r = (await client.post("/search", {
    query,
    project: p.key,
    ...(p.pathPrefix ? { path: p.pathPrefix } : {}),
  })) as { results: Mem[]; degraded?: boolean };
  const out = r.results.length
    ? r.results.map(line)
    : ["No matching memories."];
  if (r.degraded) out.push("(embeddings unavailable: keyword results only)");
  return out.join("\n");
}

export async function add(
  client: ApiClient,
  cwd: string,
  content: string,
  opts: { user?: boolean; pin?: boolean } = {},
) {
  const p = resolveProject(cwd);
  const user = opts.user === true;
  const r = (await client.post("/memories", {
    scope: user ? "user" : "project",
    content,
    ...(user ? {} : { project: { key: p.key, name: p.name } }),
    ...(!user && p.pathPrefix ? { pathPrefix: p.pathPrefix } : {}),
    ...(opts.pin ? { pinned: true } : {}),
    agent: "cli",
  })) as { id: string; outcome?: string };
  const note =
    r.outcome === "duplicate" || r.outcome === "merged"
      ? "Already known"
      : r.outcome === "superseded"
        ? "Saved, replacing an older memory"
        : "Saved";
  return `${note}: ${r.id}`;
}

export async function list(client: ApiClient, cwd: string) {
  const p = resolveProject(cwd);
  const qs = new URLSearchParams({ project: p.key, limit: "50" });
  const r = (await client.get(`/memories?${qs}`)) as { items: Mem[] };
  return r.items.length ? r.items.map(line).join("\n") : "No memories yet.";
}

export async function status(client: ApiClient, cwd: string, url: string) {
  const p = resolveProject(cwd);
  const who = (await client.get("/whoami")) as { name: string };
  const review = (await client.get("/memories/review")) as { items: unknown[] };
  const props = (await client.get("/proposals")) as { items: unknown[] };
  return [
    `Server:    ${url}`,
    `Signed in: ${who.name}`,
    `Project:   ${p.key}`,
    `Review:    ${review.items.length} possibly stale`,
    `Proposals: ${props.items.length} pending`,
  ].join("\n");
}
