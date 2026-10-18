// Shared test helpers. Not a test file: the canonical runner is
//   node --test "test/*.test.mjs"
// (Node 24 does not accept a bare directory argument for --test; see README.)
//
// Responsibilities:
//   - resolve workspace paths portably (no absolute paths baked in),
//   - import plugin modules and turn a missing module into an explicit,
//     visible skip instead of a fake pass,
//   - assert the *contract* (docs/API-CONTRACT.md + lib/contract.js) rather
//     than host-engine internals.

import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import test from 'node:test'

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const PLUGIN_DIR = join(ROOT, 'plugin')
export const LIB_DIR = join(PLUGIN_DIR, 'lib')
export const HOST_DIR = join(LIB_DIR, 'host')

/** Format any thrown value into a one-line reason. */
export function reasonOf(err) {
  if (!err) return 'unknown error'
  const code = err.code ? `${err.code}: ` : ''
  const msg = String(err.message || err).split('\n')[0]
  return `${code}${msg}`
}

/** Import an absolute file path; never throws. */
export async function tryImport(filePath) {
  try {
    return { ok: true, ns: await import(pathToFileURL(filePath).href), path: filePath }
  } catch (err) {
    return { ok: false, ns: null, path: filePath, reason: reasonOf(err), error: err }
  }
}

/** Import a host module by short name, e.g. `host('semver')`. */
export async function hostModule(name) {
  return tryImport(join(HOST_DIR, `${name}.js`))
}

/** Import a file from plugin/lib by relative path, e.g. `libModule('contract.js')`. */
export async function libModule(relative) {
  return tryImport(join(LIB_DIR, relative))
}

/**
 * Build a test facade for a module that may not exist yet.
 *
 *   const suite = moduleSuite(mod, 'plugin/lib/host/semver.js')
 *   suite.it('...', () => { ... suite.ns.satisfies ... })
 *
 * When the module is missing, `it` registers a SKIPPED test whose name carries
 * the reason, so the run reports `skipped`, never a green lie.
 */
export function moduleSuite(mod, label = mod.path) {
  const skipReason = mod.ok
    ? false
    : `${label} is not on disk yet (${mod.reason}) — waiting on host-engine`
  const it = skipReason
    ? (name, fn) => test(name, { skip: skipReason }, () => {})
    : (name, fn) => test(name, fn)
  return { it, ns: mod.ok ? mod.ns : null, ok: mod.ok, skipReason }
}

/**
 * Assert that a module exposes the functions the tests rely on, with an error
 * that names the exact mismatch (this is what gets reported as a contract
 * mismatch rather than a confusing TypeError deep inside a test).
 */
export async function expectExports(t, mod, label, required) {
  const assert = (await import('node:assert/strict')).default
  const where = `${label} (${mod.path})`
  assert.ok(mod.ok, `${where} could not be imported: ${mod.reason}`)
  const missing = required.filter((name) => typeof mod.ns[name] !== 'function')
  assert.deepEqual(
    missing,
    [],
    `${where} is missing required exports: ${missing.join(', ')}; exported: ${Object.keys(mod.ns).join(', ') || '(none)'}`,
  )
}

/** Regex: an absolute local path that must never appear in an issue payload. */
export const ABSOLUTE_PATH_PATTERNS = [
  /[A-Za-z]:\\/, // C:\ ...
  /[A-Za-z]:\//, // C:/ ...
  /Users\\/i, // C:\Users\<name>\
  /Users\//i, // C:/Users/<name>/
  /\/home\/[^\s/]+/i, // /home/<name>
  /\/root\//i,
  /AppData/i,
]

/** Return the first pattern that matches `text`, or null. */
export function findAbsolutePath(text) {
  for (const re of ABSOLUTE_PATH_PATTERNS) {
    const m = text.match(re)
    if (m) return { pattern: re.source, match: m[0] }
  }
  return null
}
