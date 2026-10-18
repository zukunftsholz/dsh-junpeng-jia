// Cordis Config schema for dsh-junpeng-jia.
//
// This is the single authoritative schema for the plugin's settings: the Loader
// validates the profile row against it, the Settings service projects the
// `.volatile()` fields into an editable form, and `config-editor` persists edits
// into the profile's cordis.patch.yml (survives upgrades, hot-applied, serialized
// writes, invalid values rejected before they land).
//
// Every default mirrors `DEFAULTS` in lib/contract.js — a mismatch would make the
// schema the real source of truth and surprise the browser half, which cannot
// import contract.js. Keep them in step.
//
// volatile fields are exactly the ones the panel may rewrite through
// saveSettings(): they are plain scalars, so the "volatile fields require a fixed
// object path" rule is satisfied. checkTimeoutMs / maxBundles stay non-volatile:
// they change the inspection budget and the panel has no reason to hot-edit them
// mid-session, so a reload is the honest way to change them.
import z from '@deepseek-ai/schemastery'
import { DEFAULTS, TOKEN_REF } from './contract.js'

export const Config = z.object({
  /** Master switch for the automatic nudge path (still needs a config token). */
  autoNudge: z.boolean().default(DEFAULTS.autoNudge).volatile(),
  /** When true, `auto` degrades to a pre-filled GitHub draft link. */
  draftOnly: z.boolean().default(DEFAULTS.draftOnly).volatile(),
  /** Days before the same (repo, package, signature) may be nudged again. */
  renudgeAfterDays: z.number().min(1).max(3650).default(DEFAULTS.renudgeAfterDays).volatile(),
  /** Hard cap on filed issues per calendar day (local time). */
  maxIssuesPerDay: z.number().min(1).max(100).default(DEFAULTS.maxIssuesPerDay).volatile(),
  /** Explicit override for the running DSH version; '' means "probe the runtime". */
  runtimeVersionOverride: z.string().default(DEFAULTS.runtimeVersionOverride).volatile(),
  /** Credential reference name under which the GitHub PAT is stored. */
  tokenRef: z.string().default(TOKEN_REF).volatile(),
  /** Manual `{ "package-name": "owner/repo" }` mapping, for manifests with no repository. */
  repoOverrides: z.dict(z.string(), z.string()).default({}).volatile(),
  /** Per-bundle inspection budget in milliseconds. */
  checkTimeoutMs: z.number().min(100).max(120_000).default(DEFAULTS.checkTimeoutMs),
  /** Upper bound on bundles listed by overview(). */
  maxBundles: z.number().min(1).max(5_000).default(DEFAULTS.maxBundles),
})

/** Fields saveSettings() is allowed to write, in the order the panel shows them. */
export const WRITABLE_FIELDS = [
  'autoNudge',
  'draftOnly',
  'renudgeAfterDays',
  'maxIssuesPerDay',
  'runtimeVersionOverride',
  'tokenRef',
  'repoOverrides',
]

/** Fields that must never be written by a remote caller. */
export const READ_ONLY_FIELDS = ['checkTimeoutMs', 'maxBundles']

/**
 * Flatten the config handed to `apply(ctx, config)` into plain values.
 *
 * With a Cordis Config that declares `.volatile()` fields, `apply` receives a
 * Volatile *reference* (a frozen `{ get() }` object) for those fields. Modules
 * that keep the reference and call `get()` per read see live updates; this
 * helper exists for callers that only want a point-in-time snapshot.
 */
export function unwrapConfig(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) return {}
  const out = {}
  for (const [key, value] of Object.entries(config)) {
    out[key] = value && typeof value === 'object' && !Array.isArray(value) && typeof value.get === 'function'
      ? value.get()
      : value
  }
  return out
}

/**
 * Read one setting from a config that may hold Volatile references.
 * Always re-`get()`s, so a `settings.update` that mutates the reference in place
 * is visible without re-running `apply`.
 */
export function readConfig(config, key, fallback = DEFAULTS[key]) {
  if (!config || typeof config !== 'object') return fallback
  const value = config[key]
  if (value === undefined) return fallback
  const resolved = value && typeof value === 'object' && typeof value.get === 'function' ? value.get() : value
  return resolved === undefined || resolved === null ? fallback : resolved
}

/** A full snapshot with DEFAULTS applied — what the service reasons about. */
export function snapshotConfig(config) {
  const out = {}
  for (const key of Object.keys(DEFAULTS)) out[key] = readConfig(config, key)
  // repoOverrides is an object; never hand out the live reference.
  out.repoOverrides = { ...(out.repoOverrides || {}) }
  if (typeof out.tokenRef !== 'string' || !out.tokenRef) out.tokenRef = TOKEN_REF
  return out
}

export default Config
