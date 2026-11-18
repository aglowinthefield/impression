import { useCallback, useEffect, useState } from "react";
import { api } from "./api";
import { ago } from "./time";

export interface Entry {
  id: string;
  at: string;
  kind: string;
  actor: "extraction" | "check" | "person" | "dream";
  principal: string | null;
  memory: { id: string; content: string; scope: string; status: string } | null;
  before?: string;
  after?: string;
  reason: string;
  why?: string | null;
  session?: { id: string | null; agent: string | null };
  undoes?: string | null;
  run?: {
    created: number | null;
    kept: number | null;
    removed: number | null;
    uncategorized: number | null;
    concepts: number | null;
    error: string | null;
  };
  undone: boolean;
  canUndo: boolean;
}

interface Week {
  week: string;
  added: number;
  rewritten: number;
  retired: number;
  retireRate: number | null;
}

const sources = [
  ["", "All sources"],
  ["extraction", "Extraction"],
  ["check", "Staleness check"],
  ["dream", "Dreaming"],
  ["person", "People"],
] as const;

const verbs: Record<string, string> = {
  extracted: "Extracted",
  added: "Added",
  merged: "Merged",
  superseded: "Replaced older memories",
  edited: "Edited",
  kept: "Kept",
  rewritten: "Rewritten",
  retired: "Retired",
  flagged: "Flagged as possibly stale",
  cleared: "Marked still true",
  undone: "Undid",
};

/** One line saying what happened and who or what did it. */
export function describe(e: Entry): string {
  if (e.run) {
    const r = e.run;
    if (r.error) return `Grouping into concepts failed: ${r.error}`;
    return `Grouped into concepts: ${r.created ?? 0} new, ${r.kept ?? 0} kept, ${r.removed ?? 0} removed, ${r.uncategorized ?? 0} memories uncategorized`;
  }
  const verb =
    e.kind === "undone"
      ? `Undid ${(verbs[e.undoes ?? ""] ?? e.undoes ?? "a change").toLowerCase()}`
      : (verbs[e.kind] ?? e.kind);
  const by =
    e.actor === "extraction"
      ? e.session?.agent
        ? `from a ${e.session.agent} session`
        : "by extraction"
      : e.actor === "check"
        ? "by the staleness check"
        : e.principal
          ? `by ${e.principal}`
          : "";
  return by ? `${verb} ${by}` : verb;
}

function Row({ e, onUndone }: { e: Entry; onUndone: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const undo = async () => {
    setBusy(true);
    setError(null);
    try {
      await api(`/activity/${e.id}/undo`, { method: "POST" });
      onUndone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const showText =
    e.memory && !(e.before !== undefined && e.after !== undefined);
  return (
    <li className="memory">
      <small>
        {ago(e.at)} · {describe(e)}
        {e.undone ? " · undone" : ""}
      </small>
      {showText && <p>{e.memory?.content}</p>}
      {e.before !== undefined && (
        <p className="opacity-60">
          <del>{e.before}</del>
        </p>
      )}
      {e.after !== undefined && (
        <p>
          <ins className="no-underline">{e.after}</ins>
        </p>
      )}
      {(e.actor === "check" && e.reason) || e.why ? (
        <small>
          {[e.actor === "check" ? e.reason : "", e.why ?? ""]
            .filter(Boolean)
            .join(" · ")}
        </small>
      ) : null}
      {e.canUndo && (
        <div className="actions">
          <button
            className="btn btn-sm btn-outline"
            type="button"
            disabled={busy}
            onClick={undo}
          >
            Undo
          </button>
        </div>
      )}
      {error && <p role="alert">{error}</p>}
    </li>
  );
}

/** What happened to your memories in the project, newest first, with undo. */
export function Activity({ project }: { project: string }) {
  const [source, setSource] = useState("");
  const [items, setItems] = useState<Entry[] | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [weeks, setWeeks] = useState<Week[]>([]);
  const [error, setError] = useState<string | null>(null);

  const page = useCallback(
    (before?: string) => {
      const q = new URLSearchParams({ project });
      if (source) q.set("source", source);
      if (before) q.set("before", before);
      return api<{ items: Entry[]; next: string | null }>(`/activity?${q}`);
    },
    [project, source],
  );

  const load = useCallback(async () => {
    if (!project) return setItems([]);
    try {
      const [r, s] = await Promise.all([
        page(),
        api<{ weeks: Week[] }>(
          `/activity/summary?project=${encodeURIComponent(project)}`,
        ),
      ]);
      setItems(r.items);
      setNext(r.next);
      setWeeks(s.weeks);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [project, page]);

  useEffect(() => {
    void load();
  }, [load]);

  const more = async () => {
    if (!next) return;
    try {
      const r = await page(next);
      setItems((i) => [...(i ?? []), ...r.items]);
      setNext(r.next);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <section>
      {weeks.length > 0 && (
        <table className="table table-sm mb-4 w-auto">
          <thead>
            <tr>
              <th>Week from</th>
              <th>Added</th>
              <th>Rewritten</th>
              <th>Retired</th>
              <th>Retire rate</th>
            </tr>
          </thead>
          <tbody>
            {weeks.map((w) => (
              <tr key={w.week}>
                <td>{w.week.slice(0, 10)}</td>
                <td>{w.added}</td>
                <td>{w.rewritten}</td>
                <td>{w.retired}</td>
                <td>{w.retireRate === null ? "–" : `${w.retireRate}%`}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div className="filters">
        <select
          className="select select-sm w-auto"
          aria-label="Source"
          value={source}
          onChange={(e) => setSource(e.target.value)}
        >
          {sources.map(([v, label]) => (
            <option key={v} value={v}>
              {label}
            </option>
          ))}
        </select>
      </div>
      {error && <p role="alert">{error}</p>}
      {items?.length === 0 && <p>Nothing has happened here yet.</p>}
      <ul className="memories">
        {items?.map((e) => (
          <Row key={e.id} e={e} onUndone={load} />
        ))}
      </ul>
      {next && (
        <button className="btn btn-sm btn-outline" type="button" onClick={more}>
          Load 50 more
        </button>
      )}
    </section>
  );
}
