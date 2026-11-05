import { useCallback, useEffect, useState } from "react";
import { api } from "./api";

interface Proposal {
  id: string;
  content: string;
  confidence: number | null;
  anchors: { path: string; symbol?: string | null }[] | null;
  sessionExcerpt: string | null;
}

function Card({
  p,
  onAct,
}: {
  p: Proposal;
  onAct: (p: Proposal, path: string, body?: unknown) => void;
}) {
  const [text, setText] = useState(p.content);
  const edited = text.trim() !== p.content;
  const act = onAct.bind(null, p);
  return (
    <li className="memory">
      <textarea
        className="textarea w-full"
        aria-label="Proposed memory"
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={2}
      />
      <small>
        {p.confidence !== null
          ? `confidence ${Math.round(p.confidence * 100)}%`
          : ""}
        {p.anchors?.length
          ? ` · ${p.anchors.map((a) => (a.symbol ? `${a.path}#${a.symbol}` : a.path)).join(", ")}`
          : ""}
      </small>
      {p.sessionExcerpt && (
        <details>
          <summary>Source session</summary>
          <pre>{p.sessionExcerpt}</pre>
        </details>
      )}
      <div className="actions">
        <button
          className="btn btn-sm btn-primary"
          type="button"
          onClick={() =>
            act("accept", edited ? { content: text.trim() } : undefined)
          }
        >
          {edited ? "Accept edited" : "Accept"}
        </button>
        <button
          className="btn btn-sm btn-error btn-outline"
          type="button"
          onClick={() => act("reject")}
        >
          Reject
        </button>
      </div>
    </li>
  );
}

export function Proposals({ project }: { project: string }) {
  const [items, setItems] = useState<Proposal[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const load = useCallback(async () => {
    try {
      const q = project ? `?project=${encodeURIComponent(project)}` : "";
      setItems((await api<{ items: Proposal[] }>(`/proposals${q}`)).items);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [project]);
  useEffect(() => {
    load();
  }, [load]);
  // The card leaves the list at once. The server may still be deduping, which
  // can take seconds, so on failure the card comes back with an error.
  const act = (p: Proposal, path: string, body?: unknown) => {
    setError(null);
    setHidden((h) => new Set(h).add(p.id));
    const show = () =>
      setHidden((h) => {
        const n = new Set(h);
        n.delete(p.id);
        return n;
      });
    api(`/proposals/${p.id}/${path}`, { method: "POST", body: body ?? {} })
      .then(() => load().then(show))
      .catch((e: Error) => {
        setError(`Could not ${path} "${p.content.slice(0, 40)}": ${e.message}`);
        show();
      });
  };
  const visible = items?.filter((p) => !hidden.has(p.id));
  return (
    <section>
      {error && <p role="alert">{error}</p>}
      {visible?.length === 0 && <p>Nothing waiting for review.</p>}
      <ul className="memories">
        {visible?.map((p) => (
          <Card key={p.id} p={p} onAct={act} />
        ))}
      </ul>
    </section>
  );
}
