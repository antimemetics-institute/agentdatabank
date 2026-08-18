# NixOS module for a self-hosted ADB queue worker.
#
#   imports = [ (adb + "/pkgs/adb-worker/module.nix") ];   # adb = fetchGit / path
#   services.adb-worker = {
#     enable = true;
#     package = (import adb { }).adb-worker;
#     serverUrl = "https://adb.example.org";              # or a LAN adb-web
#     tokenFile = config.age.secrets.adb-worker-token.path;
#     credentialsFile = config.age.secrets.adb-credentials.path;
#   };
#
# Secrets are FILES, never nix-store values: tokenFile and credentialsFile are
# paths delivered by your secret manager (agenix/sops-nix); they reach the worker
# via systemd LoadCredential, so they are readable by this service alone and never
# land in the store or the environment blocks of `systemctl show`.
#
# The worker builds experiments with nix, so it talks to the host's nix-daemon as
# its own (dynamic) user — allow it: `nix.settings.allowed-users` must cover
# "adb-worker" (or "@nixbld"-style groups you already use).
{ config, lib, pkgs, ... }:

let
  cfg = config.services.adb-worker;
in
{
  options.services.adb-worker = {
    enable = lib.mkEnableOption "the ADB queue worker";

    package = lib.mkOption {
      type = lib.types.package;
      description = "The adb-worker package, e.g. (import <adb> { }).adb-worker.";
    };

    serverUrl = lib.mkOption {
      type = lib.types.str;
      example = "http://192.168.1.10:8340";
      description = "The queue to serve — an adb-web instance (or, later, the hosted index).";
    };

    name = lib.mkOption {
      type = lib.types.str;
      default = config.networking.hostName;
      defaultText = lib.literalExpression "config.networking.hostName";
      description = "How this worker introduces itself in the runners list.";
    };

    tokenFile = lib.mkOption {
      type = lib.types.nullOr lib.types.path;
      default = null;
      description = ''
        File containing the bearer token that ties this worker to the server
        (required for a non-loopback serverUrl). A file path from your secret
        manager — never a store path.
      '';
    };

    credentialsFile = lib.mkOption {
      type = lib.types.nullOr lib.types.path;
      default = null;
      description = ''
        This worker's credential store (the credentials.toml shape) as a secret
        file. Jobs reference profiles by NAME; the values resolve from here, on
        this machine, at execution time. Absent → only credential-free
        (mock-model) jobs can succeed.
      '';
    };

    stateDir = lib.mkOption {
      type = lib.types.str;
      default = "adb-worker";
      description = "StateDirectory under /var/lib — becomes the worker's ADB_HOME (run store).";
    };

    repo = lib.mkOption {
      type = lib.types.nullOr lib.types.str;
      default = null;
      description = ''
        The ONE repo this worker builds experiments from — its registration
        identity: a checkout/store path or a tarball URL. null = the pinned
        source baked into `package` (same-pin with the worker itself). Point
        this at a FORK repo to serve that fork's external experiments. Jobs are
        source-free; what a worker runs is decided here, by its operator.
      '';
    };
  };

  config = lib.mkIf cfg.enable {
    systemd.services.adb-worker = {
      description = "ADB queue worker";
      wantedBy = [ "multi-user.target" ];
      wants = [ "network-online.target" ];
      after = [ "network-online.target" ];
      path = [ pkgs.nix ];

      environment = {
        ADB_HOME = "/var/lib/${cfg.stateDir}";
      } // lib.optionalAttrs (cfg.repo != null) {
        ADB_WORKER_REPO = cfg.repo;
      } // lib.optionalAttrs (cfg.credentialsFile != null) {
        # LoadCredential materializes the secret at a private path; the runner
        # already honors ADB_CREDENTIALS_FILE, so no wrapper is needed
        ADB_CREDENTIALS_FILE = "%d/credentials.toml";
      };

      serviceConfig = {
        DynamicUser = true;
        User = "adb-worker";
        StateDirectory = cfg.stateDir;
        Restart = "always";
        RestartSec = 10;
        LoadCredential =
          lib.optional (cfg.tokenFile != null) "token:${cfg.tokenFile}"
          ++ lib.optional (cfg.credentialsFile != null) "credentials.toml:${cfg.credentialsFile}";
        ExecStart = lib.concatStringsSep " " ([
          "${lib.getExe cfg.package}"
          "--server" (lib.escapeShellArg cfg.serverUrl)
          "--name" (lib.escapeShellArg cfg.name)
        ] ++ lib.optionals (cfg.tokenFile != null) [ "--token-file" "%d/token" ]);
      };
    };
  };
}
