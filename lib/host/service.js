// The Host half of the panel: one Cordis service, exposed to the browser through
// Typert Remote under the `junpengjia` namespace.
//
// Zero-build Typert contribution (proven pattern from dsh-sekaisync-connect):
// `Remote(name)` is a plain function returning a standard ES method decorator.
// Node has no decorator syntax without a build step, so `registerRemoteMethods`
// applies it by hand with a synthetic decorator context. The resulting marker is
// what the gateway's `remoteMethods()` reads.
//
// HARD CONSTRAINT (dsh-api-gateway SRC fallback): every Remote method must use
// single-identifier positional parameters. The gateway parses parameter names out
// of Function.prototype.toString, so no destructuring, no defaults, no rest:
//   inspect(name) · nudge(name, mode) · saveSettings(patch) · setToken(token)
//
// Return shapes are pinned by docs/API-CONTRACT.md and are NOT uniform:
//   overview()  -> BundleOverview (plain)      settings()  -> SettingsView (plain)
//   history()   -> { entries } (plain)         inspect()   -> { ok, report } | { ok:false, error }
//   nudge()     -> { ok, outcome, ... }        saveSettings() -> { ok, settings }
//   setToken()  -> { ok, tokenConfigured }
// The gateway wraps a method's raw return into `{ok:true, value}` on the client
// side, so the shapes below are what the browser reads as `value`.
//
// Nothing here throws across the Remote boundary: each method resolves to its
// documented shape, because an exception would surface in the UI as an opaque
// transport error with no actionable text.

import path from 'node:path'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'

import { DEFAULTS, NAMESPACE, TOKEN_REF } from '../contract.js'
import { readConfig, snapshotConfig, WRITABLE_FIELDS } from '../config.js'
import { inspectBundle } from './inspect.js'
import { buildIssue, draftUrl, fileIssue, resolveRepoFor } from './github.js'
import { createStore } from './store.js'
import {
  profileDirFromContext,
  profileNameFromDir,
  resolvePackageDir,
  resolveRuntimeVersionAsync,
} from './runtime.js'

/** Namespace the browser half calls as `ctx.remote.junpengjia.*`. */
export const SERVICE_NAMESPACE = NAMESPACE

/** How long one inspected Report stays reusable. */
export const REPORT_TTL_MS = 5 * 60 * 1000

/**
 * The live service instance, if one has been mounted.
 *
 * The agent tool must call "the same service methods" as the panel
 * (docs/API-CONTRACT.md §Agent tool), and `ctx.plugin()` does not hand back the
 * instance. Publishing it from the constructor keeps one implementation behind
 * both entry points; the fiber's effect clears it on unload/reload.
 */
let mountedService = null

/** @returns {JunpengJiaService|null} */
export function currentService() {
  return mountedService
}

/**
 * Apply `Remote(name)` markers to a class prototype without decorator syntax.
 * Mirrors dsh-sekaisync-connect's `registerRemoteMethods`: `Remote(name)` returns
 * `(method, context) => void` and calls `context.addInitializer(init)`, where the
 * initializer expects `this` to be an instance whose prototype receives the mark.
 */
export function registerRemoteMethods(cls, names) {
  for (const name of names) {
    const decorator = Remote(name)
    decorator(cls.prototype[name], {
      name,
      private: false,
      static: false,
      addInitializer(initializer) {
        initializer.call(Object.create(cls.prototype))
      },
    })
  }
  return cls
}

/** Remote method names, in contract order (docs/API-CONTRACT.md). */
export const REMOTE_METHOD_NAMES = [
  'overview',
  'inspect',
  'nudge',
  'settings',
  'saveSettings',
  'setToken',
  'history',
]

function okValue(value) {
  return { ok: true, value }
}

function failValue(message) {
  return { ok: false, error: { message: String(message || 'unknown error') } }
}

function failure(message) {
  return { ok: false, error: String(message || 'unknown error') }
}

function errorText(error) {
  return error && error.message ? error.message : String(error)
}

class JunpengJiaService extends TypertRemoteService {
  static inject = ['settings']

