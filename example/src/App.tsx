import "./App.css";
import { useAction, useConvexConnectionState, useQuery } from "convex/react";
import { ConvexError } from "convex/values";
import { useEffect, useState } from "react";
import type { RunResult } from "orgo-convex";
import { api } from "../convex/_generated/api";

type Last =
  | { kind: "run"; label: string; code: string; result: RunResult }
  | { kind: "file"; path: string; written: string; readBack: string };

const OUTCOME: Record<string, string> = {
  running: "Running",
  succeeded: "Succeeded",
  failed: "Failed",
  timed_out: "Timed out",
  error: "Refused by Orgo",
  unknown: "Outcome unknown",
};

function outcome(status: string, exitCode?: number) {
  const word = OUTCOME[status] ?? status;
  return status === "failed" && exitCode !== undefined ? `${word} (exit ${exitCode})` : word;
}

/** Why an action failed, in a sentence a visitor can act on. */
function explain(e: unknown): string {
  const data =
    e instanceof ConvexError ? (e.data as { code?: string; message?: string }) : undefined;
  if (data?.code === "busy")
    return "Someone just ran something. Actions are spaced three seconds apart; try again in a moment.";
  if (data?.code === "not_configured")
    return "This demo has no computer yet. Its operator creates one with npx convex run demo:setup.";
  if (data?.code === "paused")
    return "This demo is paused by its operator. Results already on the page stay.";
  if (data?.code === "daily_limit")
    return "This demo has used today's allowance of actions. It opens again at midnight UTC.";
  if (data?.message) return data.message;
  return "That didn't work. Try again in a moment.";
}

function useNow(intervalMs: number) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

function ago(ms: number) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 5) return "just now";
  if (s < 90) return `${s} s ago`;
  return `${Math.round(s / 60)} min ago`;
}

/** True once the backend has been unreachable for a few seconds (brief blips stay quiet). */
function useOffline(graceMs = 4_000) {
  const connected = useConvexConnectionState().isWebSocketConnected;
  const [waitedOut, setWaitedOut] = useState(false);
  useEffect(() => {
    if (connected) return;
    const id = setTimeout(() => setWaitedOut(true), graceMs);
    return () => {
      clearTimeout(id);
      setWaitedOut(false);
    };
  }, [connected, graceMs]);
  return !connected && waitedOut;
}

/** The computer's state as a shape: filled when running, hollow when not, dashed when unknown. */
function StateMark({ status }: { status: string }) {
  const kind =
    status === "running"
      ? "on"
      : ["creating", "error", "deleted"].includes(status)
        ? "unknown"
        : "off";
  return <span className={`mark mark-${kind}`} aria-hidden="true" />;
}

