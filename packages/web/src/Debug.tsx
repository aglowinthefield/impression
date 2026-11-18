import { useCallback, useEffect, useState } from "react";
import { api } from "./api";
import { Evals } from "./Evals";

interface Entry {
  at: string;
  method: string;
  path: string;
  query: Record<string, string>;
  principal: string | null;
  client: string;
  status: number;
  ms: number;
  error?: string;
  items?: number;
}

/** "Mozilla/5.0 ... Chrome/156.0" becomes "Chrome 156"; other agents keep their first token. */
export function shortClient(ua: string): string {
  const browser = /(Edg|Firefox|HeadlessChrome|Chrome|Safari)\/(\d+)/.exec(ua);
  if (ua.startsWith("Mozilla/") && browser)
    return `${browser[1] === "Edg" ? "Edge" : browser[1]} ${browser[2]}`;
  return ua.split(" ")[0]?.split("/")[0] || "unknown";
}

const views = ["Requests", "Evals"] as const;

/** Developer tools: recent requests, and the hand-rating eval harness. */
export function Debug({ project }: { project: string }) {
  const [view, setView] = useState<(typeof views)[number]>("Requests");
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
      {view === "Requests" ? <Requests /> : <Evals project={project} />}
    </div>
  );
}

/** Recent API requests from your token, to check whether an agent is reaching the server. */
function Requests() {
  const [items, setItems] = useState<Entry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      setItems((await api<{ items: Entry[] }>("/debug/requests")).items);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);
  useEffect(() => {
    load();
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, [load]);
  return (
    <section>
      <p>
        <small>
          Last requests to this server since it started. Refreshes every 3s.
        </small>
      </p>
      {error && <p role="alert">{error}</p>}
      {items?.length === 0 && (
        <p>
          No requests yet. If your agent is running, it isn't reaching here.
        </p>
      )}
      <div className="overflow-x-auto">
        <table className="debug">
          <thead>
            <tr>
              <th>Time</th>
              <th>Status</th>
              <th>Request</th>
              <th>Result</th>
              <th>User</th>
              <th>Client</th>
              <th className="text-right">Duration</th>
            </tr>
          </thead>
          <tbody>
            {items?.map((e) => (
              <tr
                key={`${e.at}${e.method}${e.path}${e.client}`}
                data-ok={e.status < 400}
              >
                <td>{new Date(e.at).toLocaleTimeString()}</td>
                <td>{e.status}</td>
                <td>
                  {e.method} {e.path.replace(/^\/api/, "")}
                  {Object.keys(e.query).length > 0 &&
                    `?${new URLSearchParams(e.query)}`}
                </td>
                <td>
                  {e.error ?? (e.items !== undefined ? `${e.items} items` : "")}
                </td>
                <td>{e.principal ?? "no auth"}</td>
                <td>{shortClient(e.client)}</td>
                <td className="text-right">{e.ms}ms</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