  /** @param {any} ctx Cordis context of the plugin fiber */
  /** @param {any} config profile-row config (may hold Volatile references) */
  constructor(ctx, config) {
    super(ctx, 'junpengjia', { namespace: SERVICE_NAMESPACE })
    this.config = config
    this.profileDir = profileDirFromContext(ctx)
    this.profileName = profileNameFromDir(this.profileDir)
    this.entryId = locateEntryId(ctx)
    this.store = createStore({ profileDir: this.profileDir })
    this._runtime = null
    // Publish for the agent tool; cleared by the owning fiber's effect.
    mountedService = this
    if (typeof ctx.effect === 'function') {
      ctx.effect(() => () => {
        if (mountedService === this) mountedService = null
      }, 'dsh-junpeng-jia: service handle')
    }
  }

  // ── settings plumbing ────────────────────────────────────────────────────

  /** Live config read; always re-`get()`s Volatile references. */
  get settingsSnapshot() {
    return snapshotConfig(this.config)
  }

  /** Runtime version, memoised per service instance (it cannot change in-process). */
  async runtime() {
    if (!this._runtime) {
      try {
        this._runtime = await resolveRuntimeVersionAsync({ config: this.settingsSnapshot })
      } catch {
        this._runtime = { version: '', source: 'unknown' }
      }
    }
    return this._runtime
  }

  /** Optional services, each fetched defensively (never a hard dependency). */
  services() {
    const get = (name) => {
      try {
        return typeof this.ctx.get === 'function' ? this.ctx.get(name) : undefined
      } catch {
        return undefined
      }
    }
    return {
      pluginManager: get('pluginManager'),
      clientModules: get('clientModules'),
      credentials: get('credentials'),
      settings: get('settings'),
    }
  }

  // ── Remote: overview ─────────────────────────────────────────────────────

  /**
   * Every third-party bundle with its current grade.
   * @returns {Promise<object>} BundleOverview (plain; never throws)
   */
  async overview() {
    try {
      const runtime = await this.runtime()
      const bundles = await this.thirdPartyBundles()
      const limit = Math.max(1, Number(readConfig(this.config, 'maxBundles')) || DEFAULTS.maxBundles)
      const summaries = []
      for (const bundle of bundles.slice(0, limit)) {
        try {
          summaries.push(await this.bundleSummary(bundle, runtime))
        } catch (error) {
          // One broken bundle must not blank the whole page.
          summaries.push(this.brokenSummary(bundle, runtime, errorText(error)))
        }
      }
      return {
        runtimeVersion: runtime.version || '',
        runtimeSource: runtime.source || 'unknown',
        profile: this.profileName,
        checkedAt: Date.now(),
        settings: await this.settingsView(),
        bundles: summaries,
      }
    } catch (error) {
      return {
        runtimeVersion: '',
        runtimeSource: 'unknown',
        profile: this.profileName,
        checkedAt: Date.now(),
        settings: { ...DEFAULTS, tokenConfigured: false },
        bundles: [],
        error: errorText(error),
      }
    }
  }

  // ── Remote: inspect ──────────────────────────────────────────────────────

  /**
   * Run (or reuse a fresh cache of) the four-layer inspection for one bundle.
   * @param {string} name package name
   * @returns {Promise<{ok:true, report:object}|{ok:false, error:string}>}
   */
  async inspect(name) {
    try {
      const report = await this.inspectOne(name)
      if (!report) return { ok: false, error: `Unknown plugin: ${String(name || '')}` }
      return { ok: true, report }
    } catch (error) {
      return { ok: false, error: errorText(error) }
    }
  }

  // ── Remote: nudge ────────────────────────────────────────────────────────

