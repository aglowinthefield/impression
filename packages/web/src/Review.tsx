import { useCallback, useEffect, useState } from "react";
import { api } from "./api";
import type { Memory } from "./Memories";

type Flagged = Memory & { project: string | null };

function Card({ m, onDone }: { m: Flagged; onDone: () => void }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(m.content);
  const [error, setError] = useState<string | null>(null);
  const act = async (fn: () => Promise<unknown>) => {
    try {
      setError(null);
      await fn();
      onDone();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <li className="memory">
      {editing ? (
        <textarea
          aria-label="Update memory"
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={3}
        />
      ) : (
        <p>{m.content}</p>
      )}
      <small>
        {m.staleReason ?? "flagged stale"}
        {m.anchors?.length
          ? ` · ${m.anchors.map((a) => (a.symbol ? `${a.path}#${a.symbol}` : a.path)).join(", ")}`
          : ""}
      </small>
      <div className="actions">
        {editing ? (
          <>
            <button
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
              Save update
            </button>
            <button type="button" onClick={() => setEditing(false)}>
              Cancel
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              onClick={() =>
                act(() =>
                  api(`/memories/${m.id}/staleness`, {
                    method: "PUT",
                    body: { stale: false },
                  }),
                )
              }
            >
              Still true
            </button>
            <button type="button" onClick={() => setEditing(true)}>
              Update
            </button>
            <button
              type="button"
              onClick={() =>
                act(() => api(`/memories/${m.id}`, { method: "DELETE" }))
              }
            >
              Retire
            </button>
          </>
        )}
      </div>
      {error && <p role="alert">{error}</p>}
    </li>
  );
}

export function Review({ project }: { project: string }) {
  const [items, setItems] = useState<Flagged[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      const r = await api<{ items: Flagged[] }>("/memories/review");
      // User memories have no project; they show under every project.
      setItems(
        r.items.filter((m) => !project || !m.project || m.project === project),
      );
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [project]);
  useEffect(() => {
    load();
  }, [load]);
  return (
    <section>
      {error && <p role="alert">{error}</p>}
      {items?.length === 0 && <p>Nothing flagged as stale.</p>}
      <ul className="memories">
        {items?.map((m) => (
          <Card key={m.id} m={m} onDone={load} />
        ))}
      </ul>
    </section>
  );
}
