import { spawn } from "node:child_process";

const GITHUB = "github.com/";

/** The web dashboard's Memories tab for a project, matching the web app's own URLs. */
export function dashboardUrl(server: string, projectKey: string): string {
  const base = server.replace(/\/+$/, "");
  const repo = projectKey.startsWith(GITHUB)
    ? projectKey.slice(GITHUB.length)
    : "";
  return repo.split("/").length === 2
    ? `${base}/${repo}/memories`
    : `${base}/memories?project=${encodeURIComponent(projectKey)}`;
}

/** The command that opens a URL in the default browser on this platform. */
export function openCommand(
  url: string,
  platform: NodeJS.Platform = process.platform,
): [string, string[]] {
  if (platform === "darwin") return ["open", [url]];
  // The empty string is start's window title; without it a quoted URL becomes the title.
  if (platform === "win32") return ["cmd", ["/c", "start", "", url]];
  return ["xdg-open", [url]];
}

/** Opens a URL in the browser without waiting. Fails quietly: callers print the URL too. */
export function openUrl(url: string): void {
  const [cmd, args] = openCommand(url);
  try {
    const child = spawn(cmd, args, { detached: true, stdio: "ignore" });
    child.on("error", () => {});
    child.unref();
  } catch {
    // No opener on this machine; the printed URL is enough.
  }
}