  /**
   * Prepare or file an update request for one plugin.
   * @param {string} name package name
   * @param {string} mode 'draft' | 'auto'
   * @returns {Promise<{ok:true, outcome:string, url:string|null, number:number|null, message:string}|{ok:false, error:string}>}
   */
  async nudge(name, mode) {
    try {
      const requested = mode === 'auto' ? 'auto' : 'draft'
      const report = await this.inspectOne(name)
      if (!report) return { ok: false, error: `Unknown plugin: ${String(name || '')}` }
      const settings = this.settingsSnapshot

      // Gate 1: only red is nudge-eligible (docs/API-CONTRACT.md §Grading).
      if (report.grade !== 'red') {
        return {
          ok: true,
          outcome: 'blocked',
          url: null,
          number: null,
          message: `Grade is ${report.grade}; only plugins graded red can file an update request.`,
        }
      }

      // Gate 2: a public GitHub repository must be known.
      const address = splitRepo(report.repo)
      if (!address) {
        return {
          ok: true,
          outcome: 'blocked',
          url: null,
          number: null,
          message: 'The plugin declares no GitHub repository, so no issue can be addressed to its maintainers.',
        }
      }

      // Gate 3: dedupe window.
      if (report.dedupe && report.dedupe.duplicate) {
        return {
          ok: true,
          outcome: 'duplicate',
          url: null,
          number: null,
          message: 'The same incompatibility was already reported for this plugin; the dedupe window is still open.',
        }
      }

      // Gate 4: daily cap, only for real submissions.
      if (requested === 'auto') {
        const cap = this.store.countIssuesToday(Date.now(), settings.maxIssuesPerDay)
        if (!cap.allowed) {
          return {
            ok: true,
            outcome: 'blocked',
            url: null,
            number: null,
            message: `Daily issue limit reached (${cap.count}/${cap.cap}); a draft can still be prepared through the draft flow.`,
          }
        }
      }

      const issue = buildIssue(report, { dshVersion: report.runtimeVersion })
      const url = draftUrl(address.owner, address.repo, issue)
      if (!url) {
        return {
          ok: true,
          outcome: 'blocked',
          url: null,
          number: null,
          message: 'The resolved repository is not a usable GitHub owner/repo pair.',
        }
      }

      const wantsAuto = requested === 'auto' && settings.autoNudge === true && settings.draftOnly === false
      const token = wantsAuto ? await this.readToken() : ''

      if (wantsAuto && token) {
        const result = await fileIssue({ owner: address.owner, repo: address.repo, issue, token })
        if (result.ok) {
          this.record(report, 'auto', 'filed', result.url, result.number)
          return {
            ok: true,
            outcome: 'filed',
            url: result.url,
            number: result.number,
            message: result.message || `Issue filed for ${report.name}@${report.version}.`,
          }
        }
        // Network, auth, or permission trouble: keep the draft so the user can act.
        this.record(report, 'auto', 'drafted', url, null)
        return {
          ok: true,
          outcome: 'drafted',
          url,
          number: null,
          message: `${result.message} A draft link was prepared instead.`,
        }
      }

      this.record(report, 'draft', 'drafted', url, null)
      const why = requested === 'auto'
        ? (settings.draftOnly === true
            ? ' Automatic filing is disabled (draft-only mode), so a draft was prepared.'
            : (settings.autoNudge !== true
                ? ' Automatic filing is disabled, so a draft was prepared.'
                : ' No GitHub token is configured, so a draft was prepared.'))
        : ''
      return {
        ok: true,
        outcome: 'drafted',
        url,
        number: null,
        message: `Draft prepared for ${report.name}@${report.version}.${why}`,
      }
    } catch (error) {
      return { ok: false, error: errorText(error) }
    }
  }

  // ── Remote: settings ─────────────────────────────────────────────────────

  /** @returns {Promise<object>} SettingsView (plain) */
  async settings() {
    try {
      return await this.settingsView()
    } catch {
      return { ...DEFAULTS, tokenRef: TOKEN_REF, tokenConfigured: false }
    }
  }

  /**
   * Merge writable fields into the profile row through ctx.settings.update.
   * @param {object} patch partial of WRITABLE_FIELDS
   * @returns {Promise<{ok:true, settings:object}|{ok:false, error:string}>}
   */
  async saveSettings(patch) {
    try {
      const clean = normalisePatch(patch)
      if (Object.keys(clean).length === 0) {
        return { ok: false, error: 'No writable field was supplied.' }
      }
      const { settings } = this.services()
      if (!settings) {
        return { ok: false, error: 'The Settings service is not available in this composition.' }
      }
      if (!this.entryId) {
        return { ok: false, error: 'This plugin row is not addressable through the profile patch.' }
      }
      if (typeof settings.update !== 'function') {
        return { ok: false, error: 'The Settings service cannot write this profile row.' }
      }
      await settings.update(this.entryId, clean)
      // settings.update writes volatile values in place and emits
      // loader/volatile-update; readConfig() re-`get()`s, so the view below
      // already reflects the new values.
      return { ok: true, settings: await this.settingsView() }
    } catch (error) {
      return { ok: false, error: errorText(error) }
    }
  }

