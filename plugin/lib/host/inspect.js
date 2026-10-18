// The four-layer compatibility engine.
//
// Contract for the grade (docs/BLUEPRINT.md §2.1, docs/API-CONTRACT.md §Grading):
//
//   Factor A — the plugin's own claims: manifest (L1) + resolution (L2) + symbols (L3).
//   Factor B — DSH's admission decision: version-exemption records, the unmet
//              requirement the runtime refuses, and the Loader's real activation state.
//
//   A fails && B fails -> red      (the only nudge-eligible grade)
//   exactly one side bad -> yellow
//   neither              -> green
//   no runtime version   -> unknown (and never auto-filed)
//
// Admission semantics mirror @deepseek-ai/dsh-app-boot, which is what the running
// process actually enforces:
//   * `engines.dsh`, when it is present, ALONE decides — peerDependencies are not
//     admission inputs in that case.
//   * With no `engines.dsh`, every peer on `@deepseek-ai/dsh` / `@deepseek-ai/dsh-*`
//     must resolve and match. Peers on other packages (cordis, schemastery, ...) are
//     informative only and never fail the plugin.
//   * An empty or invalid `engines.dsh` is incompatible.
//   * Prereleases participate in range matching (see host/semver.js).
//   * A plain `disabled` row is a user choice, not a compatibility failure.
//
// Everything here is read-only: manifests, entry-file text, and live service
// tables. No third-party plugin code is imported or executed.

import { readFileSync } from 'node:fs'
import path from 'node:path'

import { CODES, INSPECT_BUDGET_MS, LAYERS, SERVICE_KEY } from '../contract.js'
import { satisfies, validRange, isWildcardRange } from './semver.js'
import { resolveRuntimeVersion, resolveInstalledVersion } from './runtime.js'
import { signatureOf } from './store.js'

const LAYER_LABELS = {
  manifest: 'Manifest',
  resolution: 'Dependency resolution',
  symbols: 'Runtime symbols',
  activation: 'Activation',
}

const PEER_PREFIX = '@deepseek-ai/dsh'

function finding(code, layer, severity, message, extra = {}) {
  const out = { code, layer, severity, message: String(message || '') }
  if (extra.expected !== undefined && extra.expected !== null) out.expected = String(extra.expected)
  if (extra.actual !== undefined && extra.actual !== null) out.actual = String(extra.actual)
  if (extra.hint) out.hint = String(extra.hint)
  return out
}

function layerOf(id, findings) {
  let status = 'pass'
  if (findings.some((item) => item.severity === 'fail')) status = 'fail'
  else if (findings.some((item) => item.severity === 'warn')) status = 'warn'
  return { id, label: LAYER_LABELS[id] || id, status, findings }
}

function skippedLayer(id, reason) {
  return { id, label: LAYER_LABELS[id] || id, status: 'skip', findings: [] , note: reason }
}

function list(value) {
  if (value instanceof Set) return [...value]
  if (value instanceof Map) return [...value.keys()]
  if (Array.isArray(value)) return value
  return []
}

function asSet(value) {
  if (value instanceof Set) return value
  // A Map's iterator yields [key, value] pairs, so unwrap its keys explicitly.
  if (value instanceof Map) return new Set(value.keys())
  if (Array.isArray(value)) return new Set(value)
  return new Set()
}

// ── pure helpers (unit-tested directly) ─────────────────────────────────────

/**
 * Statically extract the service keys of `export const inject = [...]` from an
 * entry file's text. Never evaluates the module.
 *
 * @param {string} sourceText
 * @returns {string[]|null} `null` means "the entry declares no inject at all",
 *   which is distinct from `[]` ("declares an empty inject"). Callers use that
 *   difference to decide between "nothing to verify" and "verified empty".
 */
