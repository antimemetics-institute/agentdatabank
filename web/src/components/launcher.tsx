/* "run it here" — the run button under the builder's oneliner.

   The oneliner stays the first-class artifact; this panel is the SAME condition
   submitted to a runner instead of copied — today the one runner is "this machine"
   (the server's /api/jobs, which nix-builds and spawns locally). buildArgs and
   buildCmd share one encoder (lib/cmd-build setParts), so what the button POSTs and
   what the copy text says are the same `key=value` strings by construction.

   Credentials: profile NAMES travel (the select, the POST, preferences.toml via the
   remember button); values are write-only (the new-profile form POSTs them once,
   straight through to the runner's 0600 store) and never come back — the store this
   panel renders is masked (secrets are literal `true`). The whole panel degrades to
   null when the server lacks the capability (or refuses non-loopback callers): the
   oneliner path is always there. */

import { useEffect, useRef, useState } from "react";
import { buildArgs } from "@/lib/cmd-build";
import { initialProfile, needsSetup, setsUsed, templateRows } from "@/lib/creds";
import { api, apiPost } from "@/lib/data";
import type { CredsInfo, JobInfo, ParamDecl, WorkerInfo } from "@/shared/types";

const INPUT =
  "min-w-0 rounded border bg-background px-2 py-1 font-mono text-xs " +
  "outline-none focus:ring-2 focus:ring-ring";
const BTN = "rounded border px-2 py-1 text-xs hover:bg-muted disabled:opacity-40";

const NEW_PROFILE = "__new__"; /* select sentinel, not a legal profile name */
const TERMINAL = new Set(["completed", "failed", "stopped", "orphaned", "error"]);

/* one credential set's row: profile select + remember + (when needed) the new-profile
   form — the CLI picker's dialogue as widgets */
function SetRow({ set, experiment, creds, choice, setChoice, refresh }: {
  set: string; experiment: string; creds: CredsInfo;
  choice: string | null; setChoice: (p: string | null) => void;
  refresh: () => void;
}) {
  const profiles = Object.keys(creds.store[set] ?? {}).sort();
  const remembered = creds.prefs[experiment]?.[set];
  const fresh = needsSetup(set, creds);
  const selected = choice ?? initialProfile(creds, experiment, set);
  const formOpen = choice === NEW_PROFILE || (fresh && profiles.length === 0);
  const [note, setNote] = useState<string | null>(null);
  const remember = () => {
    if (!selected || selected === NEW_PROFILE) return;
    apiPost("/api/credentials/remember", { experiment, set, profile: selected })
      .then(() => { setNote("remembered — the CLI honors it too"); refresh(); })
      .catch((e: Error) => setNote(e.message));
  };
  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="min-w-24 font-mono text-xs">{set}</span>
        {profiles.length > 0 && (
          <select className={INPUT} value={formOpen ? NEW_PROFILE : (selected ?? "")}
            onChange={(e) => setChoice(e.target.value || null)}>
            {selected === null && <option value="">(choose a profile)</option>}
            {profiles.map((p) => (
              <option key={p} value={p}>
                {p}{p === remembered ? " (remembered)" : ""}
              </option>
            ))}
            <option value={NEW_PROFILE}>new profile…</option>
          </select>
        )}
        {profiles.length > 0 && selected && selected !== NEW_PROFILE && selected !== remembered && (
          <button type="button" className={BTN} onClick={remember}
            title={`always use ${selected} for ${experiment} (writes preferences.toml — the CLI honors it too)`}>
            remember
          </button>
        )}
        {note && <span className="text-[10px] text-muted-foreground">{note}</span>}
      </div>
      {formOpen && (
        <ProfileForm set={set} creds={creds}
          onSaved={(profile) => { setChoice(profile); refresh(); }} />
      )}
    </div>
  );
}

/* the CLI's `credentials set` prompts as a form: registry template rows for
   built-ins, the named-set convention otherwise — rows come off the wire, so the
   browser never duplicates the provider registry */
