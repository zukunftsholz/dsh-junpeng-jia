#!/usr/bin/env node
// Static verification gate for dsh-junpeng-jia.
//
// Zero dependencies, Node 20+. Checks the shipped bundle *statically*: no
// plugin code is executed and no network is touched.
//
//   node scripts/verify.mjs
//
// Exit codes:
//   0  every check passed
//   1  at least one check FAILED (a real defect)
//   2  no failures, but at least one check is BLOCKED (work still in flight:
//      a file a teammate has not written yet). Re-run once it lands.
//
// Checks are grouped: package manifest, bundle wiring, sources, host/service
// surface, locales, icon.

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PLUGIN = ROOT
const LIB = join(ROOT, 'lib')

const MAX_ICON_BYTES = 256 * 1024

// ---------------------------------------------------------------------------
// tiny harness
// ---------------------------------------------------------------------------
const results = []

async function check(id, fn) {
  try {
    const detail = await fn()
    results.push({ id, status: 'PASS', detail: detail || '' })
  } catch (err) {
    if (err && err.blocked) {
      results.push({ id, status: 'BLOCKED', detail: err.message })
      return
    }
    results.push({ id, status: 'FAIL', detail: (err && err.message) || String(err) })
  }
}

function fail(message) {
  throw new Error(message)
}

function blocked(message) {
  const err = new Error(message)
  err.blocked = true
  throw err
}

function readJson(file) {
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    fail(`cannot read ${rel(file)} (missing)`)
  }
  try {
    return JSON.parse(text)
  } catch (err) {
    fail(`${rel(file)} is not valid JSON: ${err.message}`)
  }
}

function readTextOrBlocked(file, owner) {
  if (!existsSync(file)) {
    blocked(`${rel(file)} does not exist yet${owner ? ` — waiting on ${owner}` : ''}`)
  }
  return readFileSync(file, 'utf8')
}

const rel = (p) => relative(ROOT, p).split(sep).join('/')
const exists = (p) => existsSync(p)
const isDir = (p) => exists(p) && statSync(p).isDirectory()

function walk(dir) {
  if (!isDir(dir)) return []
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(full))
    else if (entry.isFile()) out.push(full)
  }
  return out.sort()
}

// ---------------------------------------------------------------------------
// 1. package manifest
// ---------------------------------------------------------------------------
const pkg = readJson(join(PLUGIN, 'package.json'))

await check('package.name', () => {
  if (pkg.name !== 'dsh-junpeng-jia') fail(`expected "dsh-junpeng-jia", found ${JSON.stringify(pkg.name)}`)
  return pkg.name
})

await check('package.version', () => {
  if (typeof pkg.version !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(pkg.version)) {
    fail(`package.version is not semver: ${JSON.stringify(pkg.version)}`)
  }
  return pkg.version
})

await check('package.type-is-module', () => {
  if (pkg.type !== 'module') fail('package.type must be "module" (ESM only, no build step)')
  return 'module'
})

await check('package.main', () => {
  if (typeof pkg.main !== 'string') fail('package.main must be a string')
  if (!exists(join(PLUGIN, pkg.main))) blocked(`package.main points at ${pkg.main}, not on disk yet (host-engine)`)
  return pkg.main
})

await check('package.exports', () => {
  const exp = pkg.exports
  if (!exp || typeof exp !== 'object') fail('package.exports is missing')
  const expected = {
    '.': './lib/index.js',
    './client': './lib/client.js',
    './package.json': './package.json',
    './icon': './icon.svg',
  }
  const missing = []
  for (const [key, target] of Object.entries(expected)) {
    if (!(key in exp)) fail(`package.exports is missing ${JSON.stringify(key)}`)
    if (exp[key] !== target) {
      fail(`package.exports[${JSON.stringify(key)}] must be ${JSON.stringify(target)}, found ${JSON.stringify(exp[key])}`)
    }
    if (target !== './package.json' && !exists(join(PLUGIN, target))) missing.push(target)
  }
  if (!Object.keys(exp).some((k) => k.includes('locale'))) {
    fail('package.exports must expose the locale files ("./locale/*.json")')
  }
  if (missing.length) blocked(`package.exports targets not on disk yet: ${missing.join(', ')}`)
  return Object.keys(exp).join(', ')
})