export function extractInjectSymbols(sourceText) {
  if (typeof sourceText !== 'string' || !sourceText) return null
  const declaration = /export\s+(?:const|let|var)\s+inject\s*=\s*\[([^\]]*)\]/.exec(sourceText)
  if (!declaration) return null
  const keys = []
  const stringRe = /['"`]([^'"`]+)['"`]/g
  let match
  while ((match = stringRe.exec(declaration[1])) !== null) {
    const key = match[1].trim()
    if (key && !keys.includes(key)) keys.push(key)
  }
  return keys
}

/**
 * Which injected keys are absent from the live service table.
 * Accepts an array, a Set, or a Map (whose keys are the service names).
 * @param {Iterable<string>} injectKeys
 * @param {Iterable<string>|Map<string, unknown>} availableKeys
 * @returns {string[]}
 */
export function missingSymbols(injectKeys, availableKeys) {
  const available = asSet(availableKeys)
  return list(injectKeys).map(String).filter((key) => key && !available.has(key))
}

/**
 * The grading table (docs/API-CONTRACT.md §Grading, docs/BLUEPRINT.md §2.1).
 *
 *   both sides pass                  -> green
 *   exactly one side non-pass        -> yellow
 *   both sides have a hard failure   -> red   (the only nudge-eligible grade)
 *   runtime version unknown          -> unknown
 *
 * `warn` never promotes a grade to red: a warning on one side while the other
 * side merely warns is still yellow, not a nudge trigger.
 *
 * @param {{status?:string}} factorA
 * @param {{status?:string}} factorB
 * @param {string} runtimeVersion
 * @returns {'green'|'yellow'|'red'|'unknown'}
 */
export function computeGrade(factorA, factorB, runtimeVersion) {
  if (!runtimeVersion) return 'unknown'
  const a = factorA && factorA.status ? factorA.status : 'pass'
  const b = factorB && factorB.status ? factorB.status : 'pass'
  if (a === 'fail' && b === 'fail') return 'red'
  if (a !== 'pass' || b !== 'pass') return 'yellow'
  return 'green'
}

/** Summarise one side of the dual-factor verdict. */
export function sideVerdict(status, reasons) {
  return { status: status || 'pass', reasons: list(reasons).map(String).filter(Boolean) }
}

function statusOfFindings(findings) {
  if (findings.some((item) => item.severity === 'fail')) return 'fail'
  if (findings.some((item) => item.severity === 'warn')) return 'warn'
  return 'pass'
}

// ── manifest / admission analysis ───────────────────────────────────────────

function peerDependenciesOf(manifest) {
  const peers = manifest && typeof manifest.peerDependencies === 'object' && manifest.peerDependencies
    ? manifest.peerDependencies
    : {}
  return Object.entries(peers).filter(([name, range]) => typeof name === 'string' && typeof range === 'string')
}

function dshPeers(manifest) {
  return peerDependenciesOf(manifest).filter(([name]) => name === PEER_PREFIX || name.startsWith(`${PEER_PREFIX}-`))
}

function otherPeers(manifest) {
  return peerDependenciesOf(manifest).filter(([name]) => name !== PEER_PREFIX && !name.startsWith(`${PEER_PREFIX}-`))
}

/**
 * What the plugin declares as its runtime requirement, in DSH's own terms.
 *
 * @returns {{
 *   mode: 'engines'|'peers'|'none',
 *   range: string,
 *   requirements: Record<string,string>,
 * } | null} null when the manifest declares nothing at all
 */
export function declaredRequirements(manifest) {
  const engines = manifest && manifest.engines && typeof manifest.engines === 'object' ? manifest.engines : {}
  const enginesDsh = typeof engines.dsh === 'string' ? engines.dsh.trim() : undefined
  if (enginesDsh !== undefined) {
    return { mode: 'engines', range: enginesDsh, requirements: { 'engines.dsh': enginesDsh } }
  }
  const peers = dshPeers(manifest)
  if (peers.length) {
    const requirements = {}
    for (const [name, range] of peers) requirements[name] = range
    return { mode: 'peers', range: '', requirements }
  }
  return null
}

/** Read a package.json from disk without throwing. */
export function readManifest(dir) {
  if (typeof dir !== 'string' || !dir) return null
  try {
    const file = path.join(dir, 'package.json')
    const manifest = JSON.parse(readFileSync(file, 'utf8'))
    return manifest && typeof manifest === 'object' ? manifest : null
  } catch {
    return null
  }
}

/** Locate and read the entry file text; '' when it cannot be read. */
export function readEntrySource(dir, manifest) {
  if (typeof dir !== 'string' || !dir || !manifest) return ''
  const candidates = []
  const main = typeof manifest.main === 'string' ? manifest.main : ''
  if (main) candidates.push(main)
  candidates.push('lib/index.js', 'index.js', 'dist/index.js', 'lib/index.mjs', 'index.mjs')
  for (const candidate of candidates) {
    try {
      return readFileSync(path.join(dir, candidate), 'utf8')
    } catch {
      continue
    }
  }
  return ''
}

function manifestFindings(manifest, runtimeVersion, resolves) {
  const findings = []
  if (!manifest) {
    findings.push(finding(CODES.manifestUnreadable, 'manifest', 'fail',
      'The plugin has no readable package.json, so no compatibility claim can be checked.'))
    return findings
  }

  const declared = declaredRequirements(manifest)

  // L1a: engines.dsh decides alone when present.
  const engines = manifest.engines && typeof manifest.engines === 'object' ? manifest.engines : {}
  const enginesDsh = typeof engines.dsh === 'string' ? engines.dsh.trim() : undefined

  if (enginesDsh === undefined) {
    const peerCount = dshPeers(manifest).length
    if (peerCount === 0) {
      findings.push(finding(CODES.manifestEnginesMissing, 'manifest', 'info',
        'The manifest declares neither engines.dsh nor any @deepseek-ai/dsh peer, so it imposes no version requirement.',
        { expected: 'engines.dsh or an @deepseek-ai/dsh* peer range', actual: 'none' }))
    }
  } else if (enginesDsh === '' || !validRange(enginesDsh)) {
    findings.push(finding(CODES.manifestEnginesUnsatisfied, 'manifest', 'fail',
      enginesDsh === ''
        ? 'engines.dsh is empty; an empty range is treated as incompatible by the runtime.'
        : `engines.dsh is not a valid semver range: ${JSON.stringify(enginesDsh)}.`,
      { expected: 'a valid semver range such as >=0.2.0-rc.1 <0.3.0-0', actual: JSON.stringify(enginesDsh) }))
  } else if (runtimeVersion && !isWildcardRange(enginesDsh) && !satisfies(runtimeVersion, enginesDsh)) {
    findings.push(finding(CODES.manifestEnginesUnsatisfied, 'manifest', 'fail',
      `engines.dsh does not admit the running DeepSeek Harness ${runtimeVersion}.`,
      { expected: enginesDsh, actual: runtimeVersion }))
  }

  // L1b: peers. Their admission weight depends on whether engines.dsh is present.
  for (const [name, range] of peerDependenciesOf(manifest)) {
    const isDshPeer = name === PEER_PREFIX || name.startsWith(`${PEER_PREFIX}-`)
    const resolved = resolves instanceof Map ? resolves.get(name) : undefined
    const resolvedVersion = resolved && resolved.version ? resolved.version : ''
    if (!isDshPeer) {
      // Not an admission input for DSH; only worth a line when it actually disagrees.
      if (resolvedVersion && !isWildcardRange(range) && !satisfies(resolvedVersion, range)) {
        findings.push(finding(CODES.manifestPeerUnsatisfied, 'manifest', 'info',
          `Peer ${name} ${range} differs from the resolved ${resolvedVersion}; it is not a DSH admission input, so this is informational.`,
          { expected: range, actual: resolvedVersion }))
      }
      continue
    }
    if (declared && declared.mode === 'engines') {
      // engines.dsh decides; a peer mismatch is evidence, never a hard failure.
      if (resolvedVersion && !isWildcardRange(range) && !satisfies(resolvedVersion, range)) {
        findings.push(finding(CODES.manifestPeerUnsatisfied, 'manifest', 'warn',
          `Peer ${name} ${range} does not match the resolved ${resolvedVersion}; engines.dsh still decides admission.`,
          { expected: range, actual: resolvedVersion }))
      }
    }
  }

  // L1c: bundle patch declaration.
  const dsh = manifest.dsh && typeof manifest.dsh === 'object' ? manifest.dsh : {}
  const bundle = dsh.bundle && typeof dsh.bundle === 'object' ? dsh.bundle : null
  if (bundle && (typeof bundle.patch !== 'string' || !bundle.patch.trim())) {
    findings.push(finding(CODES.manifestBundlePatchMissing, 'manifest', 'fail',
      'dsh.bundle is declared without a patch file, so the bundle cannot mount any row.',
      { expected: 'dsh.bundle.patch pointing at a yml file', actual: JSON.stringify(bundle) }))
  }

  // L1d: client declaration shape.
  const client = dsh.client && typeof dsh.client === 'object' ? dsh.client : null
  if (client) {
    const platform = client.platform
    if (typeof platform !== 'string' || !platform.trim()) {
      findings.push(finding(CODES.manifestClientPlatform, 'manifest', 'warn',
        'dsh.client is declared without a platform; the browser half may never load.',
        { expected: 'web', actual: String(platform) }))
    } else if (platform !== 'web') {
      findings.push(finding(CODES.manifestClientPlatform, 'manifest', 'fail',
        `dsh.client.platform is ${JSON.stringify(platform)}, which this Harness does not serve.`,
        { expected: 'web', actual: platform }))
    }
    if (client.inject !== undefined && !Array.isArray(client.inject)) {
      findings.push(finding(CODES.manifestClientInjectMissing, 'manifest', 'fail',
        'dsh.client.inject must be an array of browser module ids.',
        { expected: 'string[]', actual: typeof client.inject }))
    }
  }

  return findings
}

// ── resolution ──────────────────────────────────────────────────────────────

function resolutionFindings(manifest, runtimeVersion, resolves) {
  const findings = []
  if (!manifest) return { findings, probed: true }
  // `resolves` === null means "peer resolution was not probed". Reporting a
  // missing peer in that case would be a fabricated failure, so the layer is
  // marked skip instead.
  if (!(resolves instanceof Map)) return { findings, probed: false }
  const declared = declaredRequirements(manifest)
  const peers = peerDependenciesOf(manifest)
  if (!peers.length) return { findings, probed: true }

  for (const [name, range] of peers) {
    const isDshPeer = name === PEER_PREFIX || name.startsWith(`${PEER_PREFIX}-`)
    const resolved = resolves.get(name)
    const version = resolved && resolved.version ? resolved.version : ''
    if (!version) {
      // @deepseek-ai/dsh* packages are normally supplied by the Harness module
      // fallback, so absence from the profile is expected, not evidence of a
      // broken plugin. Version admission for them is factor B's job.
      findings.push(finding(CODES.manifestPeerMissing, 'resolution', isDshPeer ? 'warn' : 'info',
        isDshPeer
          ? `Peer ${name} ${range} is not present in the profile's node_modules; DSH supplies @deepseek-ai/dsh* from the running runtime, and version admission is judged separately.`
          : `Peer ${name} ${range} is not present in the profile's node_modules; the runtime composition may supply it.`,
        { expected: range, actual: 'not present in profile node_modules' }))
      continue
    }
    if (isWildcardRange(range)) continue
    if (!satisfies(version, range)) {
      // A resolvable copy shadows the fallback, so a real mismatch is a real
      // failure for DSH peers; for other packages it stays informational.
      findings.push(finding(CODES.manifestPeerUnsatisfied, 'resolution', isDshPeer ? 'fail' : 'info',
        `Peer ${name} resolves to ${version} in this profile, outside the declared ${range}.`,
        { expected: range, actual: version }))
    }
  }

  // With engines.dsh present, peer mismatches are only evidence (see L1b).
  if (declared && declared.mode === 'engines') {
    return {
      probed: true,
      findings: findings.map((item) => (item.severity === 'fail'
        ? { ...item, severity: 'warn', message: `${item.message} engines.dsh still decides admission.` }
        : item)),
    }
  }
  return { findings, probed: true }
}

