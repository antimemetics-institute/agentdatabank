# Adding and updating experiments

Add and update experiments directly in this repository using the workflow below. These instructions apply to humans and coding agents working in an ADB checkout, including a Git fork. Submit changes as a pull request; new experiments follow the same review process as changes to existing experiments. Including an experiment does not automatically include its runs in a published data release.

## Find the relevant code

The registry discovers `experiments/<directory>/package.nix` automatically. Each declaration is a function whose arguments are supplied by Nix `callPackage`, returning an attribute set of named experiments. Names must be unique across the registry; a directory may declare several experiments backed by shared code.

```text
experiments/my-experiment/
  package.nix          parameters, results, source paths, executable
  pyproject.toml       Python dependencies and console-script entry point
  uv.lock              resolved dependencies
  my_experiment/       implementation
  tests/               checks for the experimental procedure
```

Use `experiments/concordia/` as an example of an implementation maintained here, `experiments/impossiblebench/` for packaging a pinned upstream, and `experiments/inspect_evals/` for an adapter declaring a family of tasks. An upstream library can remain in its own repository; its ADB declaration and dependency pin live here.

## Declare and implement the experiment

For a Python implementation, `adb.mkPythonEnv { name = "my-experiment-env"; workspaceRoot = ./.; }` builds the environment from its project and lockfile. `adb.mkExperiment` connects the executable to the runner and declares:

- `name` and `summary`: the registry identity and a useful description.
- `params`: typed configuration, with descriptions and optional presentation hints such as `initial` and `suggestions`. Every parameter must bind explicitly when running; `initial` is not a runtime default.
- `results`: the measurements the experiment emits.
- `src`: the files that define the procedure, including code, the declaration, dependency files, and behavior-bearing local data. Keep tests and documentation out unless execution consumes them.
- `program`: the executable, commonly `lib.getExe' env "my-experiment"` for a console script declared in `pyproject.toml`.

The current source fingerprint hashes the declared `src` content. Even a comment edit in an included file changes it. This identifies content; it does not establish whether results are scientifically comparable. Shared runner and adapter code is not automatically covered by the experiment's `src` list.

Parameters arrive as JSON on stdin; events leave as JSON lines on stdout. Send ordinary diagnostics to stderr. The runner supplies `ADB_SEED` and `ADB_RUN_DIR` and owns the run lifecycle. Use `adb_events.emit` for typed event emission and `adb_experiment.scaffold.deposit_artifact` for artifacts. For Python parameter validation and protocol handling, see `experiment_main` in `lib/adb-experiment/adb_experiment/scaffold.py`; inspect both recorded outcomes and measurements when testing, since its fallback error summary can accompany a zero process exit status.

For model calls, the instrumented `ChatClient` in `adb_experiment.llm` provides event capture and a keyless `mock/model` backend. The Inspect adapter uses `mockllm/model`. Keep credentials out of parameters and source files; use the runner's [credential profiles](../running/secrets.md). Pass the supplied seed into the libraries that support it.

## Update dependencies

Use the repository development shell (`nix develop` or `nix-shell`). Shared ADB Python packages use local paths in `[tool.uv.sources]`, for example:

```toml
[tool.uv.sources]
adb-events = { path = "../../lib/adb-events" }
adb-experiment = { path = "../../lib/adb-experiment" }
```

From the experiment directory, use `uv add <dependency>` or edit `pyproject.toml` and run `uv lock`. Review and commit the resulting lockfile. Bound upstream versions deliberately. Keep the declaration and Python parameter model aligned when changing configuration or measurements.

## Validate from the checkout

Start with the existing keyless experiment to check the toolchain. These commands run from the ADB repository root:

```bash,repo-local
nix run .#inspect-hello -- --describe
```

```bash,repo-local
nix run .#inspect-hello -- \
  --set model=mockllm/model --set limit=0 --set epochs=1 \
  --set 'generate_args={}' --dry-run
```

For an actual disposable smoke run, choose a temporary data home outside the repository:

```bash
export ADB_DATA_DIR="$(mktemp -d)"
```

```bash,repo-local
nix run .#inspect-hello -- \
  --set model=mockllm/model --set limit=0 --set epochs=1 \
  --set 'generate_args={}'
```

Repeat describe, dry-run, and a small keyless run for the experiment you changed, using its own complete parameter set. Inspect the run record, events, and expected measurements; a successful command alone is insufficient. These development runs are not publication data.

For new files, add the intended experiment files to Git's index before evaluating through flakes: local Git flakes only include tracked files. Alternatively, classic Nix can evaluate the working tree directly.

Run focused procedure tests, `nix-build --no-out-link -A manifests`, and `scripts/check-entrypoint-identity.sh --exp <name> -- --set ...` with the experiment's full configuration. The identity check verifies that the supported Nix entrypoints agree. `task ci` runs the repository's broader checks. Review the source and lockfile diff alongside the recorded smoke-run outputs before collecting data intended for publication.
