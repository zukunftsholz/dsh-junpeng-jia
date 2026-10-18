// Running-DSH version resolution.
//
// Every probe is defensive: this module is on the critical path of `overview()`
// and `inspect()`, and a thrown error here would turn every bundle's grade into
// a crash instead of `unknown`. Nothing below throws; failures collapse into
// `{ version: '', source: 'unknown' }`, which is exactly what the blueprint
// demands ("运行版本探测失败 => runtimeSource 标注 unknown").
//
// Probe order (highest confidence first):
//   1. config override        — the user's explicit `runtimeVersionOverride`
//   2. @deepseek-ai/dsh-app-boot getDshRuntimeVersion()
//   3. resolve @deepseek-ai/dsh-app-boot/package.json  (its own manifest version
//      IS the value app-boot reports, so this is the offline form of probe 2)
//   4. resolve @deepseek-ai/dsh/package.json
//   5. Electron: <resourcesPath>/app.asar/dsh/package.json (works when Node's
//      asar patching is on; in plain node this stat fails and we move on)
//   6. <resourcesPath>/runtime/primary-runtime/runtime.json  (`desktopVersion`)
//   7. DSH_VERSION / DSH_DESKTOP_VERSION environment variables
//
// The environment probes come last on purpose: env vars are the easiest to set
// to a wrong value (a stale shell, a wrapper script), while a resolved manifest
// is by definition the code that is actually running.
//
// Sources reported to the UI are the literals pinned by docs/API-CONTRACT.md:
// 'env' | 'resolve' | 'asar' | 'config' | 'unknown'.

import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'

const APP_BOOT = '@deepseek-ai/dsh-app-boot'
const DSH_PACKAGE = '@deepseek-ai/dsh'

/** Source literals; keep in sync with docs/API-CONTRACT.md. */
export const RUNTIME_SOURCES = ['env', 'resolve', 'asar', 'config', 'unknown']