// ── symbols ─────────────────────────────────────────────────────────────────

function symbolFindings(manifest, options) {
  const findings = []
  const skipped = []

  // Server-side inject vs. the live Cordis service table.
  const inject = options.injectSymbols
  const available = options.serviceKeys
  const hasService = typeof options.hasService === 'function' ? options.hasService : null
  if (inject === null || inject === undefined) {
    skipped.push('entry')
    findings.push(finding(CODES.symbolsInjectMissing, 'symbols', 'info',
      'No `export const inject = [...]` was found in the entry file; the service table was not verified.',
      { expected: 'a static inject declaration', actual: 'not found' }))
  } else if (hasService) {
    // The precise probe: ask the composition about each declared key through the
    // documented optional-service access, rather than reading registry internals.
    const missing = inject.map(String).filter((key) => key && !hasService(key))
    if (missing.length) {
      findings.push(finding(CODES.symbolsInjectUnknown, 'symbols', 'fail',
        `inject declares ${missing.length} service(s) the running composition does not provide.`,
        { expected: `services: ${inject.join(', ')}`, actual: `missing: ${missing.join(', ')}` }))
    }
  } else if (available) {
    const missing = missingSymbols(inject, available)
    if (missing.length) {
      findings.push(finding(CODES.symbolsInjectUnknown, 'symbols', 'fail',
        `inject declares ${missing.length} service(s) the running composition does not provide.`,
        { expected: `services: ${inject.join(', ')}`, actual: `missing: ${missing.join(', ')}` }))
    }
  } else {
    skipped.push('services')
  }

  // Browser-side runtime imports vs. the composed web graph.
  //
  // `dsh.client.inject` only ORDERS activation and may name baseline modules that
  // are not boot-graph entries, so validating it against the graph produces false
  // positives (the skill's own rule: inject entries "only order activation and stay
  // allowed"). `dsh.client.external` is the declaration that names real runtime
  // imports, so that is what must exist in the composed graph.
  const client = manifest && manifest.dsh && manifest.dsh.client && typeof manifest.dsh.client === 'object'
    ? manifest.dsh.client
    : null
  const clientExternal = client && Array.isArray(client.external)
    ? client.external.filter((id) => typeof id === 'string')
    : []
  const graph = options.clientGraph
  if (clientExternal.length) {
    if (!graph) {
      skipped.push('client')
    } else {
      const missing = missingSymbols(clientExternal, graph)
      if (missing.length) {
        findings.push(finding(CODES.manifestClientInjectMissing, 'symbols', 'fail',
          `dsh.client.external references ${missing.length} module(s) absent from the composed web graph.`,
          { expected: `modules: ${clientExternal.join(', ')}`, actual: `missing: ${missing.join(', ')}` }))
      }
    }
  }

  return { findings, skipped }
}

