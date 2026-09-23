# The wiring: experiments/ is autoimported into a callPackage scope; ADB's own tools
# are defined here, all-packages.nix style. Entries are functions over their
# dependencies; the scope injects them by argument name and makes everything
# overridable.
#
# The registry convention:
#
#   experiments/<dir>/package.nix → an attrset of experiments, one attr per
#   experiment name. One directory usually declares one experiment, but may declare
#   several backed by the same code (impossiblebench, inspect_evals). Each value is
#   an adb.mkExperiment result ({ app, manifest, name }).
#
# experiments/ holds experiment code only; everything ADB-specific (this wiring,
# build-support, tool packaging) lives under pkgs/ and the tools' own source trees
# (runner/, web/).
{ pkgs, pyproject-nix, uv2nix, pyproject-build-systems, rev ? null, narHash ? null }:

let
  inherit (pkgs) lib;

  origin = "github:antimemetics-institute/agentdatabank";

  experimentsDir = ../../experiments;

  dirNames =
    if builtins.pathExists experimentsDir then
      lib.attrNames
        (lib.filterAttrs
          (name: _: builtins.pathExists (experimentsDir + "/${name}/package.nix"))
          (builtins.readDir experimentsDir))
    else [ ];

  scope = lib.makeScope pkgs.newScope (final:
    {
      pyproject-nix = import pyproject-nix { inherit lib; };
      uv2nix = import uv2nix { inherit lib; inherit (final) pyproject-nix; };
      pyproject-build-systems = import pyproject-build-systems {
        inherit lib;
        inherit (final) pyproject-nix uv2nix;
      };

      # build support — the `adb` attrset experiment declarations take as an argument.
      adb = final.callPackage ../build-support {
        inherit origin rev narHash;
      };

      # ADB's own tools; the adb- prefix keeps them out of the registry's bare namespace.
      # The runner packages itself from its own uv.lock (uv2nix) — see runner/default.nix,
      # including why its workspace import cannot go through adb.cleanImport.
      adb-runner = final.callPackage ../../runner { };

      # Local execution uses the same server, which owns its Python executor.
      adb-local = pkgs.writeShellApplication {
        name = "adb-local";
        runtimeInputs = [ pkgs.git pkgs.nix pkgs.nodejs ];
        text = ''
          source=${final.adb.cleanImport "adb-src" ../../.}
          # Only recognize an ADB checkout, not an arbitrary repository with default.nix.
          if top=$(git rev-parse --show-toplevel 2>/dev/null) \
             && [ -f "$top/runner/src/adb_runner/worker.py" ] \
             && [ -f "$top/pkgs/build-support/default.nix" ] \
             && [ -d "$top/experiments" ]; then
            source="$top"
          fi
          for arg in "$@"; do
            case "$arg" in
              --static-dir|--static-dir=*|--catalog|--catalog=*|--runner|--runner=*|--executor-python|--executor-python=*|--execution-source|--execution-source=*|--viewer-only|--viewer-only=*)
                echo "This option is managed by the ADB launcher: $arg" >&2
                exit 2
                ;;
            esac
          done
          exec node ${final.adb-web-dist}/server.cjs \
            --static-dir ${final.adb-web-dist} \
            --runner ${final.adb-runner}/bin/adb-runner \
            --executor-python ${final.adb-runner}/bin/python \
            --execution-source "$source" "$@"
        '';
      };
    }
    # web tooling appears once web/ lands (see the adb-web block below)
    // lib.optionalAttrs (builtins.pathExists ../../web) {
      # TS everywhere in web/: a vite frontend and a node server with ZERO runtime
      # dependencies (stdlib only — npm stays a build-time affair). build.sh is THE
      # web build; nix, devshells, and CI all call the same script. Deps come from
      # pnpm-lock.yaml via fetchPnpmDeps — after a lockfile change, refresh `hash`
      # (build with `hash = ""` and copy the mismatch).
      adb-web-dist = pkgs.stdenvNoCC.mkDerivation (finalAttrs: {
        pname = "adb-web-dist";
        version = "0.1.0";
        # filter dev-loop artifacts (adb.cleanImport): in a non-git checkout the flake
        # copies the whole tree, and a stray node_modules/dist in src breaks
        # pnpmConfigHook
        src = final.adb.cleanImport "adb-web-src" ../../web;
        pnpmDeps = pkgs.fetchPnpmDeps {
          inherit (finalAttrs) pname version src;
          fetcherVersion = 4;
          hash = "sha256-p0yW3cerwwW2dvclr5UNX1EjKRaVBm485r8Z5YAhAfg=";
        };
        nativeBuildInputs = [ pkgs.nodejs pkgs.pnpm pkgs.pnpmConfigHook ];
        # Compile trusted repository MDX at build time, never downloaded run data.
        preBuild = ''
          cp -r ${lib.cleanSourceWith {
            src = experimentsDir;
            name = "adb-experiment-presentation";
            filter = path: type:
              (type == "directory" && !(builtins.elem (baseNameOf path) [ "node_modules" "__pycache__" ".git" ])) ||
              (type == "regular" && builtins.match ".*\\.(mdx|json|tsx|ts|jsx|js|svg|png|jpg|webp)" path != null);
          }} experiment-content
        '';
        buildPhase = ''runHook preBuild; bash ./build.sh; runHook postBuild'';
        installPhase = ''cp -r dist $out'';
      });

      # experiment manifests (schema) the GUI's run-config builder reads via
      # /api/experiments — one <name>.json per registered experiment
      adb-web-manifests = catalog;

      # the user-facing entrypoint: node runs the bundled server, which serves the
      # bundled frontend from the same dist. Read-only unless adb-local enables
      # execution; the server then owns the executor and credential context.
      adb-web = pkgs.writeShellApplication {
        name = "adb-web";
        runtimeInputs = [ pkgs.nodejs ];
        text = ''
          for arg in "$@"; do
            case "$arg" in
              --static-dir|--static-dir=*|--catalog|--catalog=*|--runner|--runner=*|--executor-python|--executor-python=*|--execution-source|--execution-source=*|--viewer-only|--viewer-only=*)
                echo "This option is managed by the ADB launcher: $arg" >&2
                exit 2
                ;;
            esac
          done
          exec node ${final.adb-web-dist}/server.cjs --viewer-only \
            --static-dir ${final.adb-web-dist} \
            --catalog ${final.adb-web-manifests} "$@"
        '';
      };
    }
    # experiments/<dir>/package.nix → { <experiment-name> = mkExperiment …; }
    // lib.mapAttrs'
      (name: _:
        let
          directory = experimentsDir + "/${name}";
          markdown = directory + "/README.md";
          hasMarkdown = builtins.pathExists markdown;
          hasMdx = builtins.pathExists (directory + "/README.mdx");
        in
        if hasMarkdown && hasMdx then
          throw "experiment ${name} has both README.md and README.mdx; keep exactly one"
        else lib.nameValuePair "experiments-${name}"
        (final.callPackage (directory + "/package.nix") {
          # A directory can declare several experiments; they share its README.
          # Markdown ships in manifests; MDX and its imports ship in the web bundle.
          adb = final.adb // {
            mkExperiment = args: let experiment = final.adb.mkExperiment (args // {
              readme = if hasMarkdown then builtins.readFile markdown else null;
              # Package committed images; illustration tools are never build inputs.
              readmeAssets = if hasMdx then null else lib.cleanSourceWith {
                src = directory;
                name = "adb-readme-assets-${name}";
                filter = path: type: (type == "directory"
                  && !(lib.hasPrefix "." (baseNameOf path))
                  && !(builtins.elem (baseNameOf path) [ "node_modules" "__pycache__" ])) ||
                  (type == "regular" && builtins.match ".*\\.(svg|png|jpg|jpeg|gif|webp)" path != null);
              };
            }); in experiment // lib.optionalAttrs (builtins.pathExists (directory + "/tests/default.nix")) {
              # Keep nixpkgs' passthru.tests convention on our experiment attrset.
              passthru = (experiment.passthru or { }) // {
                tests = removeAttrs
                  (final.callPackage (directory + "/tests/default.nix") { inherit experiment; })
                  [ "override" "overrideDerivation" ];
              };
            };
          };
        }))
      (lib.genAttrs dirNames (_: null)));

  # flatten the per-directory sets into the experiment registry, refusing name
  # collisions (callPackage decorates each set with override/overrideDerivation —
  # drop those)
  registry = lib.foldl'
    (acc: setRaw:
      let
        set = removeAttrs setRaw [ "override" "overrideDerivation" ];
        dup = builtins.attrNames (builtins.intersectAttrs acc set);
      in
      if dup != [ ] then throw "duplicate experiment name(s): ${toString dup}"
      else acc // set)
    { }
    (map (name: scope."experiments-${name}") dirNames);
  catalog = pkgs.linkFarm "adb-manifests"
    (lib.concatLists (lib.mapAttrsToList
      (name: exp: [{ name = "${name}.json"; path = exp.manifest; }]
        ++ lib.optional (exp.readmeAssets != null) {
          name = "assets/${name}"; path = exp.readmeAssets;
        }) registry));

in
{
  experiments = registry;
  manifests = catalog;
  inherit (scope) adb adb-runner;
}
// lib.optionalAttrs (builtins.pathExists ../../web) {
  inherit (scope) adb-web adb-web-dist adb-local;
}