/** The shape returned when nothing could be determined. */
export function unknownRuntime(reason = 'no probe succeeded') {
  return { version: '', source: 'unknown', reason }
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

function versionOf(manifest) {
  // Accept either a parsed manifest object or a bare version string: the
  // runtime.json probe below reads `desktopVersion`, which is already a string.
  const raw = typeof manifest === 'string'
    ? manifest
    : manifest && typeof manifest.version === 'string' ? manifest.version : ''
  const version = raw.trim()
  return /^\d+\.\d+\.\d+/.test(version) ? version : ''
}

/** Best-effort Electron info without importing 'electron' (it is not resolvable here). */
function electronResourceDirs() {
  const dirs = []
  const resourcesPath = typeof process !== 'undefined' ? process.resourcesPath : undefined
  if (typeof resourcesPath === 'string' && resourcesPath) dirs.push(resourcesPath)
  const execPath = typeof process !== 'undefined' ? process.execPath : undefined
  if (typeof execPath === 'string' && execPath) {
    // <install>/DeepSeek Harness.exe -> <install>/resources
    dirs.push(path.join(path.dirname(execPath), 'resources'))
  }
  return [...new Set(dirs.filter(Boolean))]
}

/** Profile directory, never guessed from cwd. */
export function profileDirFromEnv(env = process.env) {
  const value = env && typeof env.DSH_PROFILE_DIR === 'string' ? env.DSH_PROFILE_DIR.trim() : ''
  return value || ''
}

/** Profile *name* for display; never an absolute path (the contract forbids leaking paths). */
export function profileNameFromEnv(env = process.env) {
  const explicit = env && typeof env.DSH_PROFILE === 'string' ? env.DSH_PROFILE.trim() : ''
  if (explicit) return explicit
  const dir = profileDirFromEnv(env)
  return dir ? path.basename(dir) : 'unknown'
}

/**
 * Profile directory with context fallbacks.
 *
 * The Host process launched by Desktop does not necessarily export
 * DSH_PROFILE_DIR (only the shell does), so relying on the environment alone
 * made every manifest unreadable. Cordis exposes the Loader base directory on
 * the context; the entry options carry the profile location as a second source.
 *
 * @param {any} ctx Cordis context (may be undefined in tests)
 * @param {Record<string,string|undefined>} [env]
 * @returns {string} absolute profile directory, or '' when nothing is known
 */
export function profileDirFromContext(ctx, env = process.env) {
  const fromEnv = profileDirFromEnv(env)
  if (fromEnv) return fromEnv

  const candidates = []
  const push = (value) => {
    if (typeof value === 'string' && value.trim()) candidates.push(value.trim())
  }
  try { push(ctx && ctx.baseDir) } catch { /* reflect may throw */ }
  try { push(ctx && ctx.baseUrl) } catch { /* ignore */ }
  try { push(ctx && ctx.root && ctx.root.baseDir) } catch { /* ignore */ }
  try { push(ctx && ctx.loader && ctx.loader.baseUrl) } catch { /* ignore */ }
  try { push(ctx && ctx.fiber && ctx.fiber.entry && ctx.fiber.entry.baseUrl) } catch { /* ignore */ }
  try { push(ctx && ctx.fiber && ctx.fiber.entry && ctx.fiber.entry.options && ctx.fiber.entry.options.baseUrl) } catch { /* ignore */ }
  try { push(ctx && ctx.fiber && ctx.fiber.entry && ctx.fiber.entry.options && ctx.fiber.entry.options.baseDir) } catch { /* ignore */ }
  try { push(ctx && ctx.fiber && ctx.fiber.entry && ctx.fiber.entry.options && ctx.fiber.entry.options.dir) } catch { /* ignore */ }

  // The plugin manager lives in the profile; some versions expose its location.
  try {
    const manager = typeof ctx.get === 'function' ? ctx.get('pluginManager') : undefined
    if (manager) {
      for (const key of ['profileDir', 'dir', 'profile', 'baseDir']) {
        try { push(manager[key]) } catch { /* getter may throw */ }
      }
      try { push(manager.ctx && manager.ctx.baseDir) } catch { /* ignore */ }
      try { push(manager.ctx && manager.ctx.baseUrl) } catch { /* ignore */ }
    }
  } catch { /* optional service */ }

  const home = env && typeof env.DSH_HOME === 'string' ? env.DSH_HOME.trim() : ''
  const name = env && typeof env.DSH_PROFILE === 'string' ? env.DSH_PROFILE.trim() : ''
  if (home && name) push(path.join(home, 'profiles', name))

  // `file://` URLs from loader options.
  for (const candidate of [...candidates]) {
    if (candidate.startsWith('file:')) {
      try { push(decodeURIComponent(new URL(candidate).pathname).replace(/^\/([A-Za-z]:)/, '$1')) } catch { /* ignore */ }
    }
  }

  for (const candidate of candidates) {
    try {
      if (existsSync(path.join(candidate, 'package.json'))) return candidate
    } catch { /* ignore */ }
  }
  return candidates.length ? candidates[0] : ''
}

/** Display name for a resolved profile directory (never a path). */
export function profileNameFromDir(dir, env = process.env) {
  const explicit = env && typeof env.DSH_PROFILE === 'string' ? env.DSH_PROFILE.trim() : ''
  if (explicit) return explicit
  return dir ? path.basename(dir) : 'unknown'
}

/**
 * Resolve a package's directory through the profile's module resolution.
 *
 * `BundleInfo.source` is a pnpm spec (a git address, a range, a tag), never a
 * filesystem directory, so it cannot be used to read a manifest.
 *
 * @param {string} name package name
 * @param {string} profileDir profile directory (module resolution anchor)
 * @returns {string} absolute package directory, or '' when unresolved
 */
export function resolvePackageDir(name, profileDir) {
  const req = makeRequire(profileDir)
  if (!req || !name) return ''
  try {
    return path.dirname(req.resolve(`${name}/package.json`))
  } catch { /* fall through to the entry walk */ }
  try {
    const entry = req.resolve(name)
    let dir = path.dirname(entry)
    for (let i = 0; i < 8; i++) {
      try {
        if (existsSync(path.join(dir, 'package.json'))) return dir
      } catch { /* ignore */ }
      const parent = path.dirname(dir)
      if (parent === dir) break
      dir = parent
    }
  } catch { /* unresolved */ }
  return ''
}

/** Build a resolver rooted at the profile directory (an anchor plain `require` lacks). */
export function makeRequire(profileDir) {
  const dir = profileDir || process.cwd()
  try {
    return createRequire(path.join(dir, 'noop.js'))
  } catch {
    try {
      return createRequire(import.meta.url)
    } catch {
      return null
    }
  }
}

function resolvePackageJson(req, name) {
  if (!req) return ''
  try {
    // Packages without an explicit "./package.json" export still resolve via the
    // legacy package-main lookup, which is what every plugin does in practice.
    return req.resolve(`${name}/package.json`)
  } catch {
    try {
      const entry = req.resolve(name)
      // Walk up from the entry point until a package.json appears.
      let dir = path.dirname(entry)
      for (let i = 0; i < 8; i++) {
        const candidate = path.join(dir, 'package.json')
        const manifest = readJson(candidate)
        if (manifest) return candidate
        const parent = path.dirname(dir)
        if (parent === dir) break
        dir = parent
      }
    } catch {
      return ''
    }
  }
  return ''
}

/**
 * Resolve the installed version of one package from the running runtime's
 * point of view.
 *
 * @param {string} packageName e.g. '@deepseek-ai/dsh-typert-protocol'
 * @param {{ profileDir?: string, requireFrom?: (name: string) => string }} [options]
 * @returns {{ version: string, source: string, package?: string, path?: string }}
 */
export function resolveInstalledVersion(packageName, options = {}) {
  if (typeof packageName !== 'string' || !packageName.trim()) {
    return { version: '', source: 'unknown' }
  }
  const profileDir = options.profileDir ?? profileDirFromEnv()
  const req = typeof options.requireFrom === 'function'
    ? { resolve: options.requireFrom }
    : makeRequire(profileDir)
  const file = resolvePackageJson(req, packageName.trim())
  if (!file) return { version: '', source: 'unknown', package: packageName }
  const version = versionOf(readJson(file))
  if (!version) return { version: '', source: 'unknown', package: packageName, path: file }
  return { version, source: 'resolve', package: packageName, path: file }
}

/**
 * Resolve the running DSH version.
 *
 * Synchronous: the async app-boot probe is exposed separately as
 * `resolveRuntimeVersionAsync` for callers that can await it. Both return the
 * same `{ version, source, reason? }` shape.
 *
 * @param {{
 *   config?: { runtimeVersionOverride?: string },
 *   env?: NodeJS.ProcessEnv,
 *   profileDir?: string,
 *   requireFrom?: (name: string) => string,
 *   resourceDirs?: string[],
 * }} [options]
 * @returns {{ version: string, source: string, reason?: string }}
 */
export function resolveRuntimeVersion(options = {}) {
  const env = options.env ?? process.env

  // 1. Explicit config override.
  const override = options.config && typeof options.config.runtimeVersionOverride === 'string'
    ? options.config.runtimeVersionOverride.trim()
    : ''
  if (override) {
    if (/^\d+\.\d+\.\d+/.test(override)) return { version: override, source: 'config' }
    return { version: '', source: 'config', reason: `invalid runtimeVersionOverride ${JSON.stringify(override)}` }
  }

  const profileDir = options.profileDir ?? profileDirFromEnv()
  const req = typeof options.requireFrom === 'function'
    ? { resolve: options.requireFrom }
    : makeRequire(profileDir)

  // 2. Manifest of app-boot: the same value its getDshRuntimeVersion() reports.
  for (const name of [APP_BOOT, DSH_PACKAGE]) {
    const file = resolvePackageJson(req, name)
    if (!file) continue
    const version = versionOf(readJson(file))
    if (version) return { version, source: 'resolve' }
  }

  // 3. Electron layout: app.asar/dsh/package.json, then the runtime manifest.
  const dirs = Array.isArray(options.resourceDirs) && options.resourceDirs.length
    ? options.resourceDirs
    : electronResourceDirs()
  for (const dir of dirs) {
    for (const rel of [
      path.join('app.asar', 'dsh', 'package.json'),
      path.join('app', 'dsh', 'package.json'),
      path.join('app.asar.unpacked', 'dsh', 'package.json'),
    ]) {
      const version = versionOf(readJson(path.join(dir, rel)))
      if (version) return { version, source: 'asar' }
    }
    for (const rel of [
      path.join('runtime', 'primary-runtime', 'runtime.json'),
      path.join('runtime', 'runtime.json'),
    ]) {
      const manifest = readJson(path.join(dir, rel))
      const version = versionOf(manifest && (manifest.desktopVersion ?? manifest.dshVersion))
      if (version) return { version, source: 'asar' }
    }
  }

  // 4. Environment (lowest confidence, so checked last).
  for (const key of ['DSH_VERSION', 'DSH_DESKTOP_VERSION']) {
    const raw = env && typeof env[key] === 'string' ? env[key].trim() : ''
    if (raw && /^\d+\.\d+\.\d+/.test(raw)) return { version: raw, source: 'env' }
  }

  return unknownRuntime()
}

/**
 * Async form: prefers the live app-boot accessor, then falls back to the
 * synchronous chain. Never rejects.
 *
 * @param {Parameters<typeof resolveRuntimeVersion>[0]} [options]
 * @returns {Promise<{ version: string, source: string, reason?: string }>}
 */
export async function resolveRuntimeVersionAsync(options = {}) {
  const sync = () => resolveRuntimeVersion(options)
  // A config override beats the live accessor: it is the documented escape hatch
  // for a broken runtime.
  const override = options.config && typeof options.config.runtimeVersionOverride === 'string'
    ? options.config.runtimeVersionOverride.trim()
    : ''
  if (override) return sync()
  try {
    const mod = await import(APP_BOOT)
    const read = mod && (mod.getDshRuntimeVersion ?? mod.default?.getDshRuntimeVersion)
    if (typeof read === 'function') {
      const value = read()
      const version = typeof value === 'string' ? value.trim() : ''
      if (/^\d+\.\d+\.\d+/.test(version)) return { version, source: 'resolve' }
    }
  } catch {
    // app-boot is not installed in a plain-node harness; fall through.
  }
  return sync()
}

export default {
  RUNTIME_SOURCES,
  resolveRuntimeVersion,
  resolveRuntimeVersionAsync,
  resolveInstalledVersion,
  profileDirFromEnv,
  profileNameFromEnv,
  makeRequire,
  unknownRuntime,
}
