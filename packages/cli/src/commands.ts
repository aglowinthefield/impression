import {
  type ApiClient,
  type FullApiClient,
  resolveProject,
} from "@impression/shared";

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
  return [
    `Server:    ${url}`,
    `Signed in: ${who.name}`,
    `Project:   ${p.key}`,
    `Review:    ${review.items.length} possibly stale`,
  ].join("\n");
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Resolves the 8-character ids shown by `list` and `search` to full ids. */
function byPrefix<T extends { id: string }>(
  items: T[],
  prefix: string,
  what: string,
): T {
  const hits = items.filter((i) => i.id.startsWith(prefix.toLowerCase()));
  if (hits.length === 0) throw new Error(`No ${what} starts with ${prefix}`);
  if (hits.length > 1)
    throw new Error(
      `${prefix} matches ${hits.length} ${what} entries; use more characters`,
    );
  return hits[0] as T;
}

async function memoryId(client: ApiClient, cwd: string, prefix: string) {
  if (UUID.test(prefix)) return prefix;
  const p = resolveProject(cwd);
  const qs = new URLSearchParams({ project: p.key, limit: "200" });
  const [mine, stale] = await Promise.all([
    client.get(`/memories?${qs}`) as Promise<{ items: Mem[] }>,
    client.get("/memories/review") as Promise<{ items: Mem[] }>,
  ]);
  const all = new Map([...mine.items, ...stale.items].map((m) => [m.id, m]));
  return byPrefix([...all.values()], prefix, "memory").id;
}

export async function retire(
  client: FullApiClient,
  cwd: string,
  prefix: string,
) {
  await client.delete(`/memories/${await memoryId(client, cwd, prefix)}`);
  return "Retired";
}

export async function edit(
  client: FullApiClient,
  cwd: string,
  prefix: string,
  content: string,
) {
  await client.patch(`/memories/${await memoryId(client, cwd, prefix)}`, {
    content,
  });
  return "Updated";
}

/** Clears the possibly-stale flag. */
export async function keep(client: FullApiClient, cwd: string, prefix: string) {
  await client.put(
    `/memories/${await memoryId(client, cwd, prefix)}/staleness`,
    {
      stale: false,
    },
  );
  return "Kept";
}
