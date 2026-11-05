import { useCallback, useEffect, useState } from "react";
import { api } from "./api";

interface Proposal {
  id: string;
  content: string;
  confidence: number | null;
  anchors: { path: string; symbol?: string | null }[] | null;
  sessionExcerpt: string | null;
}

function Card({ p, onDone }: { p: Proposal; onDone: () => void }) {
  const [text, setText] = useState(p.content);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const edited = text.trim() !== p.content;
  const act = async (path: string, body?: unknown) => {
    try {
      setError(null);
      setBusy(path);
      await api(`/proposals/${p.id}/${path}`, {
        method: "POST",
        body: body ?? {},
      });
      onDone();
      setBusy(null);
    } catch (e) {
      setError((e as Error).message);
      setBusy(null);
    }
  };
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
          disabled={busy !== null}
          onClick={() =>
            act("accept", edited ? { content: text.trim() } : undefined)
          }
        >
          {busy === "accept" && (
            <span className="loading loading-spinner loading-xs" />
          )}
          {busy === "accept"
            ? "Accepting…"
            : edited
              ? "Accept edited"
              : "Accept"}
        </button>
        <button
          className="btn btn-sm btn-error btn-outline"
          type="button"
          disabled={busy !== null}
          onClick={() => act("reject")}
        >
          Reject
        </button>
      </div>
      {error && <p role="alert">{error}</p>}
    </li>
  );
}

export function Proposals({ project }: { project: string }) {
  const [items, setItems] = useState<Proposal[] | null>(null);
  const [error, setError] = useState<string | null>(null);
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
  return (
    <section>
      {error && <p role="alert">{error}</p>}
      {items?.length === 0 && <p>Nothing waiting for review.</p>}
      <ul className="memories">
        {items?.map((p) => (
          <Card key={p.id} p={p} onDone={load} />
        ))}
      </ul>
    </section>
  );
}
