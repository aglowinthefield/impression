import { useCallback, useEffect, useState } from "react";
import { ApiError, api, getToken, type Project, setToken } from "./api";
import { Debug } from "./Debug";
import { Memories } from "./Memories";
import { Proposals } from "./Proposals";
import { Review } from "./Review";

const PROJECT_KEY = "impression.project";

function Login({ onDone }: { onDone: () => void }) {
  const [token, setTok] = useState("");
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      className="login"
      onSubmit={async (e) => {
        e.preventDefault();
        try {
          await api("/whoami", { token: token.trim() });
          setToken(token.trim());
          onDone();
        } catch (err) {
          setError(
            err instanceof ApiError && err.status === 401
              ? "That token isn't valid."
              : "Couldn't reach the server.",
          );
        }
      }}
    >
      <h1>Impression</h1>
      <label>
        API token
        <input
          className="input input-sm"
          type="password"
          value={token}
          onChange={(e) => setTok(e.target.value)}
          placeholder="imp_..."
        />
      </label>
      {error && <p role="alert">{error}</p>}
      <button
        className="btn btn-sm btn-primary"
        type="submit"
        disabled={!token.trim()}
      >
        Sign in
      </button>
    </form>
  );
}

const tabs = ["Memories", "Proposals", "Review", "Debug"] as const;
type Tab = (typeof tabs)[number];

const tabFromPath = (): Tab =>
  tabs.find((t) => `/${t.toLowerCase()}` === location.pathname) ?? "Memories";

/** Keeps the tab in the path and the project in `?project=`, so views can be linked and reloaded. */
function useLocation(): [Tab, string, (t: Tab, p: string) => void] {
  const [, bump] = useState(0);
  useEffect(() => {
    const on = () => bump((n) => n + 1);
    window.addEventListener("popstate", on);
    return () => window.removeEventListener("popstate", on);
  }, []);
  const go = (t: Tab, p: string) => {
    const url = `/${t.toLowerCase()}${p ? `?project=${encodeURIComponent(p)}` : ""}`;
    if (url !== location.pathname + location.search) {
      history.pushState(null, "", url);
      bump((n) => n + 1);
    }
  };
  return [
    tabFromPath(),
    new URLSearchParams(location.search).get("project") ??
      localStorage.getItem(PROJECT_KEY) ??
      "",
    go,
  ];
}

function Shell({ onSignOut }: { onSignOut: () => void }) {
  const [who, setWho] = useState("");
  const [projects, setProjects] = useState<Project[]>([]);
  const [tab, project, go] = useLocation();
  const setProject = (p: string) => go(tab, p);

  useEffect(() => {
    api<{ name: string }>("/whoami").then(
      (w) => setWho(w.name),
      () => {},
    );
    api<{ items: Project[] }>("/projects").then(
      (r) => {
        setProjects(r.items);
        const cur =
          new URLSearchParams(location.search).get("project") ??
          localStorage.getItem(PROJECT_KEY) ??
          "";
        const next = r.items.some((p) => p.key === cur)
          ? cur
          : (r.items[0]?.key ?? "");
        if (next !== cur)
          history.replaceState(
            null,
            "",
            `${location.pathname}?project=${encodeURIComponent(next)}`,
          );
        localStorage.setItem(PROJECT_KEY, next);
        window.dispatchEvent(new PopStateEvent("popstate"));
      },
      () => {},
    );
  }, []);
  useEffect(() => {
    if (project) localStorage.setItem(PROJECT_KEY, project);
  }, [project]);

  return (
    <div className="shell">
      <header className="navbar bg-base-100 border-base-300 min-h-0 gap-3 border-b px-4 py-2">
        <strong>Impression</strong>
        <select
          className="select select-sm w-auto"
          aria-label="Project"
          value={project}
          onChange={(e) => setProject(e.target.value)}
        >
          {projects.length === 0 && <option value="">No projects yet</option>}
          {projects.map((p) => (
            <option key={p.key} value={p.key}>
              {p.name}
            </option>
          ))}
        </select>
        <nav className="tabs tabs-border">
          {tabs.map((t) => (
            <button
              className={t === tab ? "tab tab-active font-semibold" : "tab"}
              type="button"
              key={t}
              aria-current={t === tab}
              onClick={() => go(t, project)}
            >
              {t}
            </button>
          ))}
        </nav>
        <span className="spacer" />
        <span>{who}</span>
        <button
          className="btn btn-sm btn-ghost"
          type="button"
          onClick={onSignOut}
        >
          Sign out
        </button>
      </header>
      <main>
        {tab === "Memories" ? (
          <Memories project={project} />
        ) : tab === "Proposals" ? (
          <Proposals project={project} />
        ) : tab === "Debug" ? (
          <Debug />
        ) : (
          <Review project={project} />
        )}
      </main>
    </div>
  );
}

export function App() {
  const [signedIn, setSignedIn] = useState(() => getToken() !== null);
  // A 401 anywhere clears the token; re-check whenever the tab regains focus.
  const check = useCallback(() => setSignedIn(getToken() !== null), []);
  useEffect(() => {
    window.addEventListener("focus", check);
    return () => window.removeEventListener("focus", check);
  }, [check]);
  return signedIn ? (
    <Shell
      onSignOut={() => {
        setToken(null);
        setSignedIn(false);
      }}
    />
  ) : (
    <Login onDone={() => setSignedIn(true)} />
  );
}
