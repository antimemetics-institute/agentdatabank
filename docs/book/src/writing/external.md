# Writing an experiment

Experiments are packaged in **family directories**: one folder, one `package.nix`, declaring one *or more* experiments backed by the same code (ADB's `impossiblebench/` directory declares two; `inspect_evals/` declares one per task; usually it's just one). ADB's registry is all family directories flattened into one flat namespace of experiment names — the directory is the code and review boundary, the experiment names are the runnable ones.

The directories in this repo's `experiments/` are the reference examples — yours has exactly the same shape, it just lives in your own repo. The directory is the whole artifact, which is what makes [contributing it later](contributing.md) a verbatim copy.

<div class="adb-when-flakes">

```
my-exp/
├── flake.nix        scaffolding: hands the directory to ADB — never part of identity
├── package.nix      declares the experiment: params, results, program
├── pyproject.toml   depends on adb-experiment (a git source on the ADB repo)
├── uv.lock
└── my_exp/
    └── main.py
```

</div>

<div class="adb-when-flakeless">

```
my-exp/
├── package.nix      declares the experiment: params, results, program
├── pyproject.toml   depends on adb-experiment (a git source on the ADB repo)
├── uv.lock
└── my_exp/
    └── main.py
```

</div>

## The declaration

`package.nix` is a function over `adb` (the build support) returning one attr per experiment:

```nix
{ adb, lib }:
let
  env = adb.mkPythonEnv { name = "my-exp-env"; workspaceRoot = ./.; };
in
{
  my-exp = adb.mkExperiment {
    name = "my-exp";
    summary = "One line, shown in the GUI and the catalog.";
    src = [ ./package.nix ./pyproject.toml ./uv.lock ./my_exp ];
    params = with adb.types; {
      model = param llm { initial = "mock/model"; order = 1000; };
      steps = param int { initial = 10; order = 1; };
    };
    results = with adb.types; { status = str; };
    program = lib.getExe' env "my-exp";
  };
}
```

`src` is **condition identity**: the content hash of exactly those paths versions your conditions. List what defines behavior (declaration, lock, code) and nothing else — tests, CI files, READMEs, and scaffolding like a `flake.nix` don't belong, so editing them doesn't re-version your experiment.

## The program

The program speaks the runner protocol: params arrive as a JSON config file named on argv, events leave as JSON lines on stdout, `ADB_SEED` and `ADB_RUN_DIR` ride in the env. In Python, `adb-experiment` (with `adb-events`; add `[llm]` for the instrumented model client, or `adb-inspect` to wrap an Inspect task) is that protocol packaged. The libraries aren't on PyPI — your `pyproject.toml` takes them straight from the ADB repo, pinned to a release tag (bumping the tag is a deliberate line-edit; at build time they're overridden to the ADB you build against, regardless):

```toml
[tool.uv.sources]
adb-events = { git = "https://github.com/{{repo}}", subdirectory = "lib/adb-events", tag = "libs-v0" }
adb-experiment = { git = "https://github.com/{{repo}}", subdirectory = "lib/adb-experiment", tag = "libs-v0" }
```

```python
from adb_events.emit import metric
from adb_experiment.scaffold import experiment_main
from pydantic import BaseModel

class Params(BaseModel):
    model: str
    steps: int

def run(params: Params) -> None:
    metric("status", "completed")

def main() -> int:
    return experiment_main(Params, run, prog="my-exp")
```

## Building and running

<div class="adb-when-flakes">

One scaffolding file, `flake.nix`, hands your directory to ADB. `origin` is your repo's fetchable ref, stated once because a flake cannot know its own URL:

```nix
{
  inputs.adb.url = "github:{{repo}}";
  outputs = { self, adb }: adb.lib.familyOutputs {
    inherit self;
    origin = "github:you/my-exp";
    family = ./.;
  };
}
```

That gives your repo the same commands ADB itself has:

</div>

<div class="adb-when-flakeless">

Your repo needs no Nix files of its own — ADB's classic entrypoint takes your directory as an argument (`--arg family`), straight from the tarball:

</div>

```bash,repo-local
nix run .#my-exp -- --set model=mock/model --set steps=10
nix run .#adb-web
```

`adb-web` here serves the union: the built-in catalog plus your family, so your run-config form is right there. Runs land in the shared databank home either way, so the run browser is always complete.

<div class="adb-when-flakes">

Because `origin` is declared, runs from pushed commits record a real fetchable ref (`github:you/my-exp/<rev>`) — re-runnable before your experiment is ever contributed. Uncommitted changes record `dirty:`, as everywhere.

</div>

<div class="adb-when-flakeless">

Runs record a `dirty:` fetch ref — a classic build carries no fetchable rev to record.

</div>

Condition identity hashes content only, so the runs you record now [stay comparable after the merge](contributing.md).