function ProfileForm({ set, creds, onSaved }: {
  set: string; creds: CredsInfo; onSaved: (profile: string) => void;
}) {
  const rows = templateRows(set, creds);
  const [vals, setVals] = useState<Record<string, string>>({});
  const [profile, setProfile] = useState("default");
  const [problem, setProblem] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const save = () => {
    setSaving(true);
    const values = Object.fromEntries(
      rows.map((r) => [r.key, vals[r.key] ?? ""]).filter(([, v]) => v !== ""));
    apiPost("/api/credentials", { set, profile, values })
      .then(() => onSaved(profile))
      .catch((e: Error) => setProblem(e.message))
      .finally(() => setSaving(false));
  };
  return (
    <div className="ml-4 space-y-1.5 rounded border border-dashed p-2">
      {rows.map((r) => (
        <div key={r.key} className="flex flex-wrap items-center gap-2">
          <label className="min-w-40 font-mono text-[11px] text-muted-foreground">{r.key}</label>
          <input className={`${INPUT} flex-1`} type={r.secret ? "password" : "text"}
            placeholder={r.secret ? "" : r.default} spellCheck={false}
            value={vals[r.key] ?? ""}
            onChange={(e) => setVals((v) => ({ ...v, [r.key]: e.target.value }))} />
        </div>
      ))}
      <div className="flex flex-wrap items-center gap-2">
        <label className="min-w-40 font-mono text-[11px] text-muted-foreground">profile name</label>
        <input className={INPUT} value={profile} spellCheck={false}
          onChange={(e) => setProfile(e.target.value)} />
        <button type="button" className={BTN} disabled={saving} onClick={save}>save</button>
      </div>
      {problem && <p className="text-[10px] text-amber-600 dark:text-amber-400">{problem}</p>}
      <p className="text-[10px] text-muted-foreground/70">
        saved 0600 to <code>{creds.path}</code> — the same store the CLI uses; the key
        never comes back to the browser
      </p>
    </div>
  );
}

function JobPanel({ job, onStop }: { job: JobInfo; onStop: () => void }) {
  const live = !TERMINAL.has(job.phase);
  const chip =
    job.phase === "queued" ? "queued — waiting for a worker…"
    : job.phase === "claimed" ? `claimed by ${job.worker?.name ?? "a worker"}…`
    : job.phase === "building" ? `building (nix, on ${job.worker?.name ?? "worker"})…`
    : job.phase === "running" ? `running on ${job.worker?.name ?? "worker"}…`
    : job.phase;
  const tone =
    job.phase === "completed" ? "text-emerald-600 dark:text-emerald-400"
    : job.phase === "failed" || job.phase === "error" ? "text-red-600 dark:text-red-400"
    : "text-muted-foreground";
  return (
    <div className="space-y-1.5 rounded border p-2">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className={`${tone} ${live ? "animate-pulse" : ""}`}>{chip}</span>
        {job.runs.map((rid) => (
          <a key={rid} href={`#/runs/${rid}`} className="font-mono underline decoration-dotted">
            {rid.slice(-6)}
          </a>
        ))}
        {live && (
          <button type="button" className={`${BTN} ml-auto`} onClick={onStop}
            title="SIGINT, exactly Ctrl-C on the oneliner — partial runs are kept">
            stop
          </button>
        )}
      </div>
      {job.error && <p className="text-[10px] text-red-600 dark:text-red-400">{job.error}</p>}
      {job.log.length > 0 && (
        <pre className="max-h-40 overflow-auto rounded bg-muted/40 p-1.5 text-[10px] leading-snug">
          {job.log.slice(-40).join("\n")}
        </pre>
      )}
    </div>
  );
}