  // ── Remote: setToken ─────────────────────────────────────────────────────

  /**
   * Store (or clear, with '') the GitHub PAT.
   * @param {string} token
   * @returns {Promise<{ok:true, tokenConfigured:boolean}|{ok:false, error:string}>}
   */
  async setToken(token) {
    try {
      const value = typeof token === 'string' ? token.trim() : ''
      const { credentials } = this.services()
      if (!credentials) {
        return { ok: false, error: 'The Credentials service is not available in this composition.' }
      }
      const { credentialRef } = await loadCredentialsApi()
      const ref = credentialRef(this.settingsSnapshot.tokenRef || TOKEN_REF)
      if (!value) {
        if (typeof credentials.unset === 'function') await credentials.unset(ref)
        return { ok: true, tokenConfigured: false }
      }
      if (typeof credentials.set !== 'function') {
        return { ok: false, error: 'The Credentials service cannot store values in this composition.' }
      }
      await credentials.set(ref, value)
      return { ok: true, tokenConfigured: true }
    } catch (error) {
      return { ok: false, error: errorText(error) }
    }
  }

  // ── Remote: history ──────────────────────────────────────────────────────

  /** @returns {Promise<{entries:object[]}>} newest first, capped at 100 */
  async history() {
    try {
      return { entries: this.store.history(100) }
    } catch {
      return { entries: [] }
    }
  }

  // ── internals ────────────────────────────────────────────────────────────

  /** Third-party (non-official) bundles from the plugin manager. */
  async thirdPartyBundles() {
    const { pluginManager } = this.services()
    if (!pluginManager || typeof pluginManager.listBundles !== 'function') return []
    let bundles = []
    try {
      bundles = await pluginManager.listBundles()
    } catch {
      return []
    }
    if (!Array.isArray(bundles)) return []
    // Third-party means: not an official @deepseek-ai package and not supplied by
    // the installation itself. Base/web-app rows are profile dependencies but are
    // installation-provided, and their `official` flag can be false.
    return bundles.filter((bundle) => {
      if (!bundle || typeof bundle.name !== 'string') return false
      if (bundle.official === true) return false
      if (bundle.name.startsWith('@deepseek-ai/')) return false
      if (bundle.availability === 'installation') return false
      return true
    })
  }

  /** Loader rows, bundle error, and exemption records for one package. */
  async admissionFor(bundleName) {
    const { pluginManager } = this.services()
    const admission = { rows: [], bundleError: null, readOnlyReason: undefined, exempted: undefined }
    if (!pluginManager) return admission
    let bundles = []
    let plugins = []
    try { bundles = await pluginManager.listBundles() } catch { bundles = [] }
    try { plugins = await pluginManager.listPlugins() } catch { plugins = [] }
    const bundle = Array.isArray(bundles) ? bundles.find((item) => item && item.name === bundleName) : null
    if (bundle) {
      if (bundle.error) admission.bundleError = bundle.error
      if (bundle.readOnlyReason) admission.readOnlyReason = bundle.readOnlyReason
      const rowIds = new Set()
      const moduleNames = new Set([bundleName])
      for (const row of Array.isArray(bundle.rows) ? bundle.rows : []) {
        if (row && row.rowId) rowIds.add(row.rowId)
        if (row && row.moduleName) moduleNames.add(row.moduleName)
      }
      for (const plugin of Array.isArray(plugins) ? plugins : []) {
        if (!plugin) continue
        if (!rowIds.has(plugin.entryId) && !moduleNames.has(plugin.moduleName)) continue
        admission.rows.push({
          rowId: String(plugin.entryId || ''),
          moduleName: String(plugin.moduleName || ''),
          fiberPhase: plugin.fiberPhase ?? null,
          enabled: plugin.enabled !== false,
        })
      }
    }
    if (typeof pluginManager.listVersionExemptions === 'function') {
      try {
        const exemptions = await pluginManager.listVersionExemptions()
        if (exemptions && exemptions.exemptions) admission.exempted = exemptions.exemptions
      } catch { /* exemptions are optional evidence */ }
    }
    return admission
  }

