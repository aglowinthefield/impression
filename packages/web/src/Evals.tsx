import { useCallback, useEffect, useState } from "react";
import { api } from "./api";

type Rating = "useful" | "irrelevant" | "wrong";
interface Injected {
  text: string;
  memoryId: string | null;
  status: string | null;
  rating: Rating | null;
}
interface Turn {
  id: string;
  at: string | null;
  prompt: string;
  reply: string;
  injected: Injected[];
}
interface MemStat {
  id: string;
  content: string;
  pinned: boolean;
  injected: number;
  useful: number;
  irrelevant: number;
  wrong: number;
}
interface Extracted {
  id: string;
  content: string;
  status: string;
  createdAt: string;
  rating: "good" | "junk" | null;
}

const qs = (project: string, extra = "") =>
  `?${project ? `project=${encodeURIComponent(project)}&` : ""}${extra}`;
const ratings: { value: Rating; label: string; cls: string }[] = [
  { value: "useful", label: "Useful", cls: "btn-success" },
  { value: "irrelevant", label: "Irrelevant", cls: "btn-warning" },
  { value: "wrong", label: "Wrong", cls: "btn-error" },
];

function Sessions({ project }: { project: string }) {
  const [turns, setTurns] = useState<Turn[] | null>(null);
  const [unrated, setUnrated] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      const r = await api<{ items: Turn[] }>(
        `/evals/turns${qs(project, `unrated=${unrated}`)}`,
      );
      setTurns(r.items);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [project, unrated]);
  useEffect(() => {
    load();
  }, [load]);

  const patch = (id: string, text: string, fn: (i: Injected) => Injected) =>
    setTurns(
      (ts) =>
        ts?.map((t) =>
          t.id === id
            ? {
                ...t,
                injected: t.injected.map((i) => (i.text === text ? fn(i) : i)),
              }
            : t,
        ) ?? null,
    );
  const rate = async (t: Turn, i: Injected, rating: Rating) => {
    const next = i.rating === rating ? null : rating;
    patch(t.id, i.text, (x) => ({ ...x, rating: next }));
    try {
      await api(`/evals/turns/${t.id}/rating`, {
        method: "PUT",
        body: { memory: i.text, rating: next },
      });
    } catch (e) {
      setError((e as Error).message);
      patch(t.id, i.text, (x) => ({ ...x, rating: i.rating }));
    }
  };
  const retire = async (t: Turn, i: Injected) => {
    if (
      !i.memoryId ||
      !window.confirm("Retire this memory? It stays in history.")
    )
      return;
    patch(t.id, i.text, (x) => ({ ...x, status: "retired" }));
    try {
      await api(`/memories/${i.memoryId}`, { method: "DELETE" });
    } catch (e) {
      setError((e as Error).message);
      patch(t.id, i.text, (x) => ({ ...x, status: i.status }));
    }
  };

  return (
    <section>
      <p>
        <small>
          Prompts from your pi sessions and the memories injected for each. Rate
          whether each one helped. Fill this tab with{" "}
          <code>impression eval push</code>.
        </small>
      </p>
      <label className="flex items-center gap-2 mb-3">
        <input
          type="checkbox"
          className="checkbox checkbox-sm"
          checked={unrated}
          onChange={(e) => setUnrated(e.target.checked)}
        />
        Only prompts with unrated memories
      </label>
      {error && <p role="alert">{error}</p>}
      {turns?.length === 0 && (
        <p>
          Nothing to rate. Run <code>impression eval push</code> after a pi
          session.
        </p>
      )}
      <ul className="memories">
        {turns?.map((t) => (
          <li key={t.id} className="memory">
            <p>
              <strong>{t.prompt.slice(0, 300)}</strong>
            </p>
            <small>
              {t.at ? new Date(t.at).toLocaleString() : ""}
              {t.reply ? ` · reply: ${t.reply.slice(0, 160)}` : ""}
            </small>
            <ul className="mt-2 grid gap-2 list-none p-0">
              {t.injected.map((i) => (
                <li key={i.text} className="flex flex-wrap items-center gap-2">
                  <span className="flex-1 min-w-64">{i.text}</span>
                  {ratings.map((r) => (
                    <button
                      key={r.value}
                      type="button"
                      className={`btn btn-xs ${i.rating === r.value ? r.cls : "btn-outline"}`}
                      aria-pressed={i.rating === r.value}
                      onClick={() => rate(t, i, r.value)}
                    >
                      {r.label}
                    </button>
                  ))}
                  {i.rating === "wrong" &&
                    i.memoryId &&
                    i.status === "active" && (
                      <button
                        type="button"
                        className="btn btn-xs btn-error btn-outline"
                        onClick={() => retire(t, i)}
                      >
                        Retire memory
                      </button>
                    )}
                  {i.status === "retired" && <small>retired</small>}
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
    </section>
  );
}

function MemoryStats({ project }: { project: string }) {
  const [items, setItems] = useState<MemStat[] | null>(null);
  const [turns, setTurns] = useState(0);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api<{ items: MemStat[]; turns: number }>(`/evals/memories${qs(project)}`)
      .then((r) => {
        setItems(r.items);
        setTurns(r.turns);
      })
      .catch((e: Error) => setError(e.message));
  }, [project]);
  const never = items?.filter((m) => m.injected === 0) ?? [];
  const used = items?.filter((m) => m.injected > 0) ?? [];
  return (
    <section>
      <p>
        <small>
          How often each active memory was injected across {turns} pushed
          prompts, and how you rated it. Memories injected often but rated
          irrelevant are the ones to reword or retire.
        </small>
      </p>
      {error && <p role="alert">{error}</p>}
      <div className="overflow-x-auto">
        <table className="debug">
          <thead>
            <tr>
              <th>Memory</th>
              <th className="text-right">Injected</th>
              <th className="text-right">Useful</th>
              <th className="text-right">Irrelevant</th>
              <th className="text-right">Wrong</th>
            </tr>
          </thead>
          <tbody>
            {used.map((m) => (
              <tr key={m.id} data-ok={m.wrong + m.irrelevant <= m.useful}>
                <td title={m.content}>{m.content.slice(0, 90)}</td>
                <td className="text-right">{m.injected}</td>
                <td className="text-right">{m.useful}</td>
                <td className="text-right">{m.irrelevant}</td>
                <td className="text-right">{m.wrong}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <h3 className="mt-4 mb-1 font-semibold">
        Never injected ({never.length})
      </h3>
      <ul className="m-0 p-0 list-none grid gap-1">
        {never.map((m) => (
          <li key={m.id}>
            <small>{m.content.slice(0, 140)}</small>
          </li>
        ))}
      </ul>
    </section>
  );
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

/** A paste-ready eval case for packages/api/src/eval/extraction-fixture.ts. */
export function fixtureSnippet(content: string, transcript: string): string {
  const words = content.split(/\s+/).slice(0, 4).join(" ");
  const body = transcript.replace(/[`\\]|\$\{/g, "\\$&");
  return `  {
    name: ${JSON.stringify(content.slice(0, 50))},
    transcript: \`${body}\`,
    want: [],
    avoid: [/${escapeRe(words)}/i],
  },`;
}

function Extraction({ project }: { project: string }) {
  const [items, setItems] = useState<Extracted[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  useEffect(() => {
    api<{ items: Extracted[] }>(`/evals/extraction${qs(project)}`)
      .then((r) => setItems(r.items))
      .catch((e: Error) => setError(e.message));
  }, [project]);
  const rate = async (m: Extracted, rating: "good" | "junk") => {
    const next = m.rating === rating ? null : rating;
    setItems(
      (xs) =>
        xs?.map((x) => (x.id === m.id ? { ...x, rating: next } : x)) ?? null,
    );
    try {
      await api(`/evals/extraction/${m.id}`, {
        method: "PUT",
        body: { rating: next },
      });
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const copyFixture = async (m: Extracted) => {
    try {
      const r = await api<{ transcriptTail: string }>(
        `/evals/extraction/${m.id}/source`,
      );
      await navigator.clipboard.writeText(
        fixtureSnippet(m.content, r.transcriptTail),
      );
      setNote(
        "Copied. Paste it into packages/api/src/eval/extraction-fixture.ts and write what it should keep in `want`.",
      );
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <section>
      <p>
        <small>
          Memories the extractor wrote. Mark each good or junk. For junk, copy
          an eval case so the extraction prompt gets tested against it.
        </small>
      </p>
      {error && <p role="alert">{error}</p>}
      {note && <p>{note}</p>}
      {items?.length === 0 && <p>No extracted memories yet.</p>}
      <ul className="memories">
        {items?.map((m) => (
          <li key={m.id} className="memory">
            <p>{m.content}</p>
            <small>
              {new Date(m.createdAt).toLocaleString()}
              {m.status !== "active" ? ` · ${m.status}` : ""}
            </small>
            <div className="actions">
              <button
                type="button"
                className={`btn btn-sm ${m.rating === "good" ? "btn-success" : "btn-outline"}`}
                aria-pressed={m.rating === "good"}
                onClick={() => rate(m, "good")}
              >
                Good
              </button>
              <button
                type="button"
                className={`btn btn-sm ${m.rating === "junk" ? "btn-error" : "btn-outline"}`}
                aria-pressed={m.rating === "junk"}
                onClick={() => rate(m, "junk")}
              >
                Junk
              </button>
              {m.rating === "junk" && (
                <button
                  type="button"
                  className="btn btn-sm btn-outline"
                  onClick={() => copyFixture(m)}
                >
                  Copy eval case
                </button>
              )}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

const views = ["Sessions", "Memories", "Extraction"] as const;

export function Evals({ project }: { project: string }) {
  const [view, setView] = useState<(typeof views)[number]>("Sessions");
  return (
    <div>
      <div className="join mb-4">
        {views.map((v) => (
          <button
            key={v}
            type="button"
            className={`btn btn-sm join-item ${v === view ? "btn-active" : ""}`}
            aria-pressed={v === view}
            onClick={() => setView(v)}
          >
            {v}
          </button>
        ))}
      </div>
      {view === "Sessions" ? (
        <Sessions project={project} />
      ) : view === "Memories" ? (
        <MemoryStats project={project} />
      ) : (
        <Extraction project={project} />
      )}
    </div>
  );
}
