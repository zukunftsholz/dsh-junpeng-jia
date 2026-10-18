# dsh-junpeng-jia

Deep compatibility inspection for third-party DeepSeek Harness (DSH) plugins,
with a graded **dual-factor** verdict and an opt-in GitHub update-request
("nudge") flow.

The plugin answers one question: *is this third-party plugin actually broken on
the DSH version I am running — and does DSH agree?* It only ever asks you to
file an issue when **both** the plugin's own declarations and DSH's own
admission check say the plugin is unsupported.

This repository is the installable bundle: the repository root is the package
root, so the git address can be installed directly.

- Host half: [`lib/`](lib/) — inspection engine, runtime resolution, semver,
  GitHub client, dedupe store, Typert Remote service, agent tool.
- Client half: [`lib/client.js`](lib/client.js) — Plugins-page badge, detail
  section, and a **Compatibility** tab.
- Bundle patch: [`cordis.patch.yml`](cordis.patch.yml) (row id `junpengjia`).

Everything is read-only with respect to the inspected plugins: the engine reads
manifests, resolves installed versions, and statically scans entry module text.
It never executes third-party plugin code.

---

## What it checks

Four layers, evaluated per third-party bundle:

| Layer | Reads | Fails when |
| --- | --- | --- |
| **L1 manifest** | the bundle's `package.json` | `engines.dsh` or a `@deepseek-ai/dsh*` peer range is unsatisfied; the declared bundle patch is missing; `dsh.client.platform` is not `web` |
| **L2 resolution** | installed versions in the running runtime | a declared DSH peer dependency cannot be resolved locally |
| **L3 symbols** | entry module text + the live Cordis service table | a declared `inject` service key does not exist; a `dsh.client.external` module is absent from the client module graph |
| **L4 activation** | Loader facts from `pluginManager` | a row's fiber phase is `failed`, the bundle carries an error, or a row is unaddressable |

L4 findings are evidence, not proof: a disabled plugin is a `warn`, not an
incompatibility.

## Dual-factor grading

The grade needs two independent verdicts to agree before anything is filed.

- **Factor A — plugin side:** the combined result of L1 + L2 + L3.
- **Factor B — DSH side:** DSH's own admission decision — the profile's
  `compatibility.json` exemption state, admission refusal for an unmet
  requirement, and the Loader's live fiber state.

| Factor A (plugin) | Factor B (DSH) | Grade | Nudge eligible |
| --- | --- | --- | --- |
| pass | pass | **green** | no |
| fail or warn | pass | **yellow** | no |
| pass | fail or warn | **yellow** | no |
| **fail** | **fail** | **red** | **yes** |
| fail | warn | **yellow** | no |
| warn | fail | **yellow** | no |
| warn | warn | **yellow** | no |
| *runtime version unknown* | *any* | **unknown** | no |

Red requires a real failure on **both** sides. A `warn` never promotes to red —
it usually means our own probe was inconclusive, and asking a maintainer for a
release should need the strongest evidence available. Only **red** with a
resolved GitHub repository is eligible for a nudge; everything else is a signal
to look at later.

