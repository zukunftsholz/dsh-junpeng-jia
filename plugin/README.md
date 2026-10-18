# dsh-junpeng-jia

Deep compatibility inspection for third-party DeepSeek Harness plugins, with a
graded dual-factor verdict and an opt-in GitHub update-request (issue) flow.

The bundle is installed into a DSH profile; the browser half contributes to the
Plugins page (`plugins.detail.badge`, `plugins.detail.section`, `plugins.tab`).

## What it checks

Four read-only layers per third-party bundle:

| Layer | Reads | Fails when |
| --- | --- | --- |
| `manifest` | the bundle's `package.json` | `engines.dsh` or a DSH peer range is unsatisfied, the bundle patch is missing, the client platform is not `web` |
| `resolution` | the runtime's installed package versions | a declared DSH peer cannot be resolved |
| `symbols` | the entry module text and the live Cordis services | a declared `inject` service key does not exist, a `dsh.client.inject` package is not in the client graph |
| `activation` | Loader facts from `pluginManager` | a row fiber failed, the bundle carries an error, or the row is unaddressable |

The verdict has two factors:

- **A (plugin side)** — `manifest` + `resolution` + `symbols`.
- **B (runtime side)** — DSH's own admission decision: `compatibility.json`
  exemptions, unmet requirements without an exemption, and the Loader's live
  fiber state.

`red` requires both sides to fail; exactly one side failing is `yellow`; a
missing runtime version is `unknown`. Only `red` is eligible for a nudge.

## Install

From the Plugins page (Add plugin → Install a third-party plugin), or:

```text
plugin_manager install_bundle {"target": "C:\\absolute\\path\\to\\dsh-junpeng-jia\\plugin"}
```

or with the CLI:

```text
dsh plugin --profile <profile> add <absolute path to plugin directory>
```

## Settings

Settings live in the profile's `cordis.patch.yml` under the `junpengjia` row and
can be edited from the plugin's UI where writable:

| Field | Default | Meaning |
| --- | --- | --- |
| `autoNudge` | `false` | allow filing without a per-issue confirmation |
| `draftOnly` | `true` | always produce a prefilled GitHub draft URL |
| `renudgeAfterDays` | `30` | dedupe window per (repo, package, signature) |
| `maxIssuesPerDay` | `3` | hard cap for automatic filing |
| `runtimeVersionOverride` | `''` | pin the baseline version when auto-detection fails |
| `tokenRef` | `JUNPENG_JIA_GITHUB_TOKEN` | credential reference holding the PAT |
| `repoOverrides` | `{}` | package name → `owner/repo` for packages without a repository field |

The PAT is stored through the credential service and is never written to
configuration, logs, the state file, or an issue body.

## Privacy

An issue body contains the DSH version, the plugin name/version, the failing
check codes with expected/actual values, and generic reproduction steps. It
contains no absolute paths, no user names, no session content, and no
credentials.

## State

`<profile>/.junpeng-jia/state.json` holds the cached reports, dedupe keys, and
the nudge history. It is written atomically; a corrupt file is backed up and
rebuilt.

## Verify

```text
node scripts/verify.mjs
node --test test/
```

Both are dependency-free and run on Node 20+.
