{
  description = "ADB — Agent Databank: reusable agent experiments + a databank of runs";

  # channel tarball, not github: channels.nixos.org serves an immutable-link header, so
  # the lock pins the permanent release URL (and it's what nix-channel users mirror).
  # Stable, not unstable: experiment closures and env fingerprints should churn on
  # NixOS releases (~6 months), not on every channel advance.
  inputs.nixpkgs.url = "https://channels.nixos.org/nixos-26.05/nixexprs.tar.xz";

  outputs = { self, nixpkgs }:
    let
      systems = [ "x86_64-linux" "aarch64-linux" "x86_64-darwin" "aarch64-darwin" ];
      forAllSystems = f: nixpkgs.lib.genAttrs systems (system:
        f (import nixpkgs { inherit system; }));
    in
    {
      # Namespace policy (nixpkgs-flat, like `nixpkgs#dig`): experiments get bare names —
      # they are the product and the headline oneliner (`nix run adb#inspect-hello`).
      # ADB's own tools carry the `adb-` prefix (`adb-web`, `adb-runner`), so the bare
      # namespace belongs to the registry and name collisions are a curation duty, as
      # in nixpkgs.
      apps = forAllSystems (pkgs:
        let
          adbPkgs = import ./pkgs/top-level { inherit pkgs; rev = self.rev or null; narHash = self.narHash or null; };
        in
        builtins.mapAttrs
          (name: exp: {
            type = "app";
            program = "${exp.app}/bin/adb-${name}";
          })
          adbPkgs.experiments
        # `nix run .#adb-runner -- credentials …` to manage local model credentials
        # (endpoints + keys), which the runner injects into experiments so they never
        # land in params or on the command line.
        // {
          adb-runner = {
            type = "app";
            program = "${adbPkgs.adb-runner}/bin/adb-runner";
          };
          # authoring CLI: `nix run adb#adb-dev -- init my-exp` scaffolds an
          # external experiment repo pinned to this adb
          adb-dev = {
            type = "app";
            program = "${adbPkgs.adb-dev}/bin/adb-dev";
          };
        }
        // nixpkgs.lib.optionalAttrs (adbPkgs ? adb-web) {
          adb-web = {
            type = "app";
            program = "${adbPkgs.adb-web}/bin/adb-web";
          };
        });

      packages = forAllSystems (pkgs:
        let
          adbPkgs = import ./pkgs/top-level { inherit pkgs; rev = self.rev or null; narHash = self.narHash or null; };
        in
        {
          inherit (adbPkgs) adb-runner adb-dev;
          manifests = pkgs.linkFarm "adb-manifests"
            (nixpkgs.lib.mapAttrsToList
              (name: exp: { name = "${name}.json"; path = exp.manifest; })
              adbPkgs.experiments);
        }
        // nixpkgs.lib.optionalAttrs (adbPkgs ? adb-web) {
          inherit (adbPkgs) adb-web;
          # the bare dist (frontend + server.cjs) — used by scripts/docs-screenshots.sh
          inherit (adbPkgs) adb-web-dist;
        }
        // nixpkgs.lib.mapAttrs' (name: exp: nixpkgs.lib.nameValuePair "experiment-${name}" exp.app)
          adbPkgs.experiments);

      # lean by design: pure builds only (registry-wide manifest eval + the tools).
      # The impure acceptance tests — entrypoint identity, the authoring smoke —
      # can't be derivations (they invoke nix itself / need network) and live in
      # scripts/ + CI instead.
      checks = nixpkgs.lib.genAttrs systems (system: {
        inherit (self.packages.${system}) manifests adb-dev adb-runner;
      });

      devShells = forAllSystems (pkgs: {
        default = import ./shell.nix { inherit pkgs; };
      });
    };
}
