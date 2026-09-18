# Publishing

ADB publishes verified terminal runs to an S3 bucket at a target supplied by you.
There are no built-in hosts, provider presets, saved remotes, or target
environment variables. The bucket contains only `runs/` under the selected prefix.

## Set up an AWS profile

Create the bucket and configure a named AWS profile using your storage provider's
instructions. For Hugging Face Storage Buckets, follow its
[S3 client and AWS profile setup](https://huggingface.co/docs/hub/storage-buckets-s3).
For Amazon S3, follow the
[AWS credentials guide](https://docs.aws.amazon.com/boto3/latest/guide/credentials.html).
Keep endpoint, region, addressing and checksum settings in your AWS configuration,
and credentials in the provider's supported credential source.

`--profile research` selects that AWS profile. Omit it to use
[boto3's normal credential resolution](https://docs.aws.amazon.com/boto3/latest/guide/credentials.html).
ADB creates a boto3 session and its S3 client without overriding endpoint, region
or client configuration. Ambient AWS settings are not passed into the experiment
process; credential sets explicitly selected for the experiment still are.
The web Publish panel reads profile names from `~/.aws/config` and never writes
AWS files.

## Publish when a run finishes

Add `--publish` and optionally an AWS `--profile` to the experiment command. This
complete mock-model example executes one run and publishes it:

```bash
nix run .#inspect-hello -- --set model=mockllm/model --set limit=0 --set epochs=1 --set 'generate_args={}' --publish s3://my-bucket/adb-v1 --profile research
```

The same options are available in the browser's **Publish** panel: enter the
S3 target, choose a profile or default AWS resolution, and enable **Publish on
completion**. The copied command and the browser Run button use those settings.
The run's data directory still follows `--data-dir`, `ADB_DATA_DIR`, then the
[XDG default](../reference/local.md#choose-where-results-are-saved).

`--profile NAME` selects the AWS profile for publication. Model credentials
use `--credential SET=NAME`; both flags can appear in the same command.

Publication requires a terminal state and a passing [verify audit](model.md#how-do-i-audit-the-first-real-run).
Failed and interrupted runs can publish when their evidence passes that audit.
A publishing error is logged without changing the run state or exit code.

## Publish saved runs

Run the batch command against a local data directory:

```bash
nix run .#adb-runner -- publish --to s3://my-bucket/adb-v1 --profile research --data-dir "$HOME/adb-data"
```

With no stems, it considers all runs. Add `--experiment NAME` to filter by the
experiment recorded on each card, or supply one or more positional stems:
`<condition>-<experiment>` for a whole condition, or
`<condition>-<experiment>/<run>` for one run. Stems are relative to `runs/`.
Each run is verified independently; a rejected run does not stop the batch.
The command returns a nonzero exit code if any run fails to publish.

`--dry-run` verifies and prints the exact object keys and byte sizes, including
compressed streams. It checks the bucket for existing run keys but writes nothing.
Verification resolves the manifest in the same way as `adb-runner verify`: from
`ADB_MANIFEST`, then the experiment's file in `ADB_MANIFESTS`, or a manifest catalog
built from the current checkout.

Publication checks both destination run keys with HEAD. If either already exists,
it refuses to overwrite that run, including a partial upload. Other runs continue.
Choose a new prefix when you need different immutable objects.

Each run uploads exactly these two objects:

```text
<prefix>/runs/<condition>-<experiment>/<run>/events.jsonl.zst
<prefix>/runs/<condition>-<experiment>/<run>/run.json
```

The stream is compressed at zstd level 19 in a single frame with
`Content-Type: application/zstd`, preserving its original bytes when decompressed.
The card is copied byte-for-byte with `Content-Type: application/json`.
Workspaces are never uploaded. See the [published layout](../reference/layout.md#published-runs).
