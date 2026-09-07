# Add or change an experiment

Experiments live under `experiments/` in this repository. Each directory has a `package.nix` that returns one or more named experiments. The package registry imports those directories automatically; you do not need to add an entry to the root flake.

To add an experiment, follow the small keyless example below and check the complete integration before introducing external dependencies. To extend one already in the repository, go to [change an existing experiment](#how-do-i-change-an-existing-experiment).

## How do I prepare the checkout?

Clone the repository and enter its development shell:

```sh
git clone https://github.com/antimemetics-institute/agentdatabank.git
cd agentdatabank
nix-shell
```

Flake users can enter the same shell with `nix develop`. Create `experiments/example-count/` for the new experiment. Use a unique experiment name; the registry rejects duplicates across directories.

## How do I declare the experiment?

Save this as `experiments/example-count/package.nix`:

```nix
{ adb, writeShellApplication, python3 }:
let
  program = writeShellApplication {
    name = "example-count-program";
    runtimeInputs = [ python3 ];
    text = ''
      python3 -c '
import json
import sys
params = json.load(sys.stdin)
print(json.dumps({"type": "metric", "name": "count", "value": params["count"]}), flush=True)
'
    '';
  };
in
{
  example-count = adb.mkExperiment {
    name = "example-count";
    summary = "Record an explicitly supplied count.";
    src = ./.;
    inherit program;
    params = with adb.types; {
      count = param int {
        description = "Integer to record in the run results.";
        initial = 3;
      };
    };
    results = { count = adb.types.int; };
  };
}
```

`params` supplies both validation and the local form. `initial` prefills the form and suggested command; users must still bind the parameter explicitly when running from the CLI. `results` selects emitted metric names for the run summary. See [manifest reference](../reference/manifest.md) for other types and presentation fields.

`src` declares the experiment's identity sources. Include code, configuration and dependency locks that determine this experiment's behavior. A path is usual; use a list when the experiment depends on several source trees. Changes anywhere in those declared inputs can change the condition identity, including a README inside a declared directory. Development artifacts such as `.venv` are filtered out. The [identity reference](../reference/layout.md#how-is-a-condition-id-calculated) gives the exact rule.

## What must the program do?

The runner starts the program in a fresh workspace, sends the complete parameter object as JSON on standard input, and provides the run directory and seed in environment variables. Emit one JSON object per line on standard output. The example emits a metric matching its declared result name.

For a larger program, put the implementation beside `package.nix` and have the adapter invoke its packaged executable. Pin dependencies in the package definition and dependency lock. Python experiments can use `adb.mkPythonEnv` to build a `pyproject.toml`/`uv.lock` workspace, and `adb-events` for validated event emission. `adb-experiment` provides a shared parameter-reading scaffold and artifact helper; see its [failure behavior](../reference/protocol.md#how-can-python-experiments-emit-validated-events) before adopting it.

Add [standard events](../reference/events.md) for the evidence a reader needs: messages, model calls, instance outcomes and metrics. Preserve useful native output as artifacts, write files under `ADB_RUN_DIR/artifacts/`, and emit artifact pointers. Read `ADB_SEED` and pass it to supported random generators or backend settings. The [process protocol](../reference/protocol.md) defines the boundary in full.

## How do I check the integration?

For local flakes, stage the new files so Nix includes them:

```sh
git add experiments/example-count
```

From the repository root, inspect the schema and validate inputs:

```sh,repo-local
nix run .#example-count -- --describe
nix run .#example-count -- --set count=3 --dry-run
```

Then execute the keyless example:

```sh,repo-local
nix run .#example-count -- --set count=3
```

Open its viewer link and verify that the input and result are both `3` and the feed contains the metric. Launch the local UI from the checkout to check the generated form:

```sh,repo-local
nix run .#adb-local
```

For a real experiment, test parameter rejection, event shapes, summary selection and failure reporting with mocks or small local fixtures. Run the affected package's tests; after changing dependency declarations, update its lock and check dependent locks. `task lock:check` checks lock freshness, and `task ci` runs the repository's broader checks. Build documentation separately with `task docs:build` when changing it.

## How do I change an existing experiment?

Find its declaration in `experiments/` and the adapter that consumes its inputs. Read the experiment's README and tests before editing.

For example, suppose an adapter currently calls its model with a hardcoded `temperature=0.5`. To let readers choose that value while retaining the previous behavior:

1. Capture the existing behavior with a small fixture that records the model request and emitted results. Keep its inputs and source revision so you can compare after editing.
2. Add a parameter to that experiment's `params` declaration:

   ```nix
   temperature = param float {
     description = "Sampling temperature passed to the model.";
     initial = 0.5;
   };
   ```

3. Add the field to the adapter's parameter schema, including any backend constraints, and replace the hardcoded argument with the supplied value. For a Python adapter with a validated `params` object, the call becomes `temperature=params.temperature`.
4. Update the README commands and fixtures to supply `--set temperature=0.5` alongside every existing parameter. `initial` prefills the form and suggested command; it does not make this new CLI argument optional. Existing commands must be updated.
5. Run the before/after fixture with `0.5` and check that the model request and relevant results match. Then use a different value, such as `0.2`, and assert that it reaches the backend. A mock that ignores temperature can check wiring but cannot establish how a real model responds. Check invalid inputs and inspect a small run's parameters, events and summary.

Preserving behavior does not preserve fingerprints: changes to declared source content or the parameter set can change the condition ID. Also, a changed condition ID changes derived run seeds even with the same CLI base seed. Use a fixture with a controlled adapter seed when testing behavior across these edits; see [seeds](../running/model.md#how-do-seeds-work).

If the change makes the experiment incompatible with its earlier meaning or behavior, give it a separate experiment identity and document the distinction. There is no agreed folder-suffix convention or general experiment-versioning system.

## What belongs in the pull request?

Add a README in the experiment directory explaining the research question, upstream source, required services, input meanings, result interpretation and a small runnable example. Keep experiment-specific usage there rather than adding a catalog page to this book.

Describe what the new experiment or change does, the evidence it records, and the checks you ran. Include updated locks and fixtures needed to reproduce those checks. Submit the code and documentation through an ordinary repository pull request.
