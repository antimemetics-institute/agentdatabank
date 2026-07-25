# adb-runner, packaged from its own uv.lock via uv2nix (non-flake pathway, pinned
# fetchGit — flake eval is pure, so revs are mandatory). Self-contained on purpose:
# this file moves with the project. The interpreter is pinned HERE, per project.
{ pkgs }:

let
  inherit (pkgs) lib;

  # 3.13, not 3.14: binary-wheel coverage. One-line bump when cp314 wheels are universal.
  python = pkgs.python313;

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

  workspace = uv2nix.lib.workspace.loadWorkspace { workspaceRoot = ./.; };

  pythonSet =
    (pkgs.callPackage pyproject-nix.build.packages { inherit python; }).overrideScope
      (lib.composeManyExtensions [
        pyproject-build-systems.overlays.default
        (workspace.mkPyprojectOverlay { sourcePreference = "wheel"; })
      ]);
in
# mainProgram: the venv carries several bins (adb-runner, adb-emit, python…) —
# name the canonical one so lib.getExe (and anything mainProgram-aware) resolves
# to adb-runner instead of guessing from the derivation name
(pythonSet.mkVirtualEnv "adb-runner-env" workspace.deps.default).overrideAttrs
  (old: { meta = (old.meta or { }) // { mainProgram = "adb-runner"; }; })
