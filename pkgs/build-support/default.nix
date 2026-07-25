# The adb build-support lib: type constructors and mkExperiment.
# Types are authored here as nix values and rendered to plain JSON descriptors at eval
# time (ADB_MANIFEST); the runner and GUI consume JSON and never evaluate nix.
#
# `self` is the flake self (for source identity); `origin` is the fetchable flake ref
# without a rev — a flake cannot know its own URL, so it is stated once at the call
# site. `adb-runner` arrives by argument, so overriding the runner reaches every
# experiment.
{ pkgs, self, origin, adb-runner }:

let
  inherit (pkgs) lib;

  # The fetchable reproducibility ref: the pinned rev spliced into the origin ref (in
  # front of any ?dir=... query). This is NOT condition identity (see mkExperiment's
  # per-experiment content `source` below) — it is recorded per run so a run can be
  # re-run from a pinned source.
  refParts = lib.splitString "?" origin;
  fetchRef =
    if self ? rev then
      builtins.head refParts + "/${self.rev}"
      + lib.optionalString (builtins.length refParts > 1)
        "?${lib.concatStringsSep "?" (builtins.tail refParts)}"
    else "dirty:${self.narHash or "unknown"}";

  # types.llm governs its own hints: every llm-typed param gets the shared model
  # catalog (lib/model-catalog) appended to its suggestions at eval time, so no
  # experiment can desync from it. An experiment's own `suggestions` attr means
  # experiment-specific EXTRAS, prepended (e.g. hello's keyless mock) — never a
  # replacement. Presentation only: hints are not identity.
  llmSuggestions = import ../../lib/model-catalog/suggestions.nix { inherit lib; };
  # Applies to top-level params AND llm-typed fields inside listOf(struct) params
  # (e.g. a roster's per-agent model cell) — a struct field is a bare type or a
  # param-wrapped one; only fields that actually get hints are rewrapped.
  addHints = p: p // { suggestions = (p.suggestions or [ ]) ++ llmSuggestions; };
  withFieldHints = f:
    let p = if f ? kind then { type = f; } else f;
    in if (p.type.kind or null) == "llm" then addHints p else f;
  withLlmHints = params: lib.mapAttrs
    (_: p:
      if (p.type.kind or null) == "llm" then addHints p
      else if (p.type.kind or null) == "list" && (p.type.of.kind or null) == "struct"
      then p // {
        type = p.type // {
          of = p.type.of // { fields = lib.mapAttrs (_: withFieldHints) p.type.of.fields; };
        };
      }
      else p)
    params;
