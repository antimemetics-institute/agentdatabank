# GovSim ("Cooperate or Collapse", Piatti et al., NeurIPS 2024) as an ADB
# experiment: 5 LLM personas share a common-pool resource — harvest, negotiate,
# collapse or sustain.
#
# Upstream stays verbatim and pinned: the checkout below rides PYTHONPATH (GovSim
# ships no pyproject, so it cannot be a uv dependency); its pathfinder DSL is a
# proper uv git dependency (pinned in pyproject.toml). All adaptation lives in
# ./govsim_adapter: config composition (hydra compose over the upstream conf tree), model
# injection (a ChatClient-backed pathfinder ModelAPI), embedder substitution
# (deterministic hash embedder on the keyless path), wandb neutralization, and
# metric extraction from the persisted log_env.json.
{ adb, lib, writeShellApplication }:
let
  # the pin participates in condition identity via this file's text (package.nix
  # is in src); fetchGit skips the pathfinder submodule — harmless, the empty dir
  # cannot shadow the installed package (regular package beats namespace dir)
  govsimSrc = builtins.fetchGit {
    url = "https://github.com/giorgiopiatti/GovSim";
    ref = "main";
    rev = "1d11adf047b24fa2ba0d44a1d4931015ea2e5210";
  };

  env = adb.mkPythonEnv {
    name = "govsim-env";
    workspaceRoot = ./.;
    # legacy setup.py packages (no pyproject / undeclared backend) need
    # setuptools injected as their build system (impossiblebench precedent):
    # pathfinder is our git dep; antlr4-python3-runtime is hydra's sdist-only dep
    overrides = final: prev:
      lib.genAttrs [ "pathfinder" "antlr4-python3-runtime" ] (name:
        prev.${name}.overrideAttrs (old: {
          nativeBuildInputs = (old.nativeBuildInputs or [ ])
            ++ final.resolveBuildSystem { setuptools = [ ]; };
        }));
  };

  program = writeShellApplication {
    name = "govsim-adapter";
    text = ''
      export GOVSIM_UPSTREAM=${govsimSrc}
      export PYTHONPATH=${govsimSrc}''${PYTHONPATH:+:$PYTHONPATH}
      exec ${lib.getExe' env "govsim"} "$@"
    '';
  };

  mockSuggestion = {
    value = "mock/model";
    description = "Keyless offline mock — scenario-aware deterministic replies, no network (the smoke/CI path).";
  };
in
{
  govsim = adb.mkExperiment {
    name = "govsim";
    summary = "GovSim (NeurIPS 2024): 5 LLM personas share a common-pool resource — harvest, negotiate, collapse or sustain.";
    # identity = declaration + locks + code; README/docs/default.nix stay out
    src = [ ./package.nix ./pyproject.toml ./uv.lock ./govsim_adapter ];
    links = [
      { label = "paper"; url = "https://arxiv.org/abs/2404.16698"; }
      { label = "source"; url = "https://github.com/giorgiopiatti/GovSim"; }
    ];
    params = with adb.types; {
      experiment = param (enum [
        "fish_baseline_concurrent"
        "fish_baseline_concurrent_paraphrase_1"
        "fish_baseline_concurrent_paraphrase_2"
        "fish_baseline_concurrent_universalization"
        "fish_perturbation_no_language"
        "fish_perturbation_outsider"
        "fish_perturbation_outsider_universalization"
        "sheep_baseline_concurrent"
        "sheep_baseline_concurrent_universalization"
        "sheep_perturbation_no_language"
        "sheep_perturbation_outsider"
        "sheep_perturbation_outsider_universalization"
        "pollution_baseline_concurrent"
        "pollution_baseline_concurrent_universalization"
        "pollution_perturbation_no_language"
        "pollution_perturbation_outsider"
        "pollution_perturbation_outsider_universalization"
      ]) {
        description = "Scenario and treatment to run.";
        initial = "fish_baseline_concurrent";
        order = 1;
        group = "scenario";
      };
      max_rounds = param int {
        description = "Round (month) cap; 0 = the upstream per-experiment value (12 baseline, 15 outsider).";
        initial = 0;
        order = 2;
        group = "scenario";
      };
      model = param llm {
        description = "Model used by every agent. Use mock/model for an offline test.";
        initial = "mock/model";
        suggestions = [ mockSuggestion ];
        order = 1000;
        group = "model";
      };
      embedder = param (enum [ "hash" "mxbai" ]) {
        description = "Memory embeddings: hash gives artificial similarities for offline testing; mxbai uses the paper’s embedding model and may download about 1.3 GB. Its upstream weights are not revision-pinned.";
        initial = "hash";
        order = 1010;
        group = "model";
      };
      temperature = param float {
        nullable = true;
        description = "Sampling temperature; null omits it from requests (upstream default 0.0).";
        initial = 0.0;
        order = 1020;
        group = "generation";
      };
      top_p = param float {
        nullable = true;
        description = "Nucleus sampling top_p; null omits it from requests (upstream default 1.0).";
        initial = 1.0;
        order = 1021;
        group = "generation";
      };
      reasoning_effort = param (enum [ "low" "medium" "high" "xhigh" "max" ]) {
        description = "Reasoning effort for compatible models; null leaves the provider default. For Astra use low and set temperature/top_p to null.";
        nullable = true;
        initial = null;
        order = 1023;
        group = "generation";
      };
      max_tokens = param int {
        description = "Per-call completion budget (upstream Gen default 8000); enforced as a cap on every request.";
        initial = 8000;
        order = 1022;
        group = "generation";
      };
    };
    results = with adb.types; {
      rounds = int;            # months actually simulated
      collapsed = bool;        # pool dropped below 5 before the round cap
      survival_months = int;   # paper metric (plots.py formula): collapse round + 1, else the cap
      total_harvest = int;     # sum of resource_collected over agents and rounds
      gain_per_agent = float;  # mean per-agent total — the paper's "total gain" (get_payoffs)
      final_resource = int;    # pool after the last logged round's harvest
      equality = float;        # 1 - gini(per-agent total harvest), gini per plots.py
      over_usage = float;      # REIMPLEMENTATION (no upstream code): share of harvest
                               # actions with wanted > (pool_before // 2) // num_agents
      model_calls = int;       # completions actually requested (ChatClient.n_calls)
    };
    env.network = true; # hosted models and optional HuggingFace embedder downloads
    program = program;
  };
}