export default function App() {
  const state = useQuery(api.demo.state);
  const presets = useQuery(api.demo.presets);
  const runPreset = useAction(api.demo.runPreset);
  const takeScreenshot = useAction(api.demo.takeScreenshot);
  const fileRoundTrip = useAction(api.demo.fileRoundTrip);
  const refresh = useAction(api.demo.refresh);
  const now = useNow(5_000);
  const offline = useOffline();

  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [last, setLast] = useState<Last | null>(null);

  async function act(key: string, fn: () => Promise<unknown>) {
    setBusy(key);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(explain(e));
    } finally {
      setBusy(null);
    }
  }

  const computer = state?.configured ? state.computer : null;

  return (
    <main className="page">
      <header className="intro">
        <h1>Orgo for Convex</h1>
        <p className="lead">
          This page is a Convex app driving a real Orgo cloud computer through the{" "}
          <code>orgo-convex</code> component. Each command below runs on that computer; its result
          lands in the component&rsquo;s tables and reaches this page through a reactive query.
        </p>
        {offline && (
          <p className="error" role="status">
            Can&rsquo;t reach this demo&rsquo;s backend. It keeps retrying on its own; anything
            already on the page stays.
          </p>
        )}
        {state === undefined ? (
          <p className="computer muted">{offline ? "Waiting for the backend…" : "Loading…"}</p>
        ) : !state.configured || !computer ? (
          <p className="computer muted">
            This demo has no computer yet. Its operator creates one with{" "}
            <code>npx convex run demo:setup</code>.
          </p>
        ) : (
          <p className="computer">
            <StateMark status={computer.status} />
            <span className="computer-status">
              {computer.status[0].toUpperCase() + computer.status.slice(1)}
            </span>
            <span className="muted">
              {computer.os} · checked {ago(now - computer.observedAt)}
            </span>
            <button
              className="link"
              disabled={busy !== null}
              onClick={() => act("refresh", () => refresh({}))}
            >
              {busy === "refresh" ? "Checking…" : "Check again"}
            </button>
          </p>
        )}
      </header>

      <div className="columns">
        <section className="controls" aria-labelledby="run-heading">
          <h2 id="run-heading">Run something</h2>
          <ul className="presets">
            {(presets ?? []).map((p) => (
              <li key={p.name}>
                <div className="preset-text">
                  <span className="preset-label">{p.label}</span>
                  <pre className="preset-code">{p.code}</pre>
                </div>
                <button
                  className="primary"
                  disabled={busy !== null || !computer}
                  onClick={() =>
                    act(p.name, async () => {
                      const result = await runPreset({ preset: p.name });
                      setLast({ kind: "run", label: p.label, code: p.code, result });
                    })
                  }
                >
                  {busy === p.name ? "Running…" : "Run"}
                </button>
              </li>
            ))}
          </ul>

          <h2>Screen and files</h2>
          <div className="pair">
            <button
              className="secondary"
              disabled={busy !== null || !computer}
              onClick={() => act("shot", () => takeScreenshot({}))}
            >
              {busy === "shot" ? "Capturing…" : "Take a screenshot"}
            </button>
            <button
              className="secondary"
              disabled={busy !== null || !computer}
              onClick={() =>
                act("file", async () => {
                  const r = await fileRoundTrip({});
                  setLast({ kind: "file", path: r.path, written: r.written, readBack: r.readBack });
                })
              }
            >
              {busy === "file" ? "Writing…" : "Write a file and read it back"}
            </button>
          </div>
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
        </section>

        <section className="results" aria-label="Results">
          <div className="terminal" aria-live="polite">
            {last === null ? (
              <p className="terminal-empty">Run something and its output appears here.</p>
            ) : last.kind === "run" ? (
              <>
                <p className="terminal-head">
                  {last.label} · {outcome(last.result.status, last.result.exitCode)} ·{" "}
                  {last.result.durationMs} ms
                </p>
                <pre>{last.result.output || "(no output)"}</pre>
              </>
            ) : (
              <>
                <p className="terminal-head">Wrote and read back {last.path}</p>
                <pre>{last.readBack}</pre>
                <p className="terminal-foot">
                  {last.readBack === last.written
                    ? "Same bytes both ways."
                    : "The text came back different."}
                </p>
              </>
            )}
          </div>

          {state?.configured && state.screenshot?.url && (
            <figure className="shot">
              <img
                src={state.screenshot.url}
                width={state.screenshot.width}
                height={state.screenshot.height}
                alt="The computer's screen, captured by the component"
              />
              <figcaption className="muted">
                Screen, {state.screenshot.width}×{state.screenshot.height}, captured{" "}
                {ago(now - state.screenshot.takenAt)}
              </figcaption>
            </figure>
          )}

          <h2>Recent runs</h2>
          {state?.configured && state.executions.length > 0 ? (
            <table className="history">
              <thead>
                <tr>
                  <th scope="col">When</th>
                  <th scope="col">Kind</th>
                  <th scope="col">Outcome</th>
                  <th scope="col" className="num">
                    Time
                  </th>
                </tr>
              </thead>
              <tbody>
                {state.executions.map((x) => (
                  <tr key={x.id} className={x.status === "running" ? "is-running" : undefined}>
                    <td>{ago(now - x.startedAt)}</td>
                    <td>{x.kind === "python" ? "Python" : "Shell"}</td>
                    <td>
                      {x.status === "running" && (
                        <span className="mark mark-on breathing" aria-hidden="true" />
                      )}
                      {outcome(x.status, x.exitCode)}
                    </td>
                    <td className="num">
                      {x.finishedAt ? `${((x.finishedAt - x.startedAt) / 1000).toFixed(1)} s` : "…"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="muted">
              Nothing has run yet. Runs appear here as they start, then settle when they finish.
            </p>
          )}
        </section>
      </div>

      <footer className="foot muted">
        Built with <code>orgo-convex</code>. The demo stores run metadata only; command output is
        shown here and not kept.
      </footer>
    </main>
  );
}
