/* "run it here" — the builder's run tab (the sibling of the oneliner tab).

   The oneliner stays the first-class artifact; this panel is the SAME condition
   submitted to a runner instead of copied — today the one runner is "this machine"
   (the server's /api/jobs, which nix-builds and spawns locally). buildArgs and
   buildCmd share one encoder (lib/cmd-build setParts), so what the button POSTs and
   what the copy text says are the same `key=value` strings by construction.

   Credentials: profile NAMES travel (the select, the POST, preferences.toml via the
   remember button); values are write-only (the new-profile form POSTs them once,
   straight through to the runner's 0600 store) and never come back — the store this
   panel renders is masked (secrets are literal `true`). Capability sensing lives in
   useLaunchSurface (the builder gates the whole run tab on it): when the server
   lacks the surface or refuses this caller, the tab never exists and the oneliner
   path is always there. */

import { ArrowDown } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { buildArgs } from "@/lib/cmd-build";
import { initialProfile, needsSetup, setsUsed, templateRows } from "@/lib/creds";
import { api, apiPost, JOB_TERMINAL, useExecutorPoll } from "@/lib/data";
import type { CredsInfo, JobInfo, ParamDecl } from "@/shared/types";

const INPUT =
  "min-w-0 rounded border bg-background px-2 py-1 font-mono text-xs " +
  "outline-none focus:ring-2 focus:ring-ring";
const BTN = "rounded border px-2 py-1 text-xs hover:bg-muted disabled:opacity-40";

const NEW_PROFILE = "__new__"; /* select sentinel, not a legal profile name */

/* the launch surface probe, lifted out of the panel so the builder can decide
   whether a run tab exists at all: undefined = probing, null = unavailable
   (older server, read-only viewer or non-loopback caller) — oneliner only */
export function useLaunchSurface(): {
  creds: CredsInfo | null | undefined; refresh: () => void;
} {
  const [creds, setCreds] = useState<CredsInfo | null | undefined>(undefined);
  const refresh = () => {
    /* a successful fetch (even with runner:false) means this server has the
       launch surface at all; a 403/404 hides the run tab entirely */
    api<CredsInfo>("/api/credentials")
      .then(setCreds)
      .catch(() => setCreds(null));
  };
  useEffect(refresh, []);
  return { creds, refresh };
}

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

/* the job's narration tail: pinned to the bottom while new lines land (the same
   follow-the-tail contract as the event stream's pane); scrolling up pauses the
   follow, and the arrow resumes it */
function JobLog({ lines }: { lines: string[] }) {
  const ref = useRef<HTMLPreElement>(null);
  const followRef = useRef(true);
  const [following, setFollowing] = useState(true);
  useEffect(() => {
    const el = ref.current;
    if (el && followRef.current) el.scrollTop = el.scrollHeight;
  }, [lines]);
  const onScroll = () => {
    const el = ref.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 8;
    followRef.current = atBottom;
    setFollowing(atBottom);
  };
  const jump = () => {
    const el = ref.current;
    if (!el) return;
    followRef.current = true;
    setFollowing(true);
    el.scrollTop = el.scrollHeight;
  };
  return (
    <div className="relative">
      <pre ref={ref} onScroll={onScroll}
        className="max-h-40 overflow-auto rounded bg-muted/40 p-1.5 text-[10px] leading-snug">
        {lines.join("\n")}
      </pre>
      {!following && (
        <button type="button" onClick={jump} title="follow the log again"
          className="absolute bottom-1.5 right-1.5 rounded-full border bg-background p-1 shadow-sm hover:bg-accent">
          <ArrowDown className="size-3" />
        </button>
      )}
    </div>
  );
}

/* one job's live card: state chip, run links, stop, log tail. Shared between the
   builder's run tab (queueLink on — a pointer to the Jobs page) and the Jobs
   page's expanded rows (queueLink off — you're already there). */
export function JobPanel({ job, onStop, queueLink }: {
  job: JobInfo; onStop: () => void; queueLink?: boolean;
}) {
  const live = !JOB_TERMINAL.has(job.state);
  const chip =
    job.state === "queued" ? "queued…"
    : job.state === "claimed" ? "starting locally…"
    : job.state === "building" ? "building locally (Nix)…"
    : job.state === "running" ? "running locally…"
    : job.state === "completed" ? "invocation finished — see individual run outcomes"
    : job.state;
  const tone =
    job.state === "completed" ? "text-emerald-600 dark:text-emerald-400"
    : job.state === "failed" || job.state === "error" ? "text-red-600 dark:text-red-400"
    : "text-muted-foreground";
  return (
    /* data-job: stable hook for e2e drivers and the docs GIF recorder */
    <div data-job className="space-y-1.5 rounded border p-2">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className={`${tone} ${live ? "animate-pulse" : ""}`}>{chip}</span>
        {job.runs.map((rid) => (
          <a key={rid} href={`#/runs/${rid}`} className="font-mono underline decoration-dotted">
            {rid}
          </a>
        ))}
        {queueLink && (
          <a href="#/jobs"
            className="ml-auto text-[10px] text-muted-foreground underline decoration-dotted hover:text-foreground">
            view in Jobs
          </a>
        )}
        {live && (
          <button type="button" className={`${BTN} ${queueLink ? "" : "ml-auto"}`} onClick={onStop}
            title="Stop execution; partial run files are kept">
            stop
          </button>
        )}
      </div>
      {job.error && <p className="text-[10px] text-red-600 dark:text-red-400">{job.error}</p>}
      {job.log.length > 0 && <JobLog lines={job.log.slice(-40)} />}
    </div>
  );
}

