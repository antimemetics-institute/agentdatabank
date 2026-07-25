# Credentials

Real models need API keys and endpoints. You don't configure them up front: the first run that needs a credential asks for it, and offers to save it. Keys stay off your command lines, out of your params, and out of the condition hash.

## The first run asks

A model id's prefix (`anthropic/…` → `anthropic`) names a **credential set**. The first interactive run that needs a set you don't have asks at the gate, before anything launches:

```text
adb: this run needs credential set 'anthropic' — setting it up now
ANTHROPIC_API_KEY [unset]: ****
ANTHROPIC_BASE_URL [default: https://api.anthropic.com]:
save 'anthropic' for future runs? [Y/n]:
adb: [258b80e5323e r1] … running
```

- Secret prompts are hidden — never echoed, and never on the command line. (There is deliberately no `KEY=VALUE` argv form: argv shows up in `ps` and shell history.)
- `Enter` accepts a shown `[default: …]`.
- `save? [Y/n]` — `Y` stores the set for every future run; `n` uses it for this run only and forgets it.
- Headless runs never hang on a prompt: with piped stdin or `--json`, a missing set refuses the run and prints the `credentials set` command to run instead.

## A name is a condition, a key is environment

```
model NAME  →  the condition   (a model param, e.g. openai/qwen3.5-9b)
endpoint    →  environment     (not a condition)
API key     →  environment     (not a condition)
```

Two researchers each running their own local `qwen3.5-9b` server should land in the same condition bucket — the science is "what does qwen3.5-9b do", not "what does it do at my URL with my key". So endpoints and keys are never experiment params, and changing them never changes a condition. See [Experiments, conditions, runs](model.md).

## Setting and managing them yourself

The same prompts, standalone — for setting up in advance or rotating a key:

```bash
nix run .#adb-runner -- \
  credentials set anthropic
```

```bash
nix run .#adb-runner -- \
  credentials list
```

Also `credentials remove <name>` and `credentials path`. `credentials set` re-prompts with your current values as defaults, so changing one field is Enter-past-the-rest; to script it, pipe one line per prompt on stdin — values still never touch argv. What the dialogue asks, per built-in name:

<div class="adb-tabs">
  <input type="radio" name="adb-provider-tab" id="ptab-anthropic" checked>
  <input type="radio" name="adb-provider-tab" id="ptab-openai">
  <input type="radio" name="adb-provider-tab" id="ptab-gemini">
  <input type="radio" name="adb-provider-tab" id="ptab-groq">
  <input type="radio" name="adb-provider-tab" id="ptab-openrouter">
  <input type="radio" name="adb-provider-tab" id="ptab-azureai">
  <input type="radio" name="adb-provider-tab" id="ptab-local">
  <div class="adb-tab-labels">
    <label for="ptab-anthropic">anthropic</label>
    <label for="ptab-openai">openai</label>
    <label for="ptab-gemini">gemini</label>
    <label for="ptab-groq">groq</label>
    <label for="ptab-openrouter">openrouter</label>
    <label for="ptab-azureai">azure</label>
    <label for="ptab-local">local server</label>
  </div>
  <div class="adb-tab-panels">
  <div>

> ```text
> ANTHROPIC_API_KEY [unset]: ****
> ANTHROPIC_BASE_URL [default: https://api.anthropic.com]:
> save 'anthropic' for future runs? [Y/n]:
> ```
>
> Model ids: `anthropic/…`, e.g. `anthropic/claude-sonnet-4-5-20250929`.

  </div>
  <div>

> ```text
> OPENAI_API_KEY [unset]: ****
> OPENAI_BASE_URL [default: https://api.openai.com/v1]:
> save 'openai' for future runs? [Y/n]:
> ```
>
> Model ids: `openai/…`, e.g. `openai/gpt-4o-2024-11-20`.

  </div>
  <div>