export function Launcher({ name, params, vals, missing }: {
  name: string;
  params: Record<string, ParamDecl>;
  vals: Record<string, string>; /* the builder's seeded values — buildCmd's input */
  missing: string[];
}) {
  /* undefined = loading; null = surface unavailable (older server, non-loopback
     caller, capability off) → render nothing, the oneliner is the path */
  const [creds, setCreds] = useState<CredsInfo | null | undefined>(undefined);
  const [workers, setWorkers] = useState<WorkerInfo[]>([]);
  const [choices, setChoices] = useState<Record<string, string | null>>({});
  const [job, setJob] = useState<JobInfo | null>(null);
  const [launchErr, setLaunchErr] = useState<string | null>(null);
  const [replicates, setReplicates] = useState("1");
  const jobId = useRef<string | null>(null);

  const refresh = () => {
    /* a successful fetch (even with runner:false) means this server has the
       launch surface at all; a 403/404 (older server, non-loopback without the
       token) hides the panel — the oneliner is always the path */
    api<CredsInfo>("/api/credentials")
      .then(setCreds)
      .catch(() => setCreds(null));
  };
  useEffect(refresh, []);

  /* worker presence: the run button is only live while someone can claim the job */
  useEffect(() => {
    const load = () =>
      api<WorkerInfo[]>("/api/workers").then(setWorkers).catch(() => setWorkers([]));
    void load();
    const t = setInterval(() => void load(), 5000);
    return () => clearInterval(t);
  }, []);

  /* the 1s job poll, while one is live */
  useEffect(() => {
    if (!job || TERMINAL.has(job.phase)) return;
    jobId.current = job.id;
    const t = setInterval(() => {
      api<JobInfo>(`/api/jobs/${job.id}`)
        .then((j) => { if (jobId.current === j.id) setJob(j); })
        .catch(() => { /* transient; next tick retries */ });
    }, 1000);
    return () => clearInterval(t);
  }, [job]);

  if (!creds) return null;

  const sets = setsUsed({ name, params }, vals, creds.mock_prefixes);
  const resolved: Record<string, string> = {};
  const unresolved: string[] = [];
  for (const set of sets) {
    const choice = choices[set] ?? initialProfile(creds, name, set);
    if (choice && choice !== NEW_PROFILE) resolved[set] = choice;
    else if (needsSetup(set, creds) || Object.keys(creds.store[set] ?? {}).length > 0)
      unresolved.push(set); /* needs a pick or a first profile; unknown-prefix sets may need nothing */
  }

  const jobActive = job !== null && !TERMINAL.has(job.phase);
  const gate =
    workers.length === 0
      ? "no worker connected — start one: nix run -f . adb-worker"
    : missing.length > 0 ? `set ${missing.join(", ")} first`
    : unresolved.length > 0 ? `credentials needed: ${unresolved.join(", ")}`
    : jobActive ? "a job is already running"
    : null;

  const launch = () => {
    setLaunchErr(null);
    const { sets: setArgs } = buildArgs(params, vals);
    /* the job is the oneliner in structured form MINUS the source — a worker
       builds from the one repo it was registered with; the palette's source
       options are pasting aids, not execution intent */
    apiPost<JobInfo>("/api/jobs", {
      experiment: name,
      sets: setArgs,
      profiles: resolved,
      replicates: Math.max(1, parseInt(replicates, 10) || 1),
    })
      .then(setJob)
      .catch((e: Error) => setLaunchErr(e.message));
  };

  return (
    <div className="space-y-2 border-t pt-3">
      <span className="text-xs text-muted-foreground">
        run it here
        <span className="text-muted-foreground/60">
          {" "}— {workers.length === 0 ? "no workers connected"
            : `worker${workers.length > 1 ? "s" : ""}: ${workers.map((w) => w.name).join(", ")}`}
        </span>
      </span>
      {creds.problem && (
        <p className="text-[10px] text-amber-600 dark:text-amber-400">{creds.problem}</p>
      )}
      {creds.runner && sets.map((set) => (
        <SetRow key={set} set={set} experiment={name} creds={creds}
          choice={choices[set] ?? null}
          setChoice={(p) => setChoices((c) => ({ ...c, [set]: p }))}
          refresh={refresh} />
      ))}
      <div className="flex flex-wrap items-center gap-2">
        <button type="button"
          className="rounded border border-emerald-600/40 bg-emerald-600/10 px-3 py-1 text-xs text-emerald-700 hover:bg-emerald-600/20 disabled:opacity-40 dark:text-emerald-400"
          disabled={gate !== null} title={gate ?? "build and run on this machine"}
          onClick={launch}>
          ▶ run
        </button>
        <label className="flex items-center gap-1 text-[11px] text-muted-foreground">
          × <input className={`${INPUT} w-16`} type="number" min="1" max="100"
            value={replicates} onChange={(e) => setReplicates(e.target.value)} />
          replicates
        </label>
        {gate && <span className="text-[10px] text-muted-foreground">{gate}</span>}
      </div>
      {launchErr && <p className="text-[10px] text-red-600 dark:text-red-400">{launchErr}</p>}
      {job && <JobPanel job={job}
        onStop={() => void apiPost(`/api/jobs/${job.id}/stop`, {}).catch(() => {})} />}
    </div>
  );
}