// ── activation (Loader truth) ───────────────────────────────────────────────

function activationFindings(admission) {
  const findings = []
  const rows = []

  if (admission) {
    for (const row of list(admission.rows)) {
      const entry = {
        rowId: String(row && row.rowId !== undefined ? row.rowId : ''),
        moduleName: String(row && row.moduleName !== undefined ? row.moduleName : ''),
        fiberPhase: row && row.fiberPhase !== undefined ? row.fiberPhase : null,
        enabled: row ? row.enabled !== false : true,
      }
      rows.push(entry)
      if (entry.fiberPhase === 'failed') {
        findings.push(finding(CODES.activationRowFailed, 'activation', 'fail',
          `Loader row ${entry.rowId || entry.moduleName} failed to activate.`,
          { expected: 'fiberPhase active', actual: 'failed' }))
      }
      if (entry.enabled === false) {
        // A user choice, never a compatibility failure.
        findings.push(finding(CODES.activationDisabled, 'activation', 'info',
          `Loader row ${entry.rowId || entry.moduleName} is disabled in this profile.`,
          { expected: 'enabled', actual: 'disabled' }))
      }
    }
  }

  const bundleError = admission && admission.bundleError
  if (bundleError) {
    const code = typeof bundleError === 'string' ? bundleError : (bundleError.code || 'unknown-plugin')
    const diagnostic = typeof bundleError === 'string' ? '' : (bundleError.diagnostic || '')
    findings.push(finding(CODES.activationBundleError, 'activation', 'fail',
      `The plugin manager reports ${code} for this bundle${diagnostic ? `: ${String(diagnostic).slice(0, 300)}` : ''}.`,
      { expected: 'applied', actual: code }))
  }

  if (admission && admission.readOnlyReason === 'unaddressable') {
    findings.push(finding(CODES.activationUnaddressable, 'activation', 'warn',
      'The bundle row cannot be addressed through the profile patch, so settings cannot be applied to it.',
      { expected: 'addressable', actual: 'unaddressable' }))
  }

  return { findings, rows }
}

