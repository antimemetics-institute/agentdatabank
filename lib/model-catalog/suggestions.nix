# The `types.llm` combobox hints, generated — never edit a model id here by hand.
# Concrete ids come from model_catalog.json (regenerate with `task models:update`)
# — PROVIDER knowledge, wrapper-agnostic. The value strings here follow inspect's
# provider-prefix convention (google/, grok/, openai-api/, ...) because inspect is
# the only wrapper today; another wrapper (litellm, ...) would build its own
# formatting over the same catalog rather than reuse this file. The static tail
# covers pattern-style providers with no enumerable model list. Shared infra: a
# catalog refresh changes manifests but never condition identity.
{ lib }:

let
  catalog = builtins.fromJSON (builtins.readFile ./model_catalog.json);
  order = [ "anthropic" "openai" "google" "groq" "mistral" "grok" "moonshotai" "bedrock" "openrouter" ];
  fromCatalog = lib.concatMap
    (prefix:
      let p = catalog.providers.${prefix}; in
      map
        (m: {
          value = "${prefix}/${m.id}";
          description = "${m.name}"
            + lib.optionalString (m.release_date != "") " (released ${m.release_date})"
            + ". ${p.credential_hint}";
        })
        p.models)
    order;
  patterns = [
    { value = "openai/qwen3.5-9b"; description = "A model served from your own OpenAI-compatible server (set its base URL on the openai credential set)."; }
    { value = "openrouter/"; description = "openrouter/<org>/<model>: any OpenRouter-hosted model, including ones added since this catalog was generated. Needs OPENROUTER_API_KEY (asked for on first run)."; }
    { value = "azureai/"; description = "Type your Azure deployment name after the slash; endpoint + key asked for on first run."; }
    { value = "openai-api/"; description = "openai-api/<name>/<model>: an OpenAI-compatible server under a named credential set."; }
  ];
in
fromCatalog ++ patterns