A note on admission, because it decides Factor A's manifest layer: if a plugin
declares `engines.dsh`, that range **alone** decides and its
`peerDependencies` are ignored; otherwise every `@deepseek-ai/dsh` and
`@deepseek-ai/dsh-*` peer range must match. Prereleases participate in range
matching (this is DSH's own rule, not strict npm behavior), and an empty or
invalid `engines.dsh` counts as incompatible.

## Installation

Because the repository root is the package root, any of these work:

**From a DSH session (plugin_manager tool):**

```json
plugin_manager install_bundle {"target": "https://github.com/zukunftsholz/dsh-junpeng-jia"}
```

or, for a local checkout:

```json
plugin_manager install_bundle {"target": "C:\\absolute\\path\\to\\dsh-junpeng-jia"}
```

**From a shell:**

```text
dsh plugin --profile <profile> add https://github.com/zukunftsholz/dsh-junpeng-jia
```

Use the **absolute** path to the directory containing `package.json`; with this
layout that is the repository root.

After installing, refresh the Plugins page. The bundle adds:

- a status **badge** on every third-party plugin's detail page,
- a compatibility **section** with the per-layer findings and the nudge actions,
- a **Compatibility** tab listing all third-party bundles with their grades.

To remove it, disable or uninstall the `junpengjia` row the same way as any
other bundle.

## Settings

Settings live in the profile's `cordis.patch.yml` under the `junpengjia` row and
can be changed from the UI where writable.

| Field | Default | Meaning |
| --- | --- | --- |
| `autoNudge` | `false` | allow filing an issue without a per-issue confirmation |
| `draftOnly` | `true` | always produce a prefilled GitHub draft URL instead of submitting |
| `renudgeAfterDays` | `30` | dedupe window per `(repo, package, signature)`; lower values re-nudge sooner (min `1`) |
| `maxIssuesPerDay` | `3` | hard cap on automatic filing in a rolling day |
| `runtimeVersionOverride` | `''` | pin the baseline runtime version when auto-detection fails |
| `tokenRef` | `JUNPENG_JIA_GITHUB_TOKEN` | credential reference that holds the PAT |
| `repoOverrides` | `{}` | package name → `owner/repo`, for packages with no `repository` field |
| `checkTimeoutMs` | `5000` | per-bundle inspection budget (read-only at runtime) |
| `maxBundles` | `100` | cap on bundles inspected per pass (read-only at runtime) |

`checkTimeoutMs` and `maxBundles` are not writable from the UI: changing the
inspection budget mid-session is not something the panel should do silently.
Edit them in `cordis.patch.yml` and reload.

The personal access token is stored through DSH's credential service under
`tokenRef`. It is never written to configuration, logs, the state file, or an
issue body. With no token, `auto` mode degrades to a draft.

State is kept at `<profile>/.junpeng-jia/state.json`: cached reports, dedupe
keys, and nudge history. Writes are atomic; a corrupt file is backed up as
`.corrupt-<timestamp>` and rebuilt.

## Privacy

An issue payload contains:

- the DSH runtime version and platform, and the Node/OS family,
- the plugin's name and version, and its GitHub `owner/repo`,
- the failing check codes with their expected and actual values,
- generic reproduction steps and a generator line naming this plugin.

It does **not** contain absolute filesystem paths, your OS user name, your
session content, other installed plugins, or any credential. Local paths are
scrubbed from every string field before the payload is built, and the token
travels only in the `Authorization` header — never in the issue body.

Draft mode is the default and touches no network at all: it only builds a
`https://github.com/<owner>/<repo>/issues/new?...` URL for you to open.

## Verification

No dependencies beyond Node 20+. From the repository root:

```text
node scripts/verify.mjs
node --test "test/*.test.mjs"
```

`scripts/verify.mjs` is a static gate over the shipped bundle: package manifest
fields and `dsh.bundle.patch` / `dsh.client.platform` wiring, `exports` and
`files` targets exist, every `lib/**/*.js` passes `node --check`, the
`TYPERT_REMOTE` descriptor in `client.js` exposes exactly the seven contract
methods, the locale dictionaries carry `meta.title`/`meta.description` for both
languages with matching keys, and `icon.svg` is a well-formed, script-free SVG
under 256 KiB. It exits `0` on success, `1` on a real failure, and `2` when
checks are blocked on files that are not on disk yet.

The test suite covers the semver range semantics DSH's admission rule depends on
(including prerelease participation), the grading table end to end on fixtures,
dedupe-signature stability, repository resolution, and the GitHub client's
payload privacy and HTTP status mapping with an injected `fetch` stub — no
network is used by any test.

On Node 24, `node --test test/` does **not** accept a bare directory argument;
use the quoted glob above (on Node 20/22 either form works).

## Layout

```text
package.json            manifest + dsh.bundle.patch / dsh.client wiring
cordis.patch.yml        inserts the `junpengjia` row
icon.svg                theme-neutral SVG icon
locale/{en,zh}.json     localized plugin title and description
lib/
  index.js              Host entry: apply(ctx, config)
  contract.js           shared literals (namespace, methods, codes, defaults)
  config.js             Schemastery Config
  client.js             browser half: badge / section / tab
  host/
    runtime.js          runtime + installed-version resolution
    semver.js           zero-dependency range engine (prerelease-aware)
    inspect.js          four-layer inspection -> Report
    github.js           repo resolution, issue builder, draft/auto filing
    store.js            dedupe keys, history, cached reports
    service.js          TypertRemoteService (namespace `junpengjia`)
docs/                   blueprint, Host↔Client contract, verification, handoff
scripts/verify.mjs      static gate
test/                   node:test suites
```

## License

MIT — see [LICENSE](LICENSE).