// ── factor B (DSH admission) ────────────────────────────────────────────────

function admissionFindings(manifest, runtimeVersion, admission, identity) {
  const findings = []
  const reasons = []
  const declared = declaredRequirements(manifest)
  const exempted = admission ? admission.exempted : undefined
  const denied = admission && admission.denied === true
  const requirements = {}
  const id = packageId(identity)

  if (declared && runtimeVersion) {
    const unmet = []
    if (declared.mode === 'engines') {
      const range = declared.range
      if (!range || !validRange(range) || !satisfies(runtimeVersion, range)) {
        unmet.push(['engines.dsh', range])
      }
    } else if (declared.mode === 'peers') {
      // With no engines.dsh, every dsh peer range must match the runtime version.
      for (const [name, range] of Object.entries(declared.requirements)) {
        if (!range || !validRange(range) || !satisfies(runtimeVersion, range)) unmet.push([name, range])
      }
    }
    for (const [name, range] of unmet) {
      requirements[name] = range
      const exemptionApplies = exemptionCovers(exempted, id, runtimeVersion)
      if (exemptionApplies) {
        reasons.push(`${name} ${JSON.stringify(range)} is unmet at ${runtimeVersion} but an exact version exemption is recorded`)
        findings.push(finding(CODES.dshExempted, 'activation', 'warn',
          `The runtime admits ${id} on ${runtimeVersion} only because an explicit version exemption was granted.`,
          { expected: range, actual: runtimeVersion, hint: 'Granted at the user\'s own risk; re-test after the exemption is removed.' }))
      } else {
        reasons.push(`${name} ${JSON.stringify(range)} does not admit ${runtimeVersion}`)
        findings.push(finding(CODES.dshDenied, 'activation', 'fail',
          `DeepSeek Harness ${runtimeVersion} refuses this exact plugin version: ${name} requires ${JSON.stringify(range)}.`,
          { expected: range, actual: runtimeVersion }))
      }
    }
  }

  if (denied && findings.length === 0) {
    reasons.push('the plugin manager denied this plugin version')
    findings.push(finding(CODES.dshDenied, 'activation', 'fail',
      'The plugin manager reports an incompatible-version rejection for this bundle.',
      { expected: 'admitted', actual: 'incompatible-version' }))
  }

  // A row that cannot be addressed through the profile patch is admitted, but
  // only partially manageable: warn, never fail.
  if (admission && admission.readOnlyReason === 'unaddressable'
    && !findings.some((item) => item.code === CODES.activationUnaddressable)) {
    reasons.push('the bundle row is unaddressable through the profile patch')
    findings.push(finding(CODES.activationUnaddressable, 'activation', 'warn',
      'The bundle row cannot be addressed through the profile patch, so its settings cannot be applied.',
      { expected: 'addressable', actual: 'unaddressable' }))
  }

  // Loader evidence is admission evidence too: a row that failed to load is not
  // "compatible" no matter what the manifest claims.
  if (admission && admission.bundleError) reasons.push('the bundle carries a management error')
  for (const row of list(admission && admission.rows)) {
    if (row && row.fiberPhase === 'failed') reasons.push(`loader row ${row.rowId || row.moduleName} is in fiberPhase failed`)
  }

  return { findings, reasons, requirements }
}

