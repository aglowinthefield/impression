import { useCallback, useEffect, useState } from "react";
import { Activity } from "./Activity";
import {
  ApiError,
  api,
  getToken,
  type Project,
  setToken,
  takeTokenFromHash,
} from "./api";
import { MemoriesPage } from "./Concepts";
import { CONTACT } from "./contact";
import { Debug } from "./Debug";
import { RepoFilter } from "./RepoFilter";
import { Settings } from "./Settings";
import { Start } from "./Start";
import { type SetupStatus, Welcome } from "./Welcome";

function Login({ onDone }: { onDone: () => void }) {
  const [token, setTok] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [github, setGithub] = useState(false);
  // With GitHub sign-in on, the token field is for operators, so it waits behind a link.
  const [useToken, setUseToken] = useState(false);
  useEffect(() => {
    fetch("/auth/config")
      .then((r) => r.json())
      .then((c: { github?: boolean }) => setGithub(c.github === true))
      .catch(() => {});
  }, []);
  return (
    <div className="login-page">
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
        <p className="text-sm opacity-80">
          Memory for your coding agents. It keeps what they learn about your
          repos and hands it back in the next session.
        </p>
        {github && (
          <a className="btn btn-sm btn-primary" href="/auth/github">
            Sign in with GitHub
          </a>
        )}
        <p className="flex justify-between text-sm">
          <a className="link" href="/start">
            Get started
          </a>
          {github && !useToken && (
            <button
              type="button"
              className="link opacity-70"
              onClick={() => setUseToken(true)}
            >
              Use an API token
            </button>
          )}
        </p>
        {(!github || useToken) && (
          <>
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
          </>
        )}
      </form>
    </div>
  );
}

const tabs = ["Memories", "Activity", "Settings", "Debug"] as const;
type Tab = (typeof tabs)[number];

/** Tabs Activity replaced; their old links open Activity. */
const oldTabs = ["review", "evals"];

const GITHUB = "github.com/";

/** `/owner/repo/tab` for GitHub projects; anything else keeps the key in `?project=`. */
const pathFor = (t: Tab, p: string) => {
  const tab = t.toLowerCase();
  if (!p) return `/${tab}`;
  const repo = p.startsWith(GITHUB) ? p.slice(GITHUB.length) : "";
  return repo.split("/").length === 2
    ? `/${repo}/${tab}`
    : `/${tab}?project=${encodeURIComponent(p)}`;
};

const parsePath = (): { tab: Tab; project: string } => {
  const parts = location.pathname.split("/").filter(Boolean);
  const last = parts.length > 0 ? parts[parts.length - 1] : "";
  const tab = oldTabs.includes(last ?? "")
    ? "Activity"
    : (tabs.find((t) => t.toLowerCase() === last) ?? "Memories");
  const repo = parts.length >= 2 && parts.length <= 3 ? parts.slice(0, 2) : [];
  const fromPath =
    repo.length === 2 &&
    !tabs.some((t) => t.toLowerCase() === repo[0]) &&
    !oldTabs.includes(repo[0] ?? "")
      ? `${GITHUB}${repo.join("/")}`
      : "";
  return {
    tab,
    project:
      fromPath || new URLSearchParams(location.search).get("project") || "",
  };
};

/** Keeps the tab and project in the URL, so views can be linked and reloaded. */
function useLocation(): [Tab, string, (t: Tab, p: string) => void] {
  const [, bump] = useState(0);
  useEffect(() => {
    const on = () => bump((n) => n + 1);
    window.addEventListener("popstate", on);
    return () => window.removeEventListener("popstate", on);
  }, []);
  const go = (t: Tab, p: string) => {
    const url = pathFor(t, p);
    if (url !== location.pathname + location.search) {
      history.pushState(null, "", url);
      bump((n) => n + 1);
    }
  };
  const { tab, project } = parsePath();
  return [tab, project, go];
}

function Shell({ onSignOut }: { onSignOut: () => void }) {
  const [who, setWho] = useState("");
  const [admin, setAdmin] = useState(false);
  const [setup, setSetup] = useState<SetupStatus | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [tab, project, go] = useLocation();
  const setProject = (p: string) => go(tab, p);

  useEffect(() => {
    api<{ name: string; admin?: boolean }>("/whoami").then(
      (w) => {
        setWho(w.name);
        setAdmin(w.admin === true);
      },
      () => {},
    );
    api<{ items: Project[] }>("/projects").then(
      (r) => setProjects(r.items),
      () => {},
    );
  }, []);

  // Until the first memory lands, check setup progress every 10 seconds so the
  // welcome steps tick off on their own. Stops once there are memories, or if
  // the server has no /setup.
  const [polling, setPolling] = useState(true);
  useEffect(() => {
    if (!polling) return;
    const load = () =>
      api<SetupStatus>("/setup").then(
        (s) => {
          setSetup(s);
          if (s.memories > 0) setPolling(false);
        },
        () => setPolling(false),
      );
    void load();
    const t = setInterval(load, 10_000);
    return () => clearInterval(t);
  }, [polling]);
  const firstRun = setup !== null && setup.memories === 0;

  const visibleTabs = tabs.filter((t) => t !== "Debug" || admin);

  const filter = (
    <RepoFilter projects={projects} value={project} onChange={setProject} />
  );

  return (
    <div className="shell">
      <header className="navbar bg-base-100 border-base-300 min-h-0 gap-3 border-b px-4 py-2">
        <strong>Impression</strong>
        <nav className="tabs tabs-border">
          {visibleTabs.map((t) => (
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
        <a className="btn btn-sm btn-ghost" href="/start">
          Help
        </a>
        <a className="btn btn-sm btn-ghost" href={`mailto:${CONTACT}`}>
          Feedback
        </a>
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
        {tab === "Memories" && firstRun && setup ? (
          <Welcome status={setup} />
        ) : tab === "Memories" ? (
          <MemoriesPage project={project} filter={filter} />
        ) : tab === "Settings" ? (
          <Settings />
        ) : tab === "Debug" ? (
          <Debug project={project} filter={filter} />
        ) : (
          <Activity project={project} filter={filter} />
        )}
      </main>
    </div>
  );
}

export function App() {
  const [signedIn, setSignedIn] = useState(() => {
    takeTokenFromHash();
    return getToken() !== null;
  });
  // A 401 anywhere clears the token; re-check whenever the tab regains focus.
  const check = useCallback(() => setSignedIn(getToken() !== null), []);
  useEffect(() => {
    window.addEventListener("focus", check);
    return () => window.removeEventListener("focus", check);
  }, [check]);
  if (location.pathname === "/start") return <Start signedIn={signedIn} />;
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