  /** Composed browser module graph ids, or undefined when unavailable. */
  async clientGraphIds() {
    const { clientModules } = this.services()
    if (!clientModules || typeof clientModules.graph !== 'function') return undefined
    try {
      const graph = clientModules.graph()
      const entries = graph && Array.isArray(graph.entries) ? graph.entries : []
      const ids = entries.map((entry) => entry && entry.id).filter((id) => typeof id === 'string')
      return ids.length ? ids : undefined
    } catch {
      return undefined
    }
  }

  /** Live Cordis service keys, or undefined when the registry is unreachable. */
  serviceKeys() {
    try {
      const registry = this.ctx && this.ctx.registry
      if (!registry) return undefined
      if (typeof registry.keys === 'object' && registry.keys !== null) return [...registry.keys()]
      if (typeof registry.forEach === 'function') {
        const keys = []
        registry.forEach((_value, key) => keys.push(key))
        return keys.length ? keys : undefined
      }
    } catch {
      /* fall through */
    }
    return undefined
  }

  /**
   * Whether the running composition provides one service.
   *
   * Uses the documented optional-service access (`ctx.get`) instead of reading
   * Cordis registry internals: the registry layout is not a public contract and
   * a wrong read makes every plugin look broken.
   *
   * @param {string} key service name
   * @returns {boolean}
   */
  hasService(key) {
    if (!key) return false
    try {
      return this.ctx.get(key) !== undefined
    } catch {
      return false
    }
  }

  /** Inspect one package, caching the Report briefly and attaching dedupe state. */
  async inspectOne(name) {
    const packageName = typeof name === 'string' ? name.trim() : ''
    if (!packageName) return null
    const cached = this.store.cachedReport(packageName, REPORT_TTL_MS)
    if (cached) return this.attachDedupe(cached)
    const bundles = await this.thirdPartyBundles()
    const bundle = bundles.find((item) => item && item.name === packageName)
    if (!bundle) return null
    const report = await this.runInspection(bundle, await this.runtime())
    this.store.cacheReport(report)
    return this.attachDedupe(report)
  }

  /** The actual four-layer run for one bundle descriptor. */
  async runInspection(bundle, runtime) {
    const name = String(bundle.name)
    const admission = await this.admissionFor(name)
    // `bundle.source` is a pnpm spec (a git address or a range), not a directory.
    // Resolve the installed package directory through the profile's resolution;
    // a linked install resolves to the real workspace path.
    let dir = resolvePackageDir(name, this.profileDir)
    if (!dir && typeof bundle.source === 'string' && path.isAbsolute(bundle.source)) {
      dir = bundle.source
    }
    return inspectBundle({
      pkg: { name, version: String(bundle.version || ''), dir },
      runtime,
      admission,
      clientGraph: await this.clientGraphIds(),
      serviceKeys: this.serviceKeys(),
      hasService: (key) => this.hasService(key),
      config: this.settingsSnapshot,
      profileDir: this.profileDir,
      loaders: {
        repo: (manifest) => resolveRepoFor(name, manifest, this.settingsSnapshot.repoOverrides),
      },
    })
  }

  /** Overlay the persisted dedupe decision onto a Report. */
  attachDedupe(report) {
    if (!report) return report
    if (!report.repo) return { ...report, eligible: false }
    const dedupe = this.store.dedupeFor(
      report.repo, report.name, report.signature, this.settingsSnapshot.renudgeAfterDays,
    )
    return {
      ...report,
      eligible: report.grade === 'red',
      dedupe: { ...dedupe, key: dedupe.key || report.signature },
    }
  }