> ```text
> GEMINI_API_KEY [unset]: ****
> save 'gemini' for future runs? [Y/n]:
> ```
>
> Model ids: `gemini/…`, e.g. `gemini/gemini-2.5-pro`.

  </div>
  <div>

> ```text
> GROQ_API_KEY [unset]: ****
> save 'groq' for future runs? [Y/n]:
> ```
>
> Model ids: `groq/…`, e.g. `groq/llama-3.3-70b-versatile`.

  </div>
  <div>

> ```text
> OPENROUTER_API_KEY [unset]: ****
> OPENROUTER_BASE_URL [default: https://openrouter.ai/api/v1]:
> save 'openrouter' for future runs? [Y/n]:
> ```
>
> Model ids: `openrouter/…`, e.g. `openrouter/deepseek/deepseek-r1`.

  </div>
  <div>

> ```text
> AZUREAI_API_KEY [unset]: ****
> AZUREAI_BASE_URL [unset]: https://my-endpoint.eastus.models.ai.azure.com
> save 'azureai' for future runs? [Y/n]:
> ```
>
> The base URL is your Azure endpoint (no universal default). Model ids: `azureai/…` — the model part is your deployment name.

  </div>
  <div>

> A llama.cpp / ollama / vLLM server speaks the OpenAI API — at the base-URL prompt, type your server's full URL (scheme, port, and its `/v1` prefix). The key can be anything if your server ignores it:
>
> ```text
> OPENAI_API_KEY [unset]: ****
> OPENAI_BASE_URL [default: https://api.openai.com/v1]: http://localhost:11434/v1
> save 'openai' for future runs? [Y/n]:
> ```
>
> Model ids: `openai/<served-model-name>` — where the model is served is your environment, never part of the condition, so your runs bucket with everyone else's runs of that model.

  </div>
  </div>
</div>

<details>
<summary><b>Custom set names</b> — a vendor key and a self-hosted server at the same time</summary>

> The built-in names are just prompt templates — the ADB knows which field is secret and what a sensible default base URL is, nothing more. `credentials set` with *any* name creates a named set with the conventional fields (`<NAME>_API_KEY`, `<NAME>_BASE_URL`), and model ids of the form `openai-api/<name>/<model>` (inspect's OpenAI-compatible services) route to the set of that name. That's how a real OpenAI key and a self-hosted server coexist.
>
> One caveat: the service name is part of the model id, so it enters the condition. For poolable canonical conditions, prefer the plain `openai/<model>` form.

</details>

## The store

```
~/.config/adb/credentials.toml      # mode 0600, one section per credential set
```

The path honors `$XDG_CONFIG_HOME`; `$ADB_CREDENTIALS_FILE` overrides it entirely. That variable is also the CI story: your pipeline materializes this file from its own secret manager and points the variable at it. Base URLs are validated as you type them (an `http(s)://` scheme is required), so a typo is one retype instead of a cryptic client error mid-run.

## How credentials reach the experiment

A run's environment is constructed, not inherited — there is no passthrough of your shell into an experiment. A run receives exactly: a minimal set of system basics (`PATH`, `HOME`, locale), the credential sets this run routes to, and the `ADB_*` run vars. A stray key exported in your shell cannot leak into a run, because nothing ambient ever enters one.

Because the environment is constructed, it is also recorded: each run's record lists the env var names it received and which set each came from — secret values ablated, non-secret values (like base URLs) kept as covariates. What a run ran with is never a mystery; what the secrets were is never written down.

## The trust caveat

Running third-party code with your keys is a real trust decision: an experiment process receives the credentials routed to it and could misuse them. Today's mitigations: experiments in the monorepo are reviewed (nixpkgs-style), a run receives only the sets it routes to — never your whole keyring — and nothing ambient is exposed. VM-isolated execution with a recording proxy, where the raw key never enters the experiment process at all, is the planned next step (see `docs/plan/credentials.md` in the repo for the design).
