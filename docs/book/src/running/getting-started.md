# Run your first local experiment

Use `adb-local` to open Agent Databank (ADB), run a one-round GovSim fishing simulation, and read the resulting conversation and metrics. You need [Nix installed](https://nixos.org/download/), a browser, and an internet connection for the initial downloads and builds. For a live model, you also need access to that model and any credentials its provider requires. GovSim’s paper embedder downloads about 1.3 GB on first use.

## Start ADB

The command below follows your [Nix command settings](#adb-cmd-settings). The default downloads ADB without a checkout or requiring flakes; choose **local checkout** if you want to use code on your machine.

```bash
nix run .#adb-local
```

Leave the terminal running. The first build can take time; once ready, ADB opens your browser. If it does not, open the URL printed in the terminal, normally `http://127.0.0.1:8340`. You should see the experiment catalog.

<img class="only-light" src="../images/overview-light.png" alt="ADB's experiment catalog, with a search field above the experiment cards">
<img class="only-dark" src="../images/overview-dark.png" alt="ADB's experiment catalog, with a search field above the experiment cards">

## Choose an experiment

Search for `govsim`, open **govsim**, and expand **configure a run**. Choose **fish_baseline_concurrent** and set **max_rounds** to `1`.

<video class="only-light" autoplay loop muted playsinline src="../images/choose-light.webm" aria-label="Find and open the GovSim experiment"></video>
<video class="only-dark" autoplay loop muted playsinline src="../images/choose-dark.webm" aria-label="Find and open the GovSim experiment"></video>

## Pick a model and save credentials

Choose a **model** you have access to, using the provider prefix shown in the suggestions. If your provider supports a model that is absent from the suggestions, you can type its model ID. Set **embedder** to `mxbai` and leave **max_tokens** at `8000`. The recorded run uses `openai/gpt-6-astra`, **reasoning_effort** `low`, and empty (null) **temperature** and **top_p** fields. For another model, use generation settings that its provider supports.

Select the **run** tab and enter the credentials ADB asks for. The fields and defaults depend on the selected provider; these may include an API key and endpoint. Choose a profile name, such as **default**, and press **save**. The form changes to a profile selector. Press **remember** to reuse that profile for this experiment. If you already have a saved profile, select it instead. See [credentials](secrets.md) for storage and provider details.

For a credential-free local test, use `mock/model` with the `hash` embedder. This produces synthetic behavior without calling a provider or downloading embedding weights.

<video class="only-light" autoplay loop muted playsinline src="../images/model-credentials-light.webm" aria-label="Select a model and save its credential profile"></video>
<video class="only-dark" autoplay loop muted playsinline src="../images/model-credentials-dark.webm" aria-label="Select a model and save its credential profile"></video>

The animations show an illustrative, accelerated replay of a historical GovSim run, with its original model calls and messages. The saved key is an example; use your own credentials for a live run.

## Launch the experiment

Leave **replicates** at `1` and press **▶ run**. A replicate is one execution of the experiment; this one simulates one fishing round. The job panel shows build and execution progress, then a link to the run. The first experiment build may take longer than the test itself.

<video class="only-light" autoplay loop muted playsinline src="../images/launch-light.webm" aria-label="Launch the configured experiment and follow its progress"></video>
<video class="only-dark" autoplay loop muted playsinline src="../images/launch-dark.webm" aria-label="Launch the configured experiment and follow its progress"></video>

If the **run** tab is missing, check that you started `adb-local` and opened its local URL. If the button is disabled, read the explanation beside it; the local executor may still be starting.

## Inspect the run

Follow the run link in the job panel. The **results** card at the top shows simulation metrics such as rounds, total harvest, and remaining resources. The recorded run completed one round with a total harvest of `50` and final resource of `50`; live-model behavior can vary. Model calls appear as the simulation runs, while GovSim’s conversation messages arrive at the end. Use **messages** to read the prompts and replies, **llm calls** to inspect model calls, and **all** to show all recorded events. Scroll upward to see earlier events.

<video class="only-light" autoplay loop muted playsinline src="../images/run-view-light.webm" aria-label="Inspect the conversation and results of a run"></video>
<video class="only-dark" autoplay loop muted playsinline src="../images/run-view-dark.webm" aria-label="Inspect the conversation and results of a run"></video>

You can find the run again under **Runs**. Press Ctrl-C in the launch terminal when finished; the saved run remains available next time you start ADB with the same data directory. Stopping ADB also stops its executor and any active execution.

When you want to edit an experiment, use an ADB checkout and start `adb-local` from it, or pass `--repo /path/to/agentdatabank`. Restart after changing experiment declarations. See the [local tools reference](../reference/local.md) for checkout commands, storage locations, the read-only viewer, and terminal execution.