  /** Persist one nudge attempt. */
  record(report, mode, outcome, url, number) {
    try {
      this.store.recordNudge({
        package: report.name,
        version: report.version,
        runtimeVersion: report.runtimeVersion,
        repo: report.repo,
        signature: report.signature,
        mode,
        outcome,
        url,
        number,
      })
    } catch { /* history is best-effort; the outcome is already known */ }
  }

  /** SettingsView (docs/API-CONTRACT.md). */
  async settingsView() {
    const settings = this.settingsSnapshot
    return {
      autoNudge: settings.autoNudge === true,
      draftOnly: settings.draftOnly !== false,
      renudgeAfterDays: Number(settings.renudgeAfterDays) || DEFAULTS.renudgeAfterDays,
      maxIssuesPerDay: Number(settings.maxIssuesPerDay) || DEFAULTS.maxIssuesPerDay,
      runtimeVersionOverride: String(settings.runtimeVersionOverride || ''),
      tokenRef: String(settings.tokenRef || TOKEN_REF),
      tokenConfigured: await this.tokenConfigured(),
      repoOverrides: { ...(settings.repoOverrides || {}) },
    }
  }

  /** Whether a PAT is currently stored (never returns the value). */
  async tokenConfigured() {
    const { credentials } = this.services()
    if (!credentials) return false
    try {
      const { credentialRef } = await loadCredentialsApi()
      const ref = credentialRef(this.settingsSnapshot.tokenRef || TOKEN_REF)
      if (typeof credentials.describe === 'function') {
        const info = await credentials.describe(ref)
        if (info && typeof info === 'object') {
          if (typeof info.configured === 'boolean') return info.configured
          if (typeof info.set === 'boolean') return info.set
          if (typeof info.present === 'boolean') return info.present
        }
        if (info === undefined || info === null) return false
      }
      if (typeof credentials.resolve === 'function') {
        const resolved = await credentials.resolve(ref)
        return resolved !== undefined && resolved !== null
      }
    } catch {
      return false
    }
    return false
  }

  /** Read the PAT for one filing attempt; '' when absent. */
  async readToken() {
    const { credentials } = this.services()
    if (!credentials || typeof credentials.resolve !== 'function') return ''
    try {
      const { credentialRef } = await loadCredentialsApi()
      const ref = credentialRef(this.settingsSnapshot.tokenRef || TOKEN_REF)
      const resolved = await credentials.resolve(ref)
      if (typeof resolved === 'string') return resolved
      if (resolved && typeof resolved.value === 'string') return resolved.value
      if (resolved && typeof resolved.secret === 'string') return resolved.secret
    } catch {
      return ''
    }
    return ''
  }

  /** One row for overview(). */
  async bundleSummary(bundle, runtime) {
    const name = String(bundle.name)
    let report = this.store.cachedReport(name, REPORT_TTL_MS)
    if (!report) {
      report = await this.runInspection(bundle, runtime)
      this.store.cacheReport(report)
    }
    report = this.attachDedupe(report)
    const findings = Array.isArray(report.findings) ? report.findings : []
    const latest = this.latestNudge(name)
    return {
      name,
      version: String(bundle.version || ''),
      title: titleOfBundle(bundle) || name,
      description: descriptionOfBundle(bundle),
      official: false,
      enabled: bundle.enabled !== false,
      availability: bundle.availability || 'profile',
      repo: report.repo,
      grade: report.grade,
      lastCheckedAt: report.checkedAt,
      stale: Date.now() - report.checkedAt > REPORT_TTL_MS,
      counts: {
        fail: findings.filter((item) => item.severity === 'fail').length,
        warn: findings.filter((item) => item.severity === 'warn').length,
      },
      eligible: report.grade === 'red' && Boolean(report.repo),
      nudge: {
        state: latest ? latest.outcome : (report.dedupe && report.dedupe.duplicate ? 'drafted' : 'none'),
        url: latest ? latest.url : null,
        at: latest ? latest.at : null,
      },
    }
  }