function exemptionCovers(exempted, id, runtimeVersion) {
  if (!exempted || !runtimeVersion) return false
  if (Array.isArray(exempted)) return exempted.includes(runtimeVersion) || exempted.includes(id)
  if (exempted instanceof Set) return exempted.has(runtimeVersion) || exempted.has(id)
  if (typeof exempted === 'object') {
    const listed = exempted[id]
    if (Array.isArray(listed)) return listed.includes(runtimeVersion)
    if (listed instanceof Set) return listed.has(runtimeVersion)
  }
  return false
}

function packageId(source) {
  const name = source && typeof source.name === 'string' ? source.name : ''
  const version = source && typeof source.version === 'string' ? source.version : ''
  return `${name}@${version}`
}

// ── report assembly ─────────────────────────────────────────────────────────

function titleOf(manifest, fallback) {
  const meta = manifest && manifest.dsh && manifest.dsh.meta && typeof manifest.dsh.meta === 'object' ? manifest.dsh.meta : null
  const title = meta ? meta.title : undefined
  if (typeof title === 'string' && title.trim()) return title.trim()
  if (title && typeof title === 'object') {
    if (typeof title.en === 'string' && title.en.trim()) return title.en.trim()
    const first = Object.values(title).find((value) => typeof value === 'string' && value.trim())
    if (first) return first.trim()
  }
  return fallback
}

function repoOf(input) {
  if (typeof input === 'string' && input.trim()) return input.trim()
  if (input && typeof input === 'object') {
    if (typeof input.owner === 'string' && typeof input.repo === 'string') return `${input.owner}/${input.repo}`
    if (typeof input.url === 'string' && input.url.trim()) return input.url.trim()
  }
  return null
}

/**
 * Build a Report from facts already gathered. Pure and synchronous: no fs, no
 * services. This is the function the unit tests drive directly.
 *
 * @param {{
 *   pkg?: { name?: string, version?: string, manifest?: object|null, dir?: string },
 *   runtime?: { version?: string, source?: string },
 *   admission?: { rows?: object[], bundleError?: object|string, readOnlyReason?: string,
 *                 denied?: boolean, exempted?: string[]|Record<string,string[]> },
 *   clientGraph?: string[]|Set,
 *   serviceKeys?: string[]|Set,
 *   injectSymbols?: string[]|null,
 *   repo?: string|{owner:string,repo:string}|null,
 *   dedupe?: object,
 *   now?: number,
 *   budgetMs?: number,
 * }} [input]
 * @returns {object} Report
 */