await check('package.dsh.bundle.patch', () => {
  const patch = pkg.dsh && pkg.dsh.bundle && pkg.dsh.bundle.patch
  if (typeof patch !== 'string') fail('dsh.bundle.patch must be a string path')
  if (!exists(join(PLUGIN, patch))) fail(`dsh.bundle.patch points at a missing file: ${patch}`)
  return patch
})

await check('package.dsh.client.platform', () => {
  const client = pkg.dsh && pkg.dsh.client
  if (!client || typeof client !== 'object') fail('dsh.client is missing')
  if (client.platform !== 'web') fail(`dsh.client.platform must be "web", found ${JSON.stringify(client.platform)}`)
  if (!Array.isArray(client.inject) || client.inject.length === 0) fail('dsh.client.inject must be a non-empty array')
  const bad = client.inject.filter((m) => typeof m !== 'string' || !m.startsWith('@deepseek-ai/'))
  if (bad.length) fail(`dsh.client.inject entries must be harness module ids: ${JSON.stringify(bad)}`)
  return `platform=web, inject=${client.inject.join(', ')}`
})

await check('package.files', () => {
  const files = pkg.files
  if (!Array.isArray(files)) fail('package.files must be an array')
  for (const required of ['lib', 'locale', 'icon.svg']) {
    if (!files.includes(required)) fail(`package.files must include ${JSON.stringify(required)}`)
  }
  return files.join(', ')
})

await check('package.files-exist', () => {
  const missing = (pkg.files || []).filter((entry) => !exists(join(PLUGIN, entry)))
  if (missing.length) fail(`package.files lists entries that do not exist at the package root: ${missing.join(', ')}`)
  return `${pkg.files.length}/${pkg.files.length} entries present`
})

await check('package.engines', () => {
  const eng = pkg.engines || {}
  if (typeof eng.dsh !== 'string') fail('engines.dsh is required (DSH admission reads it)')
  if (typeof eng.node !== 'string') fail('engines.node is required')
  if (!/^>=\s*20/.test(eng.node.trim())) fail(`engines.node must require Node >=20, found ${JSON.stringify(eng.node)}`)
  return `dsh=${eng.dsh}, node=${eng.node}`
})

await check('package.private', () => {
  if (pkg.private !== true) fail('package.private must be true (an installable bundle is never published to npm)')
  return 'true'
})

