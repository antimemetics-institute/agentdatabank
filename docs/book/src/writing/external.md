# Writing an experiment

An experiment is a directory: one `package.nix` declaring it — params, results, and the program that runs it. One directory can declare several experiments backed by the same code (ADB's `impossiblebench/` declares two; `inspect_evals/` one per task), but usually it's one. ADB's registry is all these declarations flattened into one flat namespace of experiment names — and your directory lives in **your own repo**, permanently: you develop and run it there, and [contributing](contributing.md) later means packaging it into the registry, not moving it. [`adb-werewolf-example`](https://github.com/antimemetics-institute/adb-werewolf-example) is such a repo — this page's scaffold with `run()` swapped for a small social-deduction game.

## Scaffold one

```bash
nix run .#adb-dev -- \
  init my-exp
```

That writes a working experiment, pinned to the ADB it came from:

```
my-exp/
├── default.nix      the adb pin — `adb-dev bump` moves it; never part of identity
├── package.nix      the declaration: params, results, and the program
├── pyproject.toml   a normal Python project; adb libraries at the same rev as the pin
├── uv.lock
├── README.md        the repo's own story — starts generated, grows with your design
└── my_exp/
    └── main.py      a working example: a few chat turns via the instrumented client
```

<div class="adb-when-flakeless">

`default.nix` is the entire Nix story — a `fetchGit` pin on ADB (URL, branch, exact commit) and one line handing your directory over. Plain `nix-build` is all you ever need.

</div>

<div class="adb-when-flakes">

The scaffold is plain Nix, and that's the one shape — there is no flake scaffold. With flakes enabled everything on this page still works as written: commands in your repo take the `nix run -f .` form, which drives the same packages without a `flake.nix`. If you want `.#` ergonomics anyway, wrap `default.nix` in a small flake of your own — the attrset it returns is the whole package set.

</div>

## Or fork one

Any experiment already in the registry can be the starting point instead of the scaffold:

```bash
nix run .#adb-dev -- \
  fork concordia my-concordia
```

Forking is [contributing](contributing.md) run backwards: where contributing wraps your repo into the registry, `fork` lifts an experiment's directory out of the pinned ADB and points the adb libraries back at git. What lands is the scaffold's exact shape — pin block, `bump`, the web catalog, everything on this page applies as written — with a real experiment where the example would be.

The fork needs its own name because the registry refuses duplicates — and that's the point: the original stays runnable next to yours, baseline beside variant. `fork` renames the declared experiments for you and reports each rename (a directory declaring several gets your name as the prefix: `impossiblebench-swebench` → `my-fork-swebench`). The unit is the directory — you fork the thing with a `package.nix`, and trimming what it declares afterward is normal editing.

A fork mints new condition IDs before you change any behavior: the rename and the source rewrite are content, and the dependency provenance genuinely changed. That is identity doing its job, not a penalty — the generated README records the lineage (source experiment, adb rev), and relating the fork's runs to the original's is read-time comparability.

## Run it

Every param binds explicitly — the run *is* its command line (run it bare and it prints the completed command to copy). `mock/model` is keyless and offline:

```bash,repo-local
nix run .#my-exp -- \
  --set 'prompt=In one sentence: something surprising about agent experiments.' \
  --set turns=3 \
  --set model=mock/model \
  --set temperature=0.7
```

And the web GUI, with your experiment in its catalog next to the built-in ones — runs land in the shared databank home either way:

```bash,repo-local
nix run .#adb-web
```

## Make it yours

`my_exp/main.py` is the whole program: a pydantic `Params`, a `run()` that does the work, and `experiment_main` wiring it to the runner protocol. The scaffold's example drives `ChatClient` — an OpenAI-shaped client where the model id's provider prefix picks the endpoint and credentials, every call emits an `llm.call` event, and `mock/` runs without keys. Replace `run()` with your design; mirror any params/results change in `package.nix`.

Two things worth knowing as you edit:

- **The protocol is the contract, Python is just packaged.** Params arrive as JSON, events leave as JSON lines — any language can speak it; `program` in `package.nix` is any executable that does.
- **`src` is condition identity**: the content hash of exactly those paths versions your conditions. List what defines behavior (declaration, lock, code) — tests, CI files, and the scaffolding stay out, so editing them re-versions nothing.

New Python dependencies are ordinary uv: `uv add whatever` (grab uv from `nix-shell -p uv` if you don't have it), and the next build picks up the lock.

## The pin

Your repo pins ADB in exactly one version, stated twice: the commit in `default.nix`'s pin block, and the same commit on the adb libraries in `pyproject.toml` — so your editor and your builds see the same code. `adb-dev bump` moves both together and relocks:

```bash,repo-local
nix run .#adb-dev -- \
  bump --latest
```

(`bump --rev <sha>` targets a specific commit; `adb-dev pin` prints the current one.)

While you develop, runs record a `dirty:` fetch ref — honest, since your working directory isn't fetchable by anyone. Condition identity hashes content, not addresses, so the runs you record now collate with runs of the same content forever — including [after your experiment joins the registry](contributing.md).
