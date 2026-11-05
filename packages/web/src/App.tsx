import { useCallback, useEffect, useState } from "react";
import { ApiError, api, getToken, type Project, setToken } from "./api";
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
          type="password"
          value={token}
          onChange={(e) => setTok(e.target.value)}
          placeholder="imp_..."
        />
      </label>
      {error && <p role="alert">{error}</p>}
      <button type="submit" disabled={!token.trim()}>
        Sign in
      </button>
    </form>
  );
}

const tabs = ["Memories", "Proposals", "Review"] as const;

function Shell({ onSignOut }: { onSignOut: () => void }) {
  const [who, setWho] = useState("");
  const [projects, setProjects] = useState<Project[]>([]);
  const [project, setProject] = useState(
    () => localStorage.getItem(PROJECT_KEY) ?? "",
  );
  const [tab, setTab] = useState<(typeof tabs)[number]>("Memories");

  useEffect(() => {
    api<{ name: string }>("/whoami").then(
      (w) => setWho(w.name),
      () => {},
    );
    api<{ items: Project[] }>("/projects").then(
      (r) => {
        setProjects(r.items);
        setProject((cur) =>
          r.items.some((p) => p.key === cur) ? cur : (r.items[0]?.key ?? ""),
        );
      },
      () => {},
    );
  }, []);
  useEffect(() => {
    if (project) localStorage.setItem(PROJECT_KEY, project);
  }, [project]);

  return (
    <div className="shell">
      <header>
        <strong>Impression</strong>
        <select
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
        <nav>
          {tabs.map((t) => (
            <button
              type="button"
              key={t}
              aria-current={t === tab}
              onClick={() => setTab(t)}
            >
              {t}
            </button>
          ))}
        </nav>
        <span className="spacer" />
        <span>{who}</span>
        <button type="button" onClick={onSignOut}>
          Sign out
        </button>
      </header>
      <main>
        {tab === "Memories" ? (
          <Memories project={project} />
        ) : tab === "Proposals" ? (
          <Proposals project={project} />
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