  /** Summary row used when one bundle's inspection itself failed. */
  brokenSummary(bundle, runtime, message) {
    return {
      name: String(bundle.name),
      version: String(bundle.version || ''),
      title: titleOfBundle(bundle) || String(bundle.name),
      description: descriptionOfBundle(bundle),
      official: false,
      enabled: bundle.enabled !== false,
      availability: bundle.availability || 'profile',
      repo: null,
      grade: 'unknown',
      lastCheckedAt: null,
      stale: true,
      counts: { fail: 0, warn: 0 },
      eligible: false,
      nudge: { state: 'none', url: null, at: null },
      error: String(message || ''),
    }
  }

  latestNudge(name) {
    try {
      return this.store.history(100).find((entry) => entry && entry.package === name) || null
    } catch {
      return null
    }
  }
}

/** Walk up the fiber chain for this plugin's loader row id. */
function locateEntryId(ctx) {
  try {
    let fiber = ctx && ctx.fiber
    let guard = 0
    while (fiber && guard++ < 16) {
      if (fiber.entry && fiber.entry.options && fiber.entry.options.id) return fiber.entry.options.id
      const next = fiber.parent && fiber.parent.fiber
      if (!next || next === fiber) break
      fiber = next
    }
  } catch {
    /* unaddressable */
  }
  return undefined
}

/** Split 'owner/repo' into parts, or null. */
function splitRepo(repo) {
  if (typeof repo !== 'string') return null
  const [owner, name] = repo.trim().split('/')
  if (!owner || !name) return null
  return { owner, repo: name }
}

function localisedText(value) {
  if (typeof value === 'string') return value
  if (value && typeof value === 'object') {
    if (typeof value.en === 'string') return value.en
    const first = Object.values(value).find((item) => typeof item === 'string')
    if (first) return first
  }
  return ''
}

function titleOfBundle(bundle) {
  return localisedText(bundle && bundle.meta ? bundle.meta.title : undefined)
}

function descriptionOfBundle(bundle) {
  const fromMeta = localisedText(bundle && bundle.meta ? bundle.meta.description : undefined)
  if (fromMeta) return fromMeta
  return typeof bundle.description === 'string' ? bundle.description : ''
}

/** Keep only writable fields with the right runtime type. */
export function normalisePatch(patch) {
  const source = patch && typeof patch === 'object' && !Array.isArray(patch) ? patch : {}
  const out = {}
  for (const key of WRITABLE_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(source, key)) continue
    const value = source[key]
    if (key === 'autoNudge' || key === 'draftOnly') {
      if (typeof value === 'boolean') out[key] = value
      continue
    }
    if (key === 'renudgeAfterDays' || key === 'maxIssuesPerDay') {
      const number = Number(value)
      if (Number.isFinite(number) && number >= 1) out[key] = Math.floor(number)
      continue
    }
    if (key === 'repoOverrides') {
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        const clean = {}
        for (const [name, repo] of Object.entries(value)) {
          if (typeof name === 'string' && typeof repo === 'string' && repo.trim()) clean[name] = repo.trim()
        }
        out[key] = clean
      }
      continue
    }
    if (typeof value === 'string') out[key] = value.trim()
  }
  return out
}

/**
 * `credentialRef` lives in @deepseek-ai/dsh-credentials, which a plain Node
 * process cannot resolve from the profile directory (the runtime supplies it by
 * module fallback). Load it lazily and fall back to the identity function: a
 * plain string ref is valid for the local credential store, and the runtime's
 * copy understands it.
 */
let credentialsApi = null
async function loadCredentialsApi() {
  if (credentialsApi) return credentialsApi
  try {
    const mod = await import('@deepseek-ai/dsh-credentials')
    const ref = mod && (mod.credentialRef ?? (mod.default && mod.default.credentialRef))
    credentialsApi = { credentialRef: typeof ref === 'function' ? ref : identityRef }
  } catch {
    credentialsApi = { credentialRef: identityRef }
  }
  return credentialsApi
}

function identityRef(name) {
  return name
}

registerRemoteMethods(JunpengJiaService, REMOTE_METHOD_NAMES)

export {
  JunpengJiaService as Service,
  JunpengJiaService as JunpengJiaService,
  okValue,
  failValue,
  failure,
}
export default JunpengJiaService
