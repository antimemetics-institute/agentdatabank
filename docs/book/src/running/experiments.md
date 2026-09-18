# Choose inputs and run

Choose inputs in the local interface, or [run directly from a terminal](#how-do-i-use-the-command-line). Neither path requires a repository checkout. Use [getting started](getting-started.md) for a first browser run; [command settings](nix.md) selects downloaded source or your checkout.

## How do I choose inputs in the local interface?

1. Start the local application and open an experiment.

   ```sh
   nix run .#adb-local
   ```

2. Choose the experiment or task, the model, and the amount of work (such as a dataset limit or number of rounds). Use the experiment summary and linked material to understand those choices. The form includes type information and descriptions. Suggestions help you enter values; a suggested model is not a guarantee that the experiment or your account supports it.
3. Enter the model ID, usually `provider/model`. You can type a value that is absent from the suggestions. For a list of structured entries, edit the rows or use **raw** to enter the complete JSON array. Object inputs accept JSON or the field controls provided by that experiment.
4. Open the **run** tab, configure the required credential sets and select profiles. [Configure model credentials](secrets.md) explains how those selections work.
5. Set the number of replicates and press **run**. Follow the job's run links to inspect its events.

The form keeps edits in this browser across navigation. Review the values when returning to an experiment; they may be your earlier edits rather than its initial suggestions.

**Jobs** shows queued and active work. Open a job for its details. **Stop** cancels queued work or stops active execution; partial run files are retained. See [local server reference](../reference/local.md) for lifecycle and configuration details.

## How do I use the command line?

The **oneliner** tab generates a command with every experiment parameter bound. Copy it into a terminal to run the same inputs. It invokes the generated experiment launcher, which supplies the runner’s execution context; do not substitute a direct `adb-runner` command or the underlying program. The command's Nix form and source follow the [command settings](nix.md); check those settings before executing. A command using moving `main` runs that source's current experiment, even if you copied it while examining older data. To repeat a historical configuration, [select its recorded source revision](model.md#how-do-i-keep-the-source-version) and inputs.

For a model that needs credentials, [configure a saved profile](secrets.md) and select it with `--profile SET=PROFILE` when needed. An interactive terminal can prompt for missing built-in credentials; noninteractive runs require setup beforehand.

Without the interface, ask the experiment for its manifest:

```sh
nix run .#inspect-hello -- --describe
```

Supply each declared parameter with `--set`. This keyless example uses the bundled mock model:

```sh
nix run .#inspect-hello -- \
  --set model=mockllm/model \
  --set limit=0 \
  --set epochs=1 \
  --set 'generate_args={}'
```

Every parameter is required on the command line, including those with an `initial` value in the manifest. If a parameter is missing, the runner prints an example command. Review its values before running it.

Values can be JSON, a bare string or `@path` to read a file. Quote a whole `KEY=VALUE` argument when it contains spaces or shell punctuation. For example, replace the last argument above with `--set generate_args=@generation.json` after saving a JSON object in that file. An explicit `null` is allowed only for a parameter declared nullable. See [value syntax](../reference/cli.md#how-are-parameter-values-read).

## How do I check before executing?

Add `--dry-run` to a complete command. It checks parameter names and types and prints the condition and inputs without starting the experiment or resolving credentials. List-length bounds are checked only when executing. It does not test account access, model availability or an experiment's external dependencies.

Remove `--dry-run` when ready. The runner prints a run ID, data path and viewer link. It executes replicates sequentially.

## How do I inspect the result?

For browser inspection, start the viewer:

```sh
nix run .#adb-web
```

Open the run under **Runs** using its printed run ID. If a viewer was already serving the same data directory, the runner's **watch** link opens the run directly. A printed link alone does not start a viewer. If you used `--data-dir DIR`, pass the same option when starting the viewer. See [find and read a run](../browsing/runs.md) for inspecting results and evidence.

For terminal processing, add `--json` to the experiment command to stream event envelopes as JSON lines on the launcher’s stdout; its diagnostics go to stderr. This is distinct from the child experiment program’s stdout, which is captured as text events. Saved run files are still written. For unattended execution, also pass `--non-interactive` to disable prompts; required credentials and profile selections must be resolvable without input. Each envelope identifies its run, so replicates can be processed separately.

Check `event.state` in each `run.end` envelope, or `state` in the saved `run.json`. The runner returns `0` when all runs complete, `1` if any run fails or times out, and `130` on interruption; an interruption stops the remaining replicates. A completed process can also report errors in individual evaluation items, so inspect the summary and relevant events. Missing `run.end` may mean execution is still active or stopped before recording its outcome. [Read the saved files directly](../browsing/runs.md#how-do-i-read-the-files-without-a-browser) to inspect the record without starting a viewer.

To interrupt a terminal run, press Ctrl-C. Inspect the retained record to see how far it progressed. To run the same configuration again, use the original command or the local job's rerun action; [repeat and compare runs](model.md) explains seeds and source versions.
