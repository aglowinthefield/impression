import { useCallback, useEffect, useState } from "react";
import { api } from "./api";

export interface Memory {
  id: string;
  scope: "user" | "project";
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

function Row({ m, onChange }: { m: Memory; onChange: () => void }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(m.content);
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
      {m.tags?.length ? (
        <p className="m-0">
          {m.tags.map((t) => (
            <span key={t} className="badge badge-info badge-sm mr-1">
              {t}
            </span>
          ))}
        </p>
      ) : null}
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
      const r = query.trim()
        ? await api<{ results: Memory[] }>("/search", {
            body: {
              query: query.trim(),
              ...(project ? { project } : {}),
              ...(scope ? { scope } : {}),
              ...(status ? { status } : {}),
            },
          }).then((x) => x.results)
        : await api<{ items: Memory[] }>(`/memories?${q}`).then((x) => x.items);
      setItems(r);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [project, scope, status, query]);

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
          <option value="project">Project</option>
          <option value="user">Mine</option>
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
          <Row key={m.id} m={m} onChange={load} />
        ))}
      </ul>
    </section>
  );
}
