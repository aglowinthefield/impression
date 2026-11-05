import { useCallback, useEffect, useState } from "react";
import { api } from "./api";

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

/** Recent API requests from your token, to check whether an agent is reaching the server. */
export function Debug() {
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
      <table className="debug">
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
              <td>{e.client}</td>
              <td>{e.ms}ms</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