export function inspectBundleSync(input = {}) {
  const started = Date.now()
  const pkg = input.pkg && typeof input.pkg === 'object' ? input.pkg : {}
  const manifest = pkg.manifest && typeof pkg.manifest === 'object' ? pkg.manifest : null
  const runtime = input.runtime && typeof input.runtime === 'object' ? input.runtime : {}
  const runtimeVersion = typeof runtime.version === 'string' ? runtime.version.trim() : ''
  const runtimeSource = typeof runtime.source === 'string' && runtime.source ? runtime.source : 'unknown'
  const budgetMs = Number.isFinite(input.budgetMs) && input.budgetMs > 0 ? input.budgetMs : INSPECT_BUDGET_MS
  const checkedAt = Number.isFinite(input.now) ? input.now : Date.now()

  const name = String(pkg.name || (manifest && manifest.name) || 'unknown-plugin')
  const version = String(pkg.version || (manifest && manifest.version) || '')
  const resolves = input.resolves instanceof Map ? input.resolves : null

  const budgetLeft = () => budgetMs - (Date.now() - started)

  // L1 manifest
  const manifestLayer = layerOf('manifest', manifestFindings(manifest, runtimeVersion, resolves))

  // L2 resolution
  let resolutionLayer
  if (budgetLeft() <= 0) {
    resolutionLayer = skippedLayer('resolution', 'inspection budget exhausted')
  } else {
    const resolution = resolutionFindings(manifest, runtimeVersion, resolves)
    resolutionLayer = resolution.probed
      ? layerOf('resolution', resolution.findings)
      : skippedLayer('resolution', 'peer resolution was not probed')
    if (!resolution.probed) resolutionLayer.findings = []
  }

  // L3 symbols
  let symbolsLayer
  if (budgetLeft() <= 0) {
    symbolsLayer = skippedLayer('symbols', 'inspection budget exhausted')
  } else {
    const symbols = symbolFindings(manifest, {
      injectSymbols: input.injectSymbols === undefined ? null : input.injectSymbols,
      serviceKeys: input.serviceKeys,
      hasService: input.hasService,
      clientGraph: input.clientGraph,
    })
    symbolsLayer = layerOf('symbols', symbols.findings)
    if (symbols.skipped.length) symbolsLayer.note = `skipped checks: ${symbols.skipped.join(', ')}`
  }

  // L4 activation
  const activation = activationFindings(input.admission)
  const activationLayer = budgetLeft() > 0
    ? layerOf('activation', activation.findings)
    : skippedLayer('activation', 'inspection budget exhausted')

  if (!runtimeVersion) {
    manifestLayer.findings.push(finding(CODES.dshRuntimeUnknown, 'manifest', 'warn',
      'The running DeepSeek Harness version could not be determined, so no version verdict is possible.'))
    manifestLayer.status = statusOfFindings(manifestLayer.findings)
  }

  const layers = [manifestLayer, resolutionLayer, symbolsLayer, activationLayer]
  const factorFindings = [...manifestLayer.findings, ...resolutionLayer.findings, ...symbolsLayer.findings]
  const factorAStatus = statusOfFindings(factorFindings)

  const admissionResult = admissionFindings(manifest, runtimeVersion, input.admission, { name, version })
  const bFindings = [...admissionResult.findings]
  // A row that failed to load is a DSH-admission failure too.
  const activationFailures = activation.findings.filter((item) => item.severity === 'fail')
  const factorBStatus = statusOfFindings([...bFindings, ...activationFailures])

  const bReasons = [...admissionResult.reasons]
  for (const item of activationFailures) {
    if (item.code === CODES.activationBundleError) bReasons.push(item.message)
    if (item.code === CODES.activationRowFailed) bReasons.push(item.message)
  }

  const factorA = sideVerdict(factorAStatus, factorFindings
    .filter((item) => item.severity === 'fail' || item.severity === 'warn')
    .map((item) => item.message))
  const factorB = sideVerdict(factorBStatus, bReasons)

  const grade = computeGrade(factorA, factorB, runtimeVersion)
  const repo = repoOf(input.repo)
  const eligible = grade === 'red' && Boolean(repo)

  // A missing or non-GitHub repository never affects the grade — it only
  // disables the nudge path — but the panel needs the reason to explain itself.
  if (!repo) {
    manifestLayer.findings.push(finding(CODES.repoMissing, 'manifest', 'info',
      'The plugin declares no GitHub repository, so no update request can be addressed.',
      { expected: 'repository.url on github.com', actual: 'none' }))
    manifestLayer.status = statusOfFindings(manifestLayer.findings)
  }

  const findings = [...layers.flatMap((layer) => layer.findings)]
  // Keep the DSH verdict findings visible too; they live on the activation layer.
  if (admissionResult.findings.length) {
    const activationLayerEntry = layers.find((layer) => layer.id === 'activation')
    if (activationLayerEntry) {
      for (const item of admissionResult.findings) {
        if (!activationLayerEntry.findings.some((existing) => existing.code === item.code && existing.message === item.message)) {
          activationLayerEntry.findings.push(item)
          findings.push(item)
        }
      }
      activationLayerEntry.status = statusOfFindings(activationLayerEntry.findings)
    }
  }

  const signature = signatureOf({
    package: name,
    version,
    runtimeVersion,
    findings,
    missingSymbols: symbolsLayer.status === 'fail'
      ? symbolsLayer.findings.map((item) => item.actual || '').filter(Boolean)
      : [],
  })

  const dedupe = input.dedupe && typeof input.dedupe === 'object'
    ? {
        key: String(input.dedupe.key || signature),
        lastNudgedAt: Number.isFinite(input.dedupe.lastNudgedAt) ? input.dedupe.lastNudgedAt : null,
        allowedAt: Number.isFinite(input.dedupe.allowedAt) ? input.dedupe.allowedAt : null,
        duplicate: input.dedupe.duplicate === true,
      }
    : { key: signature, lastNudgedAt: null, allowedAt: null, duplicate: false }

  return {
    name,
    version,
    title: titleOf(manifest, name),
    repo,
    runtimeVersion,
    runtimeSource,
    checkedAt,
    grade,
    eligible,
    factorA,
    factorB,
    layers,
    findings,
    activation: { rows: activation.rows, error: activationErrorText(input.admission) },
    requirements: admissionResult.requirements,
    signature,
    dedupe,
    elapsedMs: Date.now() - started,
  }
}

