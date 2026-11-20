import { type ReactNode, useEffect, useState } from "react";
import { CONTACT } from "./contact";

export const SETUP_COMMAND = "npx @aglowinthefield/impression setup";

/** The GitHub app's install link, from the server. Null until known or when GitHub sign-in is off. */
export function useInstallUrl(): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    fetch("/auth/config")
      .then((r) => r.json())
      .then((c: { installUrl?: string }) => setUrl(c.installUrl ?? null))
      .catch(() => {});
  }, []);
  return url;
}

/** A command to copy, with a button that copies it. */
export function Command({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="command">
      <code>{text}</code>
      <button
        type="button"
        className="btn btn-xs btn-ghost"
        onClick={() => {
          void navigator.clipboard?.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
      >
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

function Step({
  n,
  title,
  id,
  children,
}: {
  n: number;
  title: string;
  id?: string;
  children: ReactNode;
}) {
  return (
    <li id={id} className="step-item">
      <span className="step-n">{n}</span>
      <div>
        <h3>{title}</h3>
        {children}
      </div>
    </li>
  );
}

/** The public Get started page at /start. */
export function Start({ signedIn }: { signedIn: boolean }) {
  const installUrl = useInstallUrl();
  // Anchors like /start#repos are rendered after mount, so scroll once they exist.
  useEffect(() => {
    if (location.hash) document.querySelector(location.hash)?.scrollIntoView();
  }, []);
  return (
    <div className="start-page">
      <article className="start">
        <header className="flex items-center gap-3">
          <a href="/" className="font-semibold">
            Impression
          </a>
          <span className="spacer" />
          <a className="btn btn-sm btn-primary" href="/">
            {signedIn ? "Open dashboard" : "Sign in"}
          </a>
        </header>

        <h1>Get started</h1>
        <p>
          Impression gives your coding agent a memory. After each session it
          saves what's worth keeping: commands, conventions, decisions and
          gotchas. At the start of the next session, and with each prompt, it
          hands the relevant ones back. It works with Claude Code, Codex, pi and
          oh-my-pi.
        </p>

        <ol className="steps-list">
          <Step n={1} title="Sign in with GitHub">
            <p>
              Your GitHub account needs to be on this server's allowlist. If
              sign-in says it isn't, ask the person who invited you.
            </p>
          </Step>
          <Step n={2} title="Install the Impression GitHub app" id="repos">
            <p>
              Impression works only in repos the app can see. The app reads repo
              names and visibility, never code. Choose{" "}
              <strong>All repositories</strong> unless you want to keep some
              out; a repo left out gets no memories, and your agent says so at
              session start.
            </p>
            <p>
              For a repo owned by an organization, an owner of that organization
              has to install the app, or approve your request to.
            </p>
            {installUrl && (
              <p>
                <a className="link" href={installUrl}>
                  Install or change the app's repos
                </a>
              </p>
            )}
          </Step>
          <Step n={3} title="Run setup on each machine you code on">
            <Command text={SETUP_COMMAND} />
            <p>
              It signs the machine in, asks which of your agents should use
              Impression, and installs it into each. It needs Node 22 or later,
              and it's safe to run again.
            </p>
          </Step>
          <Step n={4} title="Work as usual">
            <p>
              Until a repo has memories, your agent shows{" "}
              <em>Impression is on</em> at session start. Memories reach the
              dashboard a minute or so after a session sends: when it ends, and
              in pi and oh-my-pi also every few thousand characters. After that,
              your agent says how many memories it got.{" "}
              <a className="link" href="#at-work">
                See it at work
              </a>
            </p>
          </Step>
        </ol>

        <h2 id="at-work">See it at work</h2>
        <h3 id="how">How memories reach your agent</h3>
        <ol className="list-decimal space-y-2 pl-5">
          <li>
            <strong>At session start,</strong> Impression picks a short set,
            about 800 tokens: how you like to work first, then this repo's
            memories, the ones it's most sure of first. Memories tied to one
            folder come in only when you work in that folder. Memories flagged
            as possibly out of date, and ones replaced by newer memories, stay
            out.
          </li>
          <li>
            <strong>With each prompt,</strong> it searches your memories for the
            prompt's meaning and its words, and adds up to 5 that match closely.
            It's stricter here than in a normal search, because a wrong memory
            in your prompt costs more than a missing one. pi and oh-my-pi skip
            very short prompts like "yes" and memories already shown in the
            session.
          </li>
          <li>
            <strong>When the agent asks,</strong> it uses the Impression search
            tool to look up more in the middle of a task, and the add tool to
            save something you tell it to remember.
          </li>
        </ol>
        <p>
          The memories reach the agent as a note beside your prompt, which it
          reads but you don't see in the conversation. That's why it shows you a
          count. Only your own memories and ones shared with your team are used,
          and only in repos the GitHub app reaches.
        </p>
        <h3>Check what it did</h3>
        <p>
          Your agent shows how many memories Impression gave it: in the footer
          in pi and oh-my-pi, and as a message at session start and on matching
          prompts in Claude Code and Codex.
        </p>
        <p>Ask your agent what Impression knows. Try:</p>
        <Command text="What does Impression know about this repo?" />
        <p>
          It searches your memories with the Impression tool and answers from
          them. Ask about anything you've told it before: how you deploy, which
          commands to run, what to avoid.
        </p>
        <p>
          On the dashboard, each memory says how often it reached your agents.
          Retire anything wrong. A memory that's never used is probably noise.
        </p>
        <p>To check that a repo is set up, run this in it:</p>
        <Command text="npx @aglowinthefield/impression status" />

        <h2 id="data">What leaves your machine</h2>
        <p>
          Session transcripts go to this server. It removes the secrets it
          recognizes, such as API keys, tokens and private keys, then sends the
          text to Anthropic to pick out memories and to OpenAI to index them for
          search. Only you can see your memories in Impression. The server's
          operator can read stored transcripts.
        </p>

        <h2>Remove Impression</h2>
        <p>Remove the plugin with your agent's own command:</p>
        <ul className="list-disc pl-5">
          <li>
            Claude Code:{" "}
            <code>claude plugin uninstall impression@impression</code>
          </li>
          <li>
            Codex: <code>codex plugin remove impression@impression</code>
          </li>
          <li>
            pi: <code>pi remove npm:@aglowinthefield/impression</code>
          </li>
          <li>
            oh-my-pi:{" "}
            <code>omp plugin uninstall @aglowinthefield/impression</code>
          </li>
        </ul>
        <p>
          To delete your sessions and memories from this server, email{" "}
          <a className="link" href={`mailto:${CONTACT}`}>
            {CONTACT}
          </a>
          . Questions and feedback go there too.
        </p>
      </article>
    </div>
  );
}