// ---------------------------------------------------------------------------
// 2. bundle wiring (cordis.patch.yml, read without a YAML dependency)
// ---------------------------------------------------------------------------
await check('bundle.patch-content', () => {
  const patchPath = join(PLUGIN, pkg.dsh.bundle.patch)
  const text = readFileSync(patchPath, 'utf8')
  if (!/^-\s*insert:/m.test(text)) fail('patch must contain a top-level "- insert:" list')
  if (!/^\s*-?\s*id:\s*['"]?junpengjia['"]?\s*$/m.test(text)) fail('patch must insert a row with id "junpengjia"')
  if (!/^\s*name:\s*['"]?dsh-junpeng-jia['"]?\s*$/m.test(text)) fail('patch must insert a row with name "dsh-junpeng-jia"')
  if (!/^\s*config:\s*\{\s*\}\s*$/m.test(text)) fail('patch row must carry a config mapping ("config: {}")')
  return `${rel(patchPath)} inserts junpengjia -> dsh-junpeng-jia`
})

// ---------------------------------------------------------------------------
// 3. contract
// ---------------------------------------------------------------------------
// Import eagerly so later checks can use it regardless of check ordering; a
// failure is reported by the contract.import check below.
let C = null
let contractImportError = null
try {
  C = await import(pathToFileURL(join(LIB, 'contract.js')).href)
} catch (err) {
  contractImportError = err
}

await check('contract.import', () => {
  if (!C) fail(`lib/contract.js could not be imported: ${contractImportError?.message}`)
  return `${Object.keys(C).length} named exports`
})

await check('contract.constants', () => {
  if (!C) fail('lib/contract.js could not be imported')
  const expected = {
    PACKAGE: 'dsh-junpeng-jia',
    ROW_ID: 'junpengjia',
    NAMESPACE: 'junpengjia',
    SERVICE_KEY: 'junpengjia',
    STATE_DIRNAME: '.junpeng-jia',
    STATE_FILENAME: 'state.json',
  }
  for (const [key, value] of Object.entries(expected)) {
    if (C[key] !== value) fail(`contract.${key} must be ${JSON.stringify(value)}, found ${JSON.stringify(C[key])}`)
  }
  if (C.SERVICE_KEY !== C.NAMESPACE) fail('contract.SERVICE_KEY and contract.NAMESPACE must stay equal')
  return Object.entries(expected).map(([k, v]) => `${k}=${v}`).join(', ')
})

await check('contract.remote-methods', () => {
  const expected = ['overview', 'inspect', 'nudge', 'settings', 'saveSettings', 'setToken', 'history']
  if (!Array.isArray(C?.REMOTE_METHODS)) fail('contract.REMOTE_METHODS must be an array')
  const actual = C.REMOTE_METHODS
  const missing = expected.filter((m) => !actual.includes(m))
  const extra = actual.filter((m) => !expected.includes(m))
  if (missing.length) fail(`contract.REMOTE_METHODS is missing: ${missing.join(', ')}`)
  if (extra.length) fail(`contract.REMOTE_METHODS has methods the client does not know: ${extra.join(', ')}`)
  if (new Set(actual).size !== actual.length) fail('contract.REMOTE_METHODS contains duplicates')
  return actual.join(', ')
})

await check('contract.codes-and-layers', () => {
  if (!C?.CODES || typeof C.CODES !== 'object') fail('contract.CODES is missing')
  const codes = Object.values(C.CODES)
  const dupes = codes.filter((code, i) => codes.indexOf(code) !== i)
  if (dupes.length) fail(`contract.CODES has duplicate stable codes: ${[...new Set(dupes)].join(', ')}`)
  const notNamespaced = codes.filter((code) => !/^[a-z]+\.[a-z][a-z-]*$/.test(code))
  if (notNamespaced.length) fail(`contract.CODES entries must be "area.code": ${notNamespaced.join(', ')}`)
  if (!Array.isArray(C.LAYERS) || C.LAYERS.join(',') !== 'manifest,resolution,symbols,activation') {
    fail(`contract.LAYERS must be manifest/resolution/symbols/activation, found ${JSON.stringify(C.LAYERS)}`)
  }
  if (!Array.isArray(C.GRADES) || C.GRADES.join(',') !== 'green,yellow,red,unknown') {
    fail(`contract.GRADES must be green/yellow/red/unknown, found ${JSON.stringify(C.GRADES)}`)
  }
  return `${codes.length} codes, layers=${C.LAYERS.join('/')}`
})

await check('contract.defaults-vs-config', () => {
  if (!C?.DEFAULTS || typeof C.DEFAULTS !== 'object') fail('contract.DEFAULTS is missing')
  const configPath = join(LIB, 'config.js')
  if (!exists(configPath)) blocked('lib/config.js does not exist yet — waiting on host-engine')
  const text = readFileSync(configPath, 'utf8')
  const missing = Object.keys(C.DEFAULTS).filter((key) => !new RegExp(`\\b${key}\\b`).test(text))
  if (missing.length) fail(`lib/config.js does not mention contract.DEFAULTS keys: ${missing.join(', ')}`)
  if (!/export\s+const\s+Config\b/.test(text)) fail('lib/config.js must export the Schemastery `Config`')
  return `${Object.keys(C.DEFAULTS).length} default keys mirrored in config.js`
})

// ---------------------------------------------------------------------------
// 4. sources: syntax, no forbidden client imports
// ---------------------------------------------------------------------------
await check('sources.present', () => {
  const missing = []
  for (const file of [
    'lib/index.js',
    'lib/client.js',
    'lib/config.js',
    'lib/contract.js',
    'lib/host/runtime.js',
    'lib/host/semver.js',
    'lib/host/inspect.js',
    'lib/host/github.js',
    'lib/host/store.js',
    'lib/host/service.js',
  ]) {
    if (!exists(join(PLUGIN, file))) missing.push(file)
  }
  if (missing.length) blocked(`not on disk yet: ${missing.join(', ')}`)
  return 'all 10 source files present'
})

await check('sources.node-check', () => {
  const files = walk(LIB).filter((f) => f.endsWith('.js') || f.endsWith('.mjs'))
  const bad = []
  for (const file of files) {
    const res = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' })
    if (res.status !== 0) bad.push(`${rel(file)}: ${(res.stderr || res.stdout || '').trim().split('\n')[0]}`)
  }
  if (bad.length) fail(`node --check failed:\n  ${bad.join('\n  ')}`)
  return `${files.length} files syntax-clean`
})

await check('client.no-harness-ui-imports', () => {
  const clientPath = join(LIB, 'client.js')
  const text = readTextOrBlocked(clientPath, 'client-ui')
  const hard = text.match(/@deepseek-ai\/dsh-client-ui-primitives/g)
  if (hard) fail('client.js must not import @deepseek-ai/dsh-client-ui-primitives (blueprint §1.2)')
  const imports = [...text.matchAll(/(?:from|require|import)\s*\(?\s*['"](@deepseek-ai\/[^'"]+)['"]/g)].map((m) => m[1])
  const unique = [...new Set(imports)]
  return unique.length ? `imports: ${unique.join(', ')}` : 'no harness client imports'
})

await check('client.remote-descriptor-matches-contract', () => {
  const clientPath = join(LIB, 'client.js')
  const text = readTextOrBlocked(clientPath, 'client-ui')
  if (!/\bTYPERT_REMOTE\b/.test(text)) fail('lib/client.js must declare a TYPERT_REMOTE descriptor')
  const methods = extractRemoteMethods(text)
  if (methods === null) fail('could not parse the TYPERT_REMOTE descriptor in lib/client.js')
  const contractMethods = C?.REMOTE_METHODS || []
  const missing = contractMethods.filter((m) => !methods.includes(m))
  const extra = methods.filter((m) => !contractMethods.includes(m))
  if (missing.length || extra.length) {
    fail(
      `TYPERT_REMOTE methods in lib/client.js do not match contract.REMOTE_METHODS — ` +
        `missing: [${missing.join(', ')}], extra: [${extra.join(', ')}]; ` +
        `descriptor: [${methods.join(', ')}], contract: [${contractMethods.join(', ')}]`,
    )
  }
  return `${methods.length} methods match contract`
})

await check('host.service-implements-remote-methods', () => {
  const servicePath = join(LIB, 'host', 'service.js')
  const text = readTextOrBlocked(servicePath, 'host-engine')
  const missing = (C?.REMOTE_METHODS || []).filter((method) => !new RegExp(`\\b${method}\\b`).test(text))
  if (missing.length) fail(`lib/host/service.js never mentions: ${missing.join(', ')}`)
  if (!/TypertRemoteService/.test(text)) fail('lib/host/service.js must use TypertRemoteService')
  return `${C.REMOTE_METHODS.length} methods referenced`
})

await check('host.index-registers-tool-and-service', () => {
  const indexPath = join(LIB, 'index.js')
  const text = readTextOrBlocked(indexPath, 'host-engine')
  if (!/\bjunpengjia\b/.test(text)) fail('lib/index.js must reference the namespace/service key "junpengjia"')
  if (!/apply\s*\(/.test(text)) fail('lib/index.js must export an apply(ctx, config) entry point')
  return 'apply() present, namespace referenced'
})

// ---------------------------------------------------------------------------
// 5. locales
// ---------------------------------------------------------------------------
await check('locales.meta', () => {
  const langs = ['en', 'zh']
  const seen = {}
  for (const lang of langs) {
    const file = join(PLUGIN, 'locale', `${lang}.json`)
    if (!exists(file)) fail(`missing locale file: locale/${lang}.json`)
    const dict = readJson(file)
    const meta = dict.meta
    if (!meta || typeof meta.title !== 'string' || !meta.title.trim()) fail(`locale ${lang}: meta.title is required`)
    if (typeof meta.description !== 'string' || !meta.description.trim()) fail(`locale ${lang}: meta.description is required`)
    seen[lang] = meta
  }
  if (seen.en.title === seen.zh.title) fail('en and zh meta.title must be localized, not identical')
  if (seen.en.description === seen.zh.description) fail('en and zh meta.description must be localized, not identical')
  return `en="${seen.en.title}", zh="${seen.zh.title}"`
})

await check('locales.key-parity', () => {
  const flatten = (obj, prefix = '') =>
    Object.entries(obj).flatMap(([key, value]) =>
      value && typeof value === 'object' && !Array.isArray(value)
        ? flatten(value, `${prefix}${key}.`)
        : [prefix + key],
    )
  const en = flatten(readJson(join(PLUGIN, 'locale', 'en.json')))
  const zh = flatten(readJson(join(PLUGIN, 'locale', 'zh.json')))
  const enKeys = [...en].sort()
  const zhKeys = [...zh].sort()
  const missingInZh = enKeys.filter((k) => !zhKeys.includes(k))
  const missingInEn = zhKeys.filter((k) => !enKeys.includes(k))
  if (missingInZh.length) fail(`locale/zh.json is missing keys: ${missingInZh.join(', ')}`)
  if (missingInEn.length) fail(`locale/en.json is missing keys: ${missingInEn.join(', ')}`)
  const empties = []
  for (const lang of ['en', 'zh']) {
    const dict = readJson(join(PLUGIN, 'locale', `${lang}.json`))
    const stack = [dict]
    while (stack.length) {
      const node = stack.pop()
      for (const [key, value] of Object.entries(node)) {
        if (value && typeof value === 'object') stack.push(value)
        else if (typeof value !== 'string' || !value.trim()) empties.push(`${lang}:${key}`)
      }
    }
  }
  if (empties.length) fail(`locale values must be non-empty strings: ${empties.join(', ')}`)
  return `${en.length} keys in both dictionaries`
})

// ---------------------------------------------------------------------------
// 6. icon
// ---------------------------------------------------------------------------
await check('icon.size', () => {
  const file = join(PLUGIN, 'icon.svg')
  if (!exists(file)) fail('icon.svg is missing')
  const bytes = statSync(file).size
  if (bytes === 0) fail('icon.svg is empty')
  if (bytes > MAX_ICON_BYTES) fail(`icon.svg is ${bytes} bytes, over the 256 KiB (${MAX_ICON_BYTES}) limit`)
  return `${bytes} bytes`
})

await check('icon.well-formed-svg', () => {
  const file = join(PLUGIN, 'icon.svg')
  if (!exists(file)) fail('icon.svg is missing')
  const text = readFileSync(file, 'utf8')
  const parsed = parseXml(text)
  if (!parsed.ok) fail(`icon.svg is not well-formed XML: ${parsed.error}`)
  if (parsed.root !== 'svg') fail(`icon.svg root element must be <svg>, found <${parsed.root}>`)
  if (!/\sxmlns\s*=\s*["']http:\/\/www\.w3\.org\/2000\/svg["']/.test(text)) {
    fail('icon.svg must declare xmlns="http://www.w3.org/2000/svg"')
  }
  if (!/\sviewBox\s*=/.test(text) && !(/\swidth\s*=/.test(text) && /\sheight\s*=/.test(text))) {
    fail('icon.svg must carry a viewBox (or width+height)')
  }
  if (/<script\b/i.test(text)) fail('icon.svg must not contain <script>')
  if (/\son[a-z]+\s*=/i.test(text)) fail('icon.svg must not contain inline event handlers')
  if (/(?:href|xlink:href)\s*=\s*["'](?:https?:)?\/\//i.test(text)) {
    fail('icon.svg must not reference external resources (offline-safe icon)')
  }
  return `${parsed.elements} elements, root <svg>`
})

// ---------------------------------------------------------------------------
// report
// ---------------------------------------------------------------------------
const failed = results.filter((r) => r.status === 'FAIL')
const blockedChecks = results.filter((r) => r.status === 'BLOCKED')
const passed = results.filter((r) => r.status === 'PASS')
const width = Math.max(...results.map((r) => r.id.length), 5)

const glyph = { PASS: 'PASS   ', FAIL: 'FAIL   ', BLOCKED: 'BLOCKED' }
console.log('dsh-junpeng-jia — static verification\n')
for (const r of results) {
  console.log(`  ${glyph[r.status]}  ${r.id.padEnd(width)}  ${r.detail.replace(/\n/g, '\n' + ' '.repeat(12 + width))}`)
}
console.log(
  `\n  ${passed.length} passed, ${failed.length} failed, ${blockedChecks.length} blocked, ${results.length} checks\n`,
)

if (failed.length) {
  console.error(`FAIL — ${failed.length} check(s) failed: ${failed.map((r) => r.id).join(', ')}`)
  process.exit(1)
}
if (blockedChecks.length) {
  console.error(
    `BLOCKED — ${blockedChecks.length} check(s) waiting on files that are not on disk yet: ` +
      `${blockedChecks.map((r) => r.id).join(', ')}`,
  )
  process.exit(2)
}
console.log('OK — all static checks passed')

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/**
 * Extract the method names of the TYPERT_REMOTE descriptor without importing
 * the (browser-only) client bundle.
 *
 * Supported descriptor shapes (all seen in third-party DSH plugins):
 *
 *   // canonical shape in this plugin:
 *   const TYPERT_REMOTE = {
 *     package: PKG,
 *     descriptors: [ descriptor('overview', []), descriptor('inspect', [...]), ... ],
 *   }
 *
 *   export const TYPERT_REMOTE = { namespace: 'x', descriptors: [{ method: 'overview' }] }
 *   export const TYPERT_REMOTE = { namespace: 'x', methods: { overview: {...} } }
 *   export const TYPERT_REMOTE = { namespace: 'x', methods: ['overview', ...] }
 *   export const TYPERT_REMOTE = { overview: {...}, inspect: {...} }
 *   export const TYPERT_REMOTE = { overview(ctx, ...) {...}, ... }
 *
 * Returns null when the descriptor cannot be located.
 */
function extractRemoteMethods(text) {
  // Locate the *assignment*, so a mention of TYPERT_REMOTE in a comment or a
  // later `ctx.remote.$mount(TYPERT_REMOTE)` call is not mistaken for it.
  const anchor = /TYPERT_REMOTE\s*=\s*\{/.exec(text)
  if (!anchor) return null
  const open = anchor.index + anchor[0].length - 1
  const body = balancedObject(text, open)
  if (body === null) return null

  // ---- shape A: descriptors: [ descriptor('overview', ...), ... ] ---------
  const descriptorsKey = /(?:^|[,{\s])\s*descriptors\s*:\s*\[/m.exec(body)
  if (descriptorsKey) {
    const arrStart = body.indexOf('[', descriptorsKey.index)
    const arr = balancedArray(body, arrStart)
    if (arr === null) return null

    const fromCalls = [...arr.matchAll(/\bdescriptor\s*\(\s*['"]([A-Za-z_$][\w$]*)['"]/g)].map((m) => m[1])
    if (fromCalls.length) return dedupe(fromCalls)

    const fromMethodField = [...arr.matchAll(/(?:^|[,{\s])\s*method\s*:\s*['"]([A-Za-z_$][\w$]*)['"]/g)].map((m) => m[1])
    if (fromMethodField.length) return dedupe(fromMethodField)

    const fromStrings = [...arr.matchAll(/['"]([A-Za-z_$][\w$]*)['"]/g)].map((m) => m[1])
    if (fromStrings.length) return dedupe(fromStrings)
    return []
  }

  // ---- shape B: methods: { ... } | methods: [ ... ] -----------------------
  const methodsKey = /(?:^|[,{\s])\s*(?:methods|remote|api)\s*:\s*/m.exec(body)
  if (methodsKey) {
    const valueStart = methodsKey.index + methodsKey[0].length
    const objIdx = body.indexOf('{', valueStart)
    const arrIdx = body.indexOf('[', valueStart)
    if (arrIdx !== -1 && (objIdx === -1 || arrIdx < objIdx)) {
      const arr = balancedArray(body, arrIdx)
      if (arr === null) return null
      return dedupe([...arr.matchAll(/['"]([A-Za-z_$][\w$]*)['"]/g)].map((m) => m[1]))
    }
    if (objIdx !== -1) {
      const inner = balancedObject(body, objIdx)
      if (inner === null) return null
      return dedupe(scanKeys(inner))
    }
  }

  // ---- shape C: the descriptor object *is* the method map -----------------
  return dedupe(scanKeys(body))
}

/** Collect `key:` / `key(` / `'key':` names from an object literal body. */
function scanKeys(body) {
  const names = []
  for (const m of body.matchAll(/(?:^|[,{,;\s])\s*(?:async\s+)?['"]?([A-Za-z_$][\w$]*)['"]?\s*(?::|\s*\()/g)) {
    names.push(m[1])
  }
  const STRUCTURAL = new Set([
    'namespace',
    'namespaceName',
    'service',
    'serviceKey',
    'package',
    'descriptors',
    'descriptor',
    'name',
    'id',
    'label',
    'title',
    'version',
    'type',
    'kind',
    'methods',
    'remote',
    'api',
    'params',
    'parameters',
    'args',
    'returns',
    'result',
    'description',
    'signature',
    'meta',
    'options',
    'inject',
    'platform',
    'invocation',
    'service:',
  ])
  return names.filter((name) => !STRUCTURAL.has(name))
}

function dedupe(list) {
  return [...new Set(list)]
}

/** Slice a brace-balanced object literal starting at `start` (which is '{'). */
function balancedObject(text, start) {
  return balanced(text, start, '{', '}')
}

/** Slice a bracket-balanced array literal starting at `start` (which is '['). */
function balancedArray(text, start) {
  return balanced(text, start, '[', ']')
}

function balanced(text, start, openCh, closeCh) {
  if (text[start] !== openCh) return null
  let depth = 0
  let quote = null
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i]
    if (quote) {
      if (ch === '\\') i += 1
      else if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch
      continue
    }
    if (ch === '/' && text[i + 1] === '/') {
      const nl = text.indexOf('\n', i)
      i = nl === -1 ? text.length : nl
      continue
    }
    if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2)
      i = end === -1 ? text.length : end + 1
      continue
    }
    if (ch === openCh) depth += 1
    else if (ch === closeCh) {
      depth -= 1
      if (depth === 0) return text.slice(start + 1, i)
    }
  }
  return null
}

/**
 * Minimal XML well-formedness check (no dependency): strips comments,
 * declarations and doctype, then walks tags with a stack. Text content is
 * allowed only inside an open element (SVG has <title>text</title>).
 */
function parseXml(text) {
  const stripped = text
    .replace(/<\?[\s\S]*?\?>/g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<!DOCTYPE[\s\S]*?>/gi, '')
  const stack = []
  let root = null
  let elements = 0
  const tagRe = /<(\/?)([A-Za-z_][\w:.-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/g
  let consumed = 0
  let match
  while ((match = tagRe.exec(stripped)) !== null) {
    const between = stripped.slice(consumed, match.index)
    if (between.trim() && stack.length === 0) {
      return { ok: false, error: `text outside the root element: "${between.trim().slice(0, 30)}"` }
    }
    if (/[<>]/.test(between)) {
      return { ok: false, error: `unescaped markup in text content: "${between.trim().slice(0, 30)}"` }
    }
    consumed = tagRe.lastIndex
    const [, closing, name, attrs, selfClose] = match
    if (closing) {
      if (stack.pop() !== name) return { ok: false, error: `unexpected </${name}>` }
      continue
    }
    elements += 1
    if (stack.length === 0) {
      if (root !== null) return { ok: false, error: 'multiple root elements' }
      root = name
    }
    if (!selfClose) stack.push(name)
  }
  if (consumed < stripped.length) {
    const tail = stripped.slice(consumed)
    if (tail.trim() && stack.length === 0) {
      return { ok: false, error: 'trailing content after the root element' }
    }
    if (/[<>]/.test(tail)) return { ok: false, error: 'unescaped markup after the root element' }
  }
  if (stack.length) return { ok: false, error: `unclosed element(s): ${stack.join(' > ')}` }
  if (!root) return { ok: false, error: 'no root element' }
  return { ok: true, root, elements }
}
