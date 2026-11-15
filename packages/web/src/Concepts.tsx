import { useCallback, useEffect, useState } from "react";
import { api } from "./api";
import { Memories } from "./Memories";
import { ago } from "./time";

export interface Concept {
  id: string;
  parentId: string | null;
  name: string;
  summary: string;
  count: number;
  related: string[];
  updatedAt: string;
}

interface LastRun {
  finishedAt: string | null;
  trigger: string;
  error: string | null;
}

/** The Memories tab: your concepts in the project on the left, their memories on the right. */
export function MemoriesPage({ project }: { project: string }) {
  const [concepts, setConcepts] = useState<Concept[] | null>(null);
  const [selected, setSelected] = useState("");
  const [dreaming, setDreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastRun, setLastRun] = useState<LastRun | null>(null);

  const load = useCallback(async () => {
    if (!project) return setConcepts([]);
    try {
      const r = await api<{ items: Concept[]; lastRun: LastRun | null }>(
        `/dream?project=${encodeURIComponent(project)}`,
      );
      setConcepts(r.items);
      setLastRun(r.lastRun);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [project]);

  useEffect(() => {
    setSelected("");
    setConcepts(null);
    setLastRun(null);
    setError(null);
    void load();
  }, [load]);

  const regroup = async () => {
    setDreaming(true);
    setError(null);
    try {
      await api(`/dream?project=${encodeURIComponent(project)}`, {
        method: "POST",
      });
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setDreaming(false);
    }
  };

  const byId = new Map((concepts ?? []).map((c) => [c.id, c]));
  const areas = (concepts ?? []).filter(
    (c) => !c.parentId || !byId.has(c.parentId),
  );
  const children = (id: string) =>
    (concepts ?? []).filter((c) => c.parentId === id);
  const total = (c: Concept) =>
    c.count + children(c.id).reduce((n, x) => n + x.count, 0);
  const current = byId.get(selected);

  const item = (key: string, label: string, count?: number, sub = false) => (
    <li key={key}>
      <button
        type="button"
        className={`flex justify-between ${selected === key ? "menu-active" : ""} ${sub ? "pl-6" : ""}`}
        aria-current={selected === key}
        onClick={() => setSelected(key)}
      >
        <span>{label}</span>
        {count !== undefined && <span className="opacity-60">{count}</span>}
      </button>
    </li>
  );

  return (
    <div className="library">
      <nav aria-label="Concepts">
        <ul className="menu menu-sm w-full p-0">
          {item("", "All")}
          {areas.flatMap((a) => [
            item(a.id, a.name, total(a)),
            ...children(a.id).map((c) => item(c.id, c.name, c.count, true)),
          ])}
          {concepts && concepts.length > 0 && item("none", "Uncategorized")}
          {item("practices", "Practices")}
        </ul>
        {concepts?.length === 0 && (
          <p className="mt-3 text-xs opacity-70">No concepts yet.</p>
        )}
        {project && concepts && (
          <button
            type="button"
            className="btn btn-xs btn-outline mt-3"
            disabled={dreaming}
            onClick={regroup}
          >
            {dreaming
              ? "Grouping…"
              : concepts.length
                ? "Regroup"
                : "Group into concepts"}
          </button>
        )}
        {lastRun?.finishedAt && (
          <p className="mt-2 text-xs opacity-60">
            {lastRun.error ? "Grouping failed" : "Grouped"}{" "}
            {ago(lastRun.finishedAt)}
          </p>
        )}
        {error && <p role="alert">{error}</p>}
      </nav>
      <div>
        {current && (
          <header className="mb-4">
            <h2 className="text-base font-semibold">{current.name}</h2>
            <p className="text-sm opacity-80">{current.summary}</p>
            {current.related.some((id) => byId.has(id)) && (
              <p className="mt-1 flex flex-wrap items-center gap-1 text-xs">
                <span className="opacity-70">Related:</span>
                {current.related.flatMap((id) => {
                  const r = byId.get(id);
                  return r
                    ? [
                        <button
                          key={id}
                          type="button"
                          className="link"
                          onClick={() => setSelected(id)}
                        >
                          {r.name}
                        </button>,
                      ]
                    : [];
                })}
              </p>
            )}
          </header>
        )}
        <Memories project={project} concept={selected} />
      </div>
    </div>
  );
}