export function Launcher({ name, params, vals, missing, creds, refresh, onLive }: {
  name: string;
  params: Record<string, ParamDecl>;
  vals: Record<string, string>; /* the builder's seeded values — buildCmd's input */
  missing: string[];
  creds: CredsInfo;        /* non-null by contract — the builder gates on useLaunchSurface */
  refresh: () => void;
  onLive?: (live: boolean) => void; /* a job is in flight — the run tab's pulse dot */
}) {
  /* Readiness belongs to the server-owned local executor. */
  const executor = useExecutorPoll();
  const [choices, setChoices] = useState<Record<string, string | null>>({});
  const [job, setJob] = useState<JobInfo | null>(null);
  const [launchErr, setLaunchErr] = useState<string | null>(null);
  const jobId = useRef<string | null>(null);

  /* the 1s job poll, while one is live */
  useEffect(() => {
    if (!job || JOB_TERMINAL.has(job.state)) return;
    jobId.current = job.id;
    const t = setInterval(() => {
      api<JobInfo>(`/api/jobs/${job.id}`)
        .then((j) => { if (jobId.current === j.id) setJob(j); })
        .catch(() => { /* transient; next tick retries */ });
    }, 1000);
    return () => clearInterval(t);
  }, [job]);

  const jobActive = job !== null && !JOB_TERMINAL.has(job.state);
  useEffect(() => { onLive?.(jobActive); }, [jobActive, onLive]);

  const sets = setsUsed({ name, params }, vals, creds.mock_prefixes);
  const resolved: Record<string, string> = {};
  const unresolved: string[] = [];
  for (const set of sets) {
    const choice = choices[set] ?? initialProfile(creds, name, set);
    if (choice && choice !== NEW_PROFILE) resolved[set] = choice;
    else if (needsSetup(set, creds) || Object.keys(creds.store[set] ?? {}).length > 0)
      unresolved.push(set); /* needs a pick or a first profile; unknown-prefix sets may need nothing */
  }

  const gate =
    !executor?.ready
      ? executor?.error ?? "Local execution unavailable — start adb-local."
    : missing.length > 0 ? `set ${missing.join(", ")} first`
    : unresolved.length > 0 ? `credentials needed: ${unresolved.join(", ")}`
    : jobActive ? "a job is already running"
    : null;

  const launch = () => {
    setLaunchErr(null);
    const { sets: setArgs } = buildArgs(params, vals);
    /* Source comes from local ADB startup; palette options affect copied commands only. */
    apiPost<JobInfo>("/api/jobs", {
      experiment: name,
      sets: setArgs,
      profiles: resolved, // worker emits --credential SET=NAME; values stay in the credential store
    })
      .then(setJob)
      .catch((e: Error) => setLaunchErr(e.message));
  };

  return (
    <div className="space-y-2">
      <span className="text-xs text-muted-foreground/60">
        {executor?.source ? `Local source: ${executor.source}` : "Local execution unavailable"}
        {" "}— <a href="#/jobs" className="underline decoration-dotted hover:text-foreground">Jobs</a>
        {executor?.source && <span className="block">Restart adb-local after changing experiment declarations.</span>}
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
        {/* data-launch: stable hook for e2e drivers and the docs GIF recorder */}
        <button type="button" data-launch
          className="rounded border border-emerald-600/40 bg-emerald-600/10 px-3 py-1 text-xs text-emerald-700 hover:bg-emerald-600/20 disabled:opacity-40 dark:text-emerald-400"
          disabled={gate !== null} title={gate ?? "build and run on this machine"}
          onClick={launch}>
          ▶ run
        </button>
        {gate && <span className="text-[10px] text-muted-foreground">{gate}</span>}
      </div>
      {launchErr && <p className="text-[10px] text-red-600 dark:text-red-400">{launchErr}</p>}
      {job && <JobPanel job={job} queueLink
        onStop={() => void apiPost(`/api/jobs/${job.id}/stop`, {}).catch(() => {})} />}
    </div>
  );
}