function activationErrorText(admission) {
  const error = admission && admission.bundleError
  if (!error) return null
  if (typeof error === 'string') return error
  const code = error.code || 'unknown-plugin'
  return error.diagnostic ? `${code}: ${String(error.diagnostic).slice(0, 300)}` : String(code)
}

/**
 * Resolve every declared peer against the running runtime.
 * @returns {Map<string, {version:string, source:string}>}
 */
export function resolvePeers(manifest, options = {}) {
  const map = new Map()
  if (!manifest) return map
  for (const [name] of peerDependenciesOf(manifest)) {
    const resolved = resolveInstalledVersion(name, options)
    map.set(name, { version: resolved.version || '', source: resolved.source || 'unknown' })
  }
  return map
}

/**
 * Full inspection: gathers manifests, entry text, and peer versions from disk,
 * then defers to inspectBundleSync for the verdict.
 *
 * `input.loaders` lets the service supply live facts without this module
 * importing Cordis:
 *   { admission(): Promise<admission>, clientGraph(): string[], serviceKeys(): string[] }
 *
 * @param {object} [input] same shape as inspectBundleSync, plus
 *   { loaders?: object, profileDir?: string, readEntry?: boolean }
 * @returns {Promise<object>} Report
 */
export async function inspectBundle(input = {}) {
  const pkg = { ...(input.pkg && typeof input.pkg === 'object' ? input.pkg : {}) }
  const loaders = input.loaders && typeof input.loaders === 'object' ? input.loaders : {}

  // Manifest: from the plugin directory when not supplied.
  let manifest = pkg.manifest && typeof pkg.manifest === 'object' ? pkg.manifest : null
  if (!manifest && typeof pkg.dir === 'string' && pkg.dir) manifest = readManifest(pkg.dir)
  if (manifest) pkg.manifest = manifest

  // Entry text for the static inject scan (never executed).
  let injectSymbols = input.injectSymbols === undefined ? null : input.injectSymbols
  if (injectSymbols === null && input.readEntry !== false && typeof pkg.dir === 'string' && pkg.dir) {
    const source = readEntrySource(pkg.dir, manifest)
    injectSymbols = source ? extractInjectSymbols(source) : undefined
    if (injectSymbols === undefined) injectSymbols = null
  }

  // Runtime version.
  let runtime = input.runtime
  if (!runtime || typeof runtime !== 'object') {
    runtime = resolveRuntimeVersion({ config: input.config, profileDir: input.profileDir })
  }

  // Peer resolution.
  let resolves = input.resolves instanceof Map ? input.resolves : null
  if (!resolves && manifest) {
    resolves = resolvePeers(manifest, { profileDir: input.profileDir })
  }

  // Live facts from the running composition.
  let admission = input.admission
  if (!admission && typeof loaders.admission === 'function') {
    try { admission = await loaders.admission() } catch { admission = undefined }
  }
  let clientGraph = input.clientGraph
  if (!clientGraph && typeof loaders.clientGraph === 'function') {
    try { clientGraph = await loaders.clientGraph() } catch { clientGraph = undefined }
  }
  let serviceKeys = input.serviceKeys
  if (!serviceKeys && typeof loaders.serviceKeys === 'function') {
    try { serviceKeys = await loaders.serviceKeys() } catch { serviceKeys = undefined }
  }
  let hasService = input.hasService
  if (!hasService && typeof loaders.hasService === 'function') hasService = loaders.hasService

  const report = inspectBundleSync({
    ...input,
    pkg,
    manifest,
    runtime,
    resolves,
    admission,
    clientGraph,
    serviceKeys,
    hasService,
    injectSymbols,
  })

  // The repo is not an inspection input but the UI needs it next to the grade.
  if (!report.repo && typeof loaders.repo === 'function') {
    try {
      const repo = await loaders.repo(manifest)
      report.repo = repoOf(repo)
      report.eligible = report.grade === 'red' && Boolean(report.repo)
    } catch { /* leave null */ }
  }
  return report
}

/**
 * sha256 dedupe signature for a Report; stable across key order and re-runs.
 * @param {object} report
 * @returns {string}
 */
export function dedupeSignature(report) {
  const source = report && typeof report === 'object' ? report : {}
  return signatureOf({
    package: source.name,
    version: source.version,
    runtimeVersion: source.runtimeVersion,
    findings: source.findings,
    missingSymbols: (Array.isArray(source.findings) ? source.findings : [])
      .filter((item) => item && item.code === CODES.symbolsInjectUnknown)
      .map((item) => item.actual || '')
      .filter(Boolean),
  })
}

/** Layer ids in report order; re-exported so callers need not import contract.js. */
export const LAYER_IDS = [...LAYERS]

export { SERVICE_KEY }
export default inspectBundle
