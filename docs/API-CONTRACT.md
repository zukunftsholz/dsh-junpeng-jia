# Host ⇄ Client contract (v1)

Namespace `junpengjia`, Cordis service key `junpengjia`. The browser half mounts a
hand-written Typert Remote contribution; the Host half implements
`TypertRemoteService`. Every method takes positional single-identifier parameters
(the Gateway's SRC fallback parses parameter names), and every result is plain JSON.

The client receives `RemoteResult<T>` wrappers (`{ok:true,value}` / `{ok:false,error}`)
from `ctx.remote.junpengjia.*`; the shapes below describe `value`.

## Methods

### `overview()`

```ts
{
  runtimeVersion: string        // '' when unknown
  runtimeSource: string         // 'env' | 'resolve' | 'asar' | 'config' | 'unknown'
  profile: string               // profile name, never an absolute path
  checkedAt: number             // epoch ms
  settings: SettingsView
  bundles: BundleSummary[]      // third-party bundles only
}
```

`BundleSummary`:

```ts
{
  name: string
  version: string
  title: string                 // localized meta title, falls back to name
  description: string
  official: boolean             // always false in this array
  enabled: boolean
  availability: 'installation' | 'profile' | 'missing'
  repo: string | null           // 'owner/repo'
  grade: 'green' | 'yellow' | 'red' | 'unknown'
  lastCheckedAt: number | null
  stale: boolean
  counts: { fail: number; warn: number }
  eligible: boolean             // grade==='red' && repo!==null
  nudge: { state: 'none' | 'drafted' | 'filed' | 'blocked'; url: string | null; at: number | null }
}
```

### `inspect(name)`

Runs (or reuses a fresh cache of) the four-layer inspection for one bundle.

```ts
{ ok: true, report: Report } | { ok: false, error: string }
```

`Report`:

```ts
{
  name: string
  version: string
  title: string
  repo: string | null
  runtimeVersion: string
  runtimeSource: string
  checkedAt: number
  grade: 'green' | 'yellow' | 'red' | 'unknown'
  eligible: boolean
  factorA: SideVerdict          // plugin side: manifest+resolution+symbols
  factorB: SideVerdict          // DSH admission: exemptions + loader state
  layers: Layer[]
  findings: Finding[]           // flattened, same objects as in layers
  activation: {
    rows: { rowId: string; moduleName: string; fiberPhase: string | null; enabled: boolean }[]
    error: string | null
  }
  dedupe: { key: string; lastNudgedAt: number | null; allowedAt: number | null; duplicate: boolean }
}
```

`SideVerdict`: `{ status: 'pass' | 'warn' | 'fail'; reasons: string[] }`

`Layer`: `{ id: 'manifest' | 'resolution' | 'symbols' | 'activation'; label: string; status: 'pass' | 'warn' | 'fail' | 'skip'; findings: Finding[] }`

`Finding`: `{ code: string; severity: 'info' | 'warn' | 'fail'; message: string; expected?: string; actual?: string; hint?: string }`

### `nudge(name, mode)`

`mode` is `'draft'` or `'auto'`. `'auto'` degrades to `'draft'` when the token is
missing or `draftOnly` is on.

```ts
{ ok: true, outcome: 'drafted' | 'filed' | 'duplicate' | 'blocked',
  url: string | null, number: number | null, message: string }
| { ok: false, error: string }
```

Gate: `outcome: 'blocked'` when `grade !== 'red'`, when `repo === null`, when the
dedupe window is still open (`outcome: 'duplicate'`), or when the daily cap is hit.

### `settings()` / `saveSettings(patch)`

`SettingsView`:

```ts
{
  autoNudge: boolean
  draftOnly: boolean
  renudgeAfterDays: number
  maxIssuesPerDay: number
  runtimeVersionOverride: string
  tokenRef: string
  tokenConfigured: boolean
  repoOverrides: Record<string, string>
}
```

`saveSettings` accepts a partial of the writable fields and returns
`{ ok: true, settings }` or `{ ok: false, error }`.

### `setToken(token)`

Stores (or clears, with `''`) the PAT through `ctx.credentials` under `tokenRef`.
Returns `{ ok: true, tokenConfigured: boolean }` or `{ ok: false, error }`.
The value is never echoed back, logged, or written to the state file.

### `history()`

```ts
{ entries: NudgeRecord[] }   // newest first, capped at 100
```

`NudgeRecord`:

```ts
{
  at: number
  package: string
  version: string
  runtimeVersion: string
  repo: string
  signature: string
  mode: 'draft' | 'auto'
  outcome: 'drafted' | 'filed' | 'duplicate' | 'blocked'
  url: string | null
  number: number | null
}
```

## Agent tool

`junpengjia` with `{ action: 'status' | 'check' | 'nudge', name?: string, mode?: 'draft' | 'auto' }`.
It calls the same service methods as the UI; it never grants authority by itself
(filing an issue needs the user's explicit action or the `autoNudge` setting).

## Grading

| Factor A (plugin) | Factor B (DSH) | Grade |
| --- | --- | --- |
| pass | pass | green |
| fail | fail | red |
| fail | warn | yellow |
| warn | fail | yellow |
| warn | warn | yellow |
| fail/warn | pass | yellow |
| pass | fail/warn | yellow |
| runtime version unknown | any | unknown |

Red requires at least one real `fail` on **both** sides. A `warn` is an
inconclusive probe, not evidence that the plugin is broken, so it never
completes the pair that authorizes filing an issue. Only `red` is eligible for
a nudge.
