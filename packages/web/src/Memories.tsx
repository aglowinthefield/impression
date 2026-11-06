import { useCallback, useEffect, useState } from "react";
import { api } from "./api";

export interface Memory {
  id: string;
  scope: "user" | "project" | "team";
  content: string;
  tags?: string[];
  status: "active" | "possibly_stale" | "superseded" | "retired";
  staleReason: string | null;
  pinned: boolean;
  pathPrefix: string | null;
  supersededBy: string | null;
  createdAt: string;
  warning?: string | null;
  anchors?: { path: string; symbol: string | null }[];
}

function Row({
  m,
  project,
  knownTags,
  onChange,
}: {
  m: Memory;
  project: string;
  knownTags: string[];
  onChange: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(m.content);
  const [newTag, setNewTag] = useState("");
  const [error, setError] = useState<string | null>(null);
  const act = async (fn: () => Promise<unknown>) => {
    try {
      setError(null);
      await fn();
      setEditing(false);
      onChange();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const [open, setOpen] = useState(false);
  const clean = newTag.trim().toLowerCase().replace(/\s+/g, "-");
  const options = knownTags.filter(
    (t) => !m.tags?.includes(t) && t.includes(clean),
  );
  const canCreate =
    clean !== "" && !knownTags.includes(clean) && !m.tags?.includes(clean);
  const addTag = (tag: string) => {
    setNewTag("");
    if (!tag || m.tags?.includes(tag)) return;
    if (
      tag === "practice" &&
      !window.confirm("A practice follows you into every project. Continue?")
    )
      return;
    void act(() =>
      api(`/memories/${m.id}`, {
        method: "PATCH",
        body: { tags: [...(m.tags ?? []), tag] },
      }),
    );
  };
  const history = m.status === "superseded" || m.status === "retired";
  return (
    <li className="memory">
      {editing ? (
        <textarea
          className="textarea w-full"
          aria-label="Edit memory"
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={3}
        />
      ) : (
        <p>{m.content}</p>
      )}
      <div className="flex flex-wrap items-center gap-1">
        {m.tags?.map((t) => (
          <span key={t} className="badge badge-info badge-sm gap-1">
            {t}
            {!history && (
              <button
                type="button"
                className="cursor-pointer"
                aria-label={`Remove tag ${t}`}
                onClick={() =>
                  act(() =>
                    api(`/memories/${m.id}`, {
                      method: "PATCH",
                      body: {
                        tags: (m.tags ?? []).filter((x) => x !== t),
                        // Un-practicing sends it back to the project you're looking at.
                        ...(t === "practice"
                          ? { project: { key: project } }
                          : {}),
                      },
                    }),
                  )
                }
              >
                ×
              </button>
            )}
          </span>
        ))}
        {!history && (
          <div className="relative">
            <input
              className="input input-xs w-28"
              aria-label="Add tag"
              placeholder="+ tag"
              value={newTag}
              onFocus={() => setOpen(true)}
              onBlur={() => setOpen(false)}
              onChange={(e) => setNewTag(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") return setOpen(false);
                if (e.key !== "Enter") return;
                e.preventDefault();
                addTag(clean);
              }}
            />
            {open && options.length + (canCreate ? 1 : 0) > 0 && (
              <ul
                aria-label="Tag suggestions"
                className="menu bg-base-100 border-base-300 absolute z-10 mt-1 max-h-48 w-44 overflow-auto rounded-box border p-1 shadow"
              >
                {options.map((t) => (
                  <li key={t}>
                    {/* mouseDown, not click: the input's blur would close the list first. */}
                    <button
                      type="button"
                      onMouseDown={(e) => {
                        e.preventDefault();
                        addTag(t);
                      }}
                    >
                      {t}
                    </button>
                  </li>
                ))}
                {canCreate && (
                  <li>
                    <button
                      type="button"
                      onMouseDown={(e) => {
                        e.preventDefault();
                        addTag(clean);
                      }}
                    >
                      Create “{clean}”
                    </button>
                  </li>
                )}
              </ul>
            )}
          </div>
        )}
      </div>
      <small>
        {m.scope}
        {m.pathPrefix ? ` · ${m.pathPrefix}` : ""}
        {m.pinned ? " · pinned" : ""}
        {m.status !== "active" ? ` · ${m.status.replace("_", " ")}` : ""}
        {m.staleReason ? ` (${m.staleReason})` : ""}
        {m.anchors?.length
          ? ` · ${m.anchors.map((a) => (a.symbol ? `${a.path}#${a.symbol}` : a.path)).join(", ")}`
          : ""}
      </small>
      {!history && (
        <div className="actions">
          {editing ? (
            <>
              <button
                className="btn btn-sm btn-primary"
                type="button"
                onClick={() =>
                  act(() =>
                    api(`/memories/${m.id}`, {
                      method: "PATCH",
                      body: { content: text },
                    }),
                  )
                }
              >
                Save
              </button>
              <button
                className="btn btn-sm btn-outline"
                type="button"
                onClick={() => setEditing(false)}
              >
                Cancel
              </button>
            </>
          ) : (
            <>
              <button
                className="btn btn-sm btn-outline"
                type="button"
                onClick={() => setEditing(true)}
              >
                Edit
              </button>
              <button
                className="btn btn-sm btn-outline"
                type="button"
                onClick={() =>
                  act(() =>
                    api(`/memories/${m.id}`, {
                      method: "PATCH",
                      body: { pinned: !m.pinned },
                    }),
                  )
                }
              >
                {m.pinned ? "Unpin" : "Pin to core"}
              </button>
              {m.scope !== "user" && (
                <button
                  className="btn btn-sm btn-outline"
                  type="button"
                  onClick={() =>
                    act(() =>
                      api(`/memories/${m.id}`, {
                        method: "PATCH",
                        body: {
                          scope: m.scope === "team" ? "project" : "team",
                        },
                      }),
                    )
                  }
                >
                  {m.scope === "team" ? "Make private" : "Share with team"}
                </button>
              )}
              <button
                className="btn btn-sm btn-error btn-outline"
                type="button"
                onClick={() => {
                  if (
                    window.confirm("Retire this memory? It stays in history.")
                  )
                    act(() => api(`/memories/${m.id}`, { method: "DELETE" }));
                }}
              >
                Retire
              </button>
            </>
          )}
        </div>
      )}
      {error && <p role="alert">{error}</p>}
    </li>
  );
}

export function Memories({ project }: { project: string }) {
  const [tag, setTag] = useState("");
  const [knownTags, setKnownTags] = useState<string[]>(["practice"]);
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState("");
  const [status, setStatus] = useState("");
  const [items, setItems] = useState<Memory[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const q = new URLSearchParams();
      if (project) q.set("project", project);
      if (scope) q.set("scope", scope);
      if (status) q.set("status", status);
      if (tag) q.set("tag", tag);
      const r = query.trim()
        ? await api<{ results: Memory[] }>("/search", {
            body: {
              query: query.trim(),
              ...(project ? { project } : {}),
              ...(scope ? { scope } : {}),
              ...(status ? { status } : {}),
              ...(tag ? { tag } : {}),
            },
          }).then((x) => x.results)
        : await api<{ items: Memory[] }>(`/memories?${q}`).then((x) => x.items);
      setItems(r);
      setKnownTags((k) =>
        [...new Set([...k, ...r.flatMap((m) => m.tags ?? [])])].sort(),
      );
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [project, scope, status, tag, query]);

  useEffect(() => {
    const t = setTimeout(load, query ? 250 : 0);
    return () => clearTimeout(t);
  }, [load, query]);

  return (
    <section>
      <div className="filters">
        <input
          className="input input-sm"
          type="search"
          aria-label="Search memories"
          placeholder="Search…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <select
          className="select select-sm w-auto"
          aria-label="Scope"
          value={scope}
          onChange={(e) => setScope(e.target.value)}
        >
          <option value="">All scopes</option>
          <option value="project">Project (private)</option>
          <option value="team">Team</option>
          <option value="user">Mine</option>
        </select>
        <select
          className="select select-sm w-auto"
          aria-label="Tag"
          value={tag}
          onChange={(e) => setTag(e.target.value)}
        >
          <option value="">All tags</option>
          {knownTags.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
        <select
          className="select select-sm w-auto"
          aria-label="Status"
          value={status}
          onChange={(e) => setStatus(e.target.value)}
        >
          <option value="">Current</option>
          <option value="possibly_stale">Possibly stale</option>
          <option value="superseded">History (superseded)</option>
          <option value="retired">Retired</option>
        </select>
      </div>
      {error && <p role="alert">{error}</p>}
      {!loading && items.length === 0 && !error && <p>No memories.</p>}
      <ul className="memories">
        {items.map((m) => (
          <Row
            key={m.id}
            m={m}
            project={project}
            knownTags={knownTags}
            onChange={load}
          />
        ))}
      </ul>
    </section>
  );
}
