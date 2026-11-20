import type { ReactNode } from "react";
import { Command, SETUP_COMMAND, useInstallUrl } from "./Start";

export interface SetupStatus {
  name: string;
  admin: boolean;
  /** Repos the GitHub app reaches. Null for admin tokens, which reach everything. */
  repos: number | null;
  cliSignedIn: boolean;
  sessions: number;
  memories: number;
}

function Step({
  done,
  title,
  children,
}: {
  done: boolean;
  title: string;
  children?: ReactNode;
}) {
  return (
    <li className="step-item" data-done={done}>
      <span className="step-n" role="img" aria-label={done ? "done" : "to do"}>
        {done ? "✓" : ""}
      </span>
      <div>
        <h3>{title}</h3>
        {!done && children}
      </div>
    </li>
  );
}

/** The Memories tab for someone with no memories yet: what's left to set up, ticked off as it happens. */
export function Welcome({ status }: { status: SetupStatus }) {
  const installUrl = useInstallUrl();
  const reposOk = status.repos === null || status.repos > 0;
  return (
    <section className="welcome card bg-base-100 border-base-300 border p-6">
      <h2 className="text-lg font-semibold">Welcome, {status.name}</h2>
      <p className="opacity-80">
        Three steps, and your agent starts remembering. This page ticks them off
        as they happen.
      </p>
      <ol className="steps-list">
        <Step
          done={reposOk}
          title={
            status.repos === null
              ? "This token reaches every repo"
              : status.repos > 0
                ? `The GitHub app reaches ${status.repos} repo${status.repos === 1 ? "" : "s"}`
                : "Give the GitHub app your repos"
          }
        >
          <p>
            Impression works only in repos the app can see.{" "}
            {installUrl && (
              <a className="link" href={installUrl}>
                Choose repos
              </a>
            )}
          </p>
        </Step>
        <Step
          done={status.cliSignedIn}
          title={
            status.cliSignedIn
              ? "A machine is set up"
              : "Run setup on the machine you code on"
          }
        >
          <Command text={SETUP_COMMAND} />
          <p className="text-sm opacity-80">
            It signs the machine in and installs Impression into your agents.
            Needs Node 22 or later.
          </p>
        </Step>
        <Step
          done={status.sessions > 0}
          title={
            status.sessions > 0
              ? "Your first session arrived. Memories appear here as they're extracted."
              : "Start a session in one of those repos"
          }
        >
          <p className="text-sm opacity-80">
            Your agent shows <em>Impression is on</em> at session start. Work as
            usual; memories show up here a minute or so after the session sends.
            Later, ask your agent{" "}
            <em>"What does Impression know about this repo?"</em>
          </p>
        </Step>
      </ol>
      <p className="text-sm">
        <a className="link" href="/start">
          More about how it works
        </a>
      </p>
    </section>
  );
}
