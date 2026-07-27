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
{ pkgs, self }:

let
  inherit (pkgs) lib;

  origin = "github:antimemetics-institute/agentdatabank";

  experimentsDir = ../../experiments;
  familyNames =
    if builtins.pathExists experimentsDir then
      lib.attrNames
        (lib.filterAttrs
          (name: _: builtins.pathExists (experimentsDir + "/${name}/package.nix"))
          (builtins.readDir experimentsDir))
    else [ ];

  scope = lib.makeScope pkgs.newScope (final:
    {
      # build support — the `adb` attrset experiment declarations take as an argument.
      adb = final.callPackage ../build-support {
        inherit origin rev narHash;
      };

      # ADB's own tools; the adb- prefix keeps them out of the registry's bare namespace.
      # The runner packages itself from its own uv.lock (uv2nix) — see runner/default.nix.
      adb-runner = final.callPackage ../../runner { };
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
        # filter dev-loop artifacts: in a non-git checkout the flake copies the whole
        # tree, and a stray node_modules/dist in src breaks pnpmConfigHook
        src = builtins.path {
          path = ../../web;
          name = "adb-web-src";
          filter = path: _type:
            !(builtins.elem (baseNameOf path) [ "node_modules" "dist" ".venv" ]);
        };
        pnpmDeps = pkgs.fetchPnpmDeps {
          inherit (finalAttrs) pname version src;
          fetcherVersion = 4;
          hash = "sha256-F5wFobrDLLR9ju4XtQ9uN5UCOwc8Vg4A9JvldjZ34rU=";
        };
        nativeBuildInputs = [ pkgs.nodejs pkgs.pnpm pkgs.pnpmConfigHook ];
        buildPhase = ''bash ./build.sh'';
        installPhase = ''cp -r dist $out'';
      });

      # experiment manifests (schema) the GUI's run-config builder reads via
      # /api/experiments — one <name>.json per registered experiment
      adb-web-manifests = pkgs.linkFarm "adb-web-manifests"
        (lib.mapAttrsToList
          (name: exp: { name = "${name}.json"; path = exp.manifest; })
          experiments);

      # the user-facing entrypoint: node runs the bundled server, which serves the
      # bundled frontend from the same dist
      adb-web = pkgs.writeShellApplication {
        name = "adb-web";
        runtimeInputs = [ pkgs.nodejs ];
        text = ''
          export ADB_WEB_STATIC=''${ADB_WEB_STATIC:-${final.adb-web-dist}}
          export ADB_WEB_MANIFESTS=''${ADB_WEB_MANIFESTS:-${final.adb-web-manifests}}
          exec node ${final.adb-web-dist}/server.cjs "$@"
        '';
      };
    }
    # families: experiments/<family>/package.nix → { <experiment-name> = mkExperiment …; }
    // lib.mapAttrs'
      (name: _: lib.nameValuePair "family-${name}"
        (final.callPackage (experimentsDir + "/${name}/package.nix") { }))
      (lib.genAttrs familyNames (_: null)));

  # flatten families into the experiment registry, refusing name collisions
  # (callPackage decorates each family set with override/overrideDerivation — drop those)
  experiments = lib.foldl'
    (acc: familyRaw:
      let
        family = removeAttrs familyRaw [ "override" "overrideDerivation" ];
        dup = builtins.attrNames (builtins.intersectAttrs acc family);
      in
      if dup != [ ] then throw "duplicate experiment name(s): ${toString dup}"
      else acc // family)
    { }
    (map (name: scope."family-${name}") familyNames);
in
{
  inherit experiments;
  inherit (scope) adb-runner;
}
// lib.optionalAttrs (builtins.pathExists ../../web) {
  inherit (scope) adb-web adb-web-dist;
}