in
{
  types = rec {
    llm = { kind = "llm"; };
    str = { kind = "str"; };
    int = { kind = "int"; };
    float = { kind = "float"; };
    bool = { kind = "bool"; };
    enum = values: { kind = "enum"; inherit values; };
    listOf = of: { kind = "list"; inherit of; };
    # Only legal as listOf (struct { ... }) — the "table shape". Fields are scalar/registry
    # types only; the runner validates this when loading the manifest.
    struct = fields: { kind = "struct"; inherit fields; };
    # free-form JSON object — arbitrary keys/values, for a wrapped tool's passthrough
    # args (inspect's -T/generate config). The GUI renders it as a JSON editor; the
    # whole object is materialized into the condition hash as written.
    object = { kind = "object"; };

    # param wraps a type with defaults/instantiation-checks/presentation hints.
    param = type: attrs: { inherit type; } // attrs;
  };

  # mkPythonEnv: the uv2nix boilerplate as ONE helper. The toolchain is pinned here by
  # rev (flake eval is pure, so revs are mandatory); bump the three revs together.
  # When the project depends on `adb-events` or `adb-inspect`, its build is overridden
  # to the in-repo source, so those have ONE definition regardless of what the lock
  # pins.
  mkPythonEnv =
    { name
    , workspaceRoot
    , python ? pkgs.python313
    , sourcePreference ? "wheel"
      # extra pythonSet overlay for per-family fixes (e.g. a git dep that ships a
      # legacy setup.py and needs setuptools injected as a build system). Receives
      # (final: prev: …) with uv2nix's pythonSet, where `final.resolveBuildSystem`
      # is available.
    , overrides ? (_final: _prev: { })
    }:
    let
      pyproject-nix = import
        (builtins.fetchGit {
          url = "https://github.com/pyproject-nix/pyproject.nix.git";
          rev = "7af23cfe91064865ecf2e835da28b45b3c6f49fd";
        })
        { inherit lib; };
      uv2nix = import
        (builtins.fetchGit {
          url = "https://github.com/pyproject-nix/uv2nix.git";
          rev = "83995ef5e4ece3c9c704aa645bbff439e15a0ac3";
        })
        { inherit pyproject-nix lib; };
      pyproject-build-systems = import
        (builtins.fetchGit {
          url = "https://github.com/pyproject-nix/build-system-pkgs.git";
          rev = "430680a19bc85a3bda55f12e4cc1a1aadcf2e478";
        })
        { inherit pyproject-nix uv2nix lib; };
      workspace = uv2nix.lib.workspace.loadWorkspace { inherit workspaceRoot; };
      inRepoOverlay = _final: prev:
        lib.optionalAttrs (prev ? adb-events) {
          adb-events = prev.adb-events.overrideAttrs (_: { src = ../../lib/adb-events; });
        }
        // lib.optionalAttrs (prev ? adb-experiment) {
          adb-experiment = prev.adb-experiment.overrideAttrs (_: { src = ../../lib/adb-experiment; });
        }
        // lib.optionalAttrs (prev ? adb-inspect) {
          adb-inspect = prev.adb-inspect.overrideAttrs (_: { src = ../../lib/adb-inspect; });
        };
      pythonSet =
        (pkgs.callPackage pyproject-nix.build.packages { inherit python; }).overrideScope
          (lib.composeManyExtensions [
            pyproject-build-systems.overlays.default
            (workspace.mkPyprojectOverlay { inherit sourcePreference; })
            inRepoOverlay
            overrides
          ]);
    in
    pythonSet.mkVirtualEnv name workspace.deps.default;

  # mkExperiment: the schema + program → a runnable flake app with the manifest JSON and
  # source identity baked in. `program` is whatever speaks the runner protocol (params
  # JSON on stdin → event JSONL on stdout): a derivation (resolved via lib.getExe — the
  # usual case, a writeShellApplication adapter next to package.nix) or an explicit
  # executable path string.
  mkExperiment =
    { name
    , summary
    , params
    , results ? { }
    , env ? { }
    , program
    , src           # the experiment's OWN identity sources: a path (usually `./.`) or a
                    # list of paths. See identity note below. Identity is strictly
                    # content — it records, never judges comparability; declared
                    # upstream versions are covariates/advisory input, not identity
                    # (prototype specs/comparability.md).
    }:
    let
      programPath =
        if lib.isDerivation program then lib.getExe program else program;

      # Per-experiment content identity. The condition hash's `source` is a content
      # hash of THIS experiment's declared sources — each re-imported via builtins.path
      # so its hash depends ONLY on that subtree's content, never on the whole-repo
      # rev. So editing one experiment family cannot change another's condition_id.
      # The shared runner, wrapper lib, interpreter, and platform are NOT in identity;
      # they are recorded as run covariates. The fetchable rev (`fetchRef`) is recorded
      # separately for reproducibility — also not identity.
      srcs = if builtins.isList src then src else [ src ];
      # dev-loop artifacts are NOT identity: a `uv run` dropping a .venv into the
      # subtree must not mint new conditions for the experiment
      isDevArtifact = base:
        builtins.elem base [ ".venv" "__pycache__" "node_modules" "dist" ".direnv" ".pytest_cache" ]
        || base == "result" || lib.hasPrefix "result-" base;
      source = "content:sha256:" + builtins.hashString "sha256" (lib.concatStringsSep "\n"
        (lib.imap0 (i: p:
          "${builtins.path {
            path = p;
            name = "adb-src-${name}-${toString i}";
            filter = path: _type: !isDevArtifact (baseNameOf path);
          }}") srcs));

      manifest = pkgs.writeText "adb-manifest-${name}.json" (builtins.toJSON {
        schema_version = 0;
        params = withLlmHints params;
        inherit name summary results env;
      });
      app = pkgs.writeShellApplication {
        name = "adb-${name}";
        runtimeInputs = [ adb-runner ];
        text = ''
          export ADB_MANIFEST=${manifest}
          export ADB_EXPERIMENT_BIN=${lib.escapeShellArg programPath}
          export ADB_SOURCE=${lib.escapeShellArg source}
          export ADB_FETCH_REF=${lib.escapeShellArg fetchRef}
          exec adb-runner "$@"
        '';
      };
    in
    { inherit app manifest name; };
}
