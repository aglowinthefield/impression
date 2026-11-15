import { useCallback, useEffect, useState } from "react";
import { api } from "./api";
import { ago } from "./time";

interface Token {
  id: string;
  name: string;
  source: string;
  current: boolean;
  createdAt: string;
  revokedAt: string | null;
  lastUsedAt: string | null;
  lastClient: string | null;
  lastIp: string | null;
  lastRejectedAt: string | null;
  lastRejectedClient: string | null;
  lastRejectedIp: string | null;
}

/** Your tokens, where each was last used, and a way to revoke them. */
export function Tokens() {
  const [tokens, setTokens] = useState<Token[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setTokens((await api<{ items: Token[] }>("/tokens")).items);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const revoke = async (t: Token) => {
    if (!confirm(`Revoke ${t.name}'s ${t.source} token?`)) return;
    try {
      setError(null);
      await api(`/tokens/${t.id}/revoke`, { method: "POST" });
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const active = (tokens ?? []).filter((t) => !t.revokedAt);
  const revoked = (tokens ?? []).filter((t) => t.revokedAt);

  return (
    <section className="mt-8">
      <h2 className="text-base font-semibold">Tokens</h2>
      <table className="table table-sm mt-2">
        <thead>
          <tr>
            <th>Name</th>
            <th>Last used</th>
            <th>From</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {active.map((t) => (
            <tr key={t.id}>
              <td>
                {t.name} <span className="opacity-60">{t.source}</span>
              </td>
              <td>{t.lastUsedAt ? ago(t.lastUsedAt) : "never"}</td>
              <td>
                {t.lastClient}
                {t.lastIp && <span className="opacity-60"> {t.lastIp}</span>}
              </td>
              <td className="text-right">
                {t.current ? (
                  <span className="opacity-60">this browser</span>
                ) : (
                  <button
                    type="button"
                    className="btn btn-xs btn-outline"
                    onClick={() => revoke(t)}
                  >
                    Revoke
                  </button>
                )}
              </td>
            </tr>
          ))}
          {revoked.map((t) => (
            <tr key={t.id} className="opacity-60">
              <td>
                {t.name} <span>{t.source}</span>
              </td>
              <td>revoked {ago(t.revokedAt as string)}</td>
              <td colSpan={2}>
                {t.lastRejectedAt &&
                  t.lastRejectedAt > (t.revokedAt as string) &&
                  `Still tried by ${t.lastRejectedClient}${t.lastRejectedIp ? ` ${t.lastRejectedIp}` : ""} ${ago(t.lastRejectedAt)}`}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
