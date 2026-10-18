// Runtime-version resolution.
//
// The contract (docs/API-CONTRACT.md) pins the `runtimeSource` literals:
//   'env' | 'resolve' | 'asar' | 'config' | 'unknown'
// and the blueprint requires that a failed probe degrades to `unknown` rather
// than throwing, because it is on the critical path of overview()/inspect().
//
// Every test here is hermetic: environment variables are passed in explicitly
// and probe paths are injected, so no real DSH install is required.
//
// Canonical run: node --test "test/*.test.mjs"

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { hostModule, moduleSuite, expectExports } from './_helpers.mjs'

const mod = await hostModule('runtime')
const runtime = moduleSuite(mod, 'lib/host/runtime.js')

const CONTRACT_SOURCES = ['env', 'resolve', 'asar', 'config', 'unknown']

/**
 * Build a throwaway "installed packages" tree and return a resolver with the
 * documented injection signature: (name) => absolute path to that package's
 * package.json. Throws for unknown names, like a real resolver would.
 */
async function fixturePackages(packages) {
  const dir = await mkdtemp(join(tmpdir(), 'jj-runtime-'))
  const files = new Map()
  for (const [name, manifest] of Object.entries(packages)) {
    const pkgDir = join(dir, 'node_modules', ...name.split('/'))
    await mkdir(pkgDir, { recursive: true })
    const file = join(pkgDir, 'package.json')
    await writeFile(file, JSON.stringify({ name, ...manifest }), 'utf8')
    files.set(name, file)
  }
  return {
    dir,
    resolve(name) {
      const file = files.get(name)
      if (!file) {
        const err = new Error(`Cannot find module '${name}/package.json'`)
        err.code = 'MODULE_NOT_FOUND'
        throw err
      }
      return file
    },
    cleanup: () => rm(dir, { recursive: true, force: true }),
  }
}

if (mod.ok) {
  await test('lib/host/runtime.js exports the locked surface', async (t) => {
    await expectExports(t, mod, 'lib/host/runtime.js', [
      'resolveRuntimeVersion',
      'resolveInstalledVersion',
    ])
  })
}

runtime.it('RUNTIME_SOURCES matches the literals pinned by docs/API-CONTRACT.md', () => {
  assert.deepEqual([...runtime.ns.RUNTIME_SOURCES].sort(), [...CONTRACT_SOURCES].sort())
})

runtime.it('an explicit runtimeVersionOverride is reported with source "config"', () => {
  const resolved = runtime.ns.resolveRuntimeVersion({
    config: { runtimeVersionOverride: '0.2.1-rc.2' },
    env: {},
    requireFrom: () => {
      throw new Error('must not probe the filesystem when a config override is set')
    },
    asarDirs: [],
  })
  assert.equal(resolved.version, '0.2.1-rc.2')
  assert.equal(resolved.source, 'config')
})

runtime.it('DSH_VERSION / DSH_DESKTOP_VERSION are read from the environment with source "env"', () => {
  for (const key of ['DSH_VERSION', 'DSH_DESKTOP_VERSION']) {
    const resolved = runtime.ns.resolveRuntimeVersion({
      config: {},
      env: { [key]: '0.2.1-rc.2' },
      requireFrom: () => {
        throw new Error('nothing resolvable')
      },
      asarDirs: [],
    })
    assert.equal(resolved.version, '0.2.1-rc.2', `${key} must be honoured`)
    assert.equal(resolved.source, 'env', `${key} must be attributed to the environment`)
  }
})

runtime.it('a resolvable runtime manifest is attributed to "resolve"', async () => {
  const fixture = await fixturePackages({ '@deepseek-ai/dsh-app-boot': { version: '0.2.1-rc.2' } })
  try {
    const resolved = runtime.ns.resolveRuntimeVersion({
      config: {},
      env: {},
      requireFrom: fixture.resolve,
      resourceDirs: [],
    })
    assert.equal(resolved.version, '0.2.1-rc.2')
    assert.equal(resolved.source, 'resolve')
  } finally {
    await fixture.cleanup()
  }
})

runtime.it('nothing resolvable degrades to {version:"", source:"unknown"} and never throws', () => {
  const resolved = runtime.ns.resolveRuntimeVersion({
    config: {},
    env: {},
    requireFrom: () => {
      throw new Error('Cannot find module')
    },
    asarDirs: [],
  })
  assert.equal(resolved.version, '')
  assert.equal(resolved.source, 'unknown')
})

runtime.it('garbage manifests are rejected rather than reported as a version', () => {
  for (const manifest of [{}, { version: '' }, { version: 'not-a-version' }, { version: 42 }, null]) {
    const resolved = runtime.ns.resolveRuntimeVersion({
      config: {},
      env: {},
      requireFrom: () => manifest,
      asarDirs: [],
    })
    assert.equal(resolved.version, '', `manifest ${JSON.stringify(manifest)} must not yield a version`)
    assert.equal(resolved.source, 'unknown')
  }
})

runtime.it('resolveRuntimeVersion never throws for hostile inputs', () => {
  const hostile = [
    {},
    { config: null, env: null, requireFrom: null, asarDirs: null },
    { config: { runtimeVersionOverride: 42 } },
    { config: { runtimeVersionOverride: '   ' } },
    { env: { DSH_VERSION: '   ' } },
    { requireFrom: () => { throw new Error('boom') } },
    { requireFrom: () => { throw new Error('boom') }, asarDirs: ['C:\\nonexistent\\path'] },
  ]
  for (const options of hostile) {
    assert.doesNotThrow(() => runtime.ns.resolveRuntimeVersion(options), JSON.stringify(options))
    const resolved = runtime.ns.resolveRuntimeVersion(options)
    assert.ok(CONTRACT_SOURCES.includes(resolved.source), `unexpected source ${resolved.source}`)
  }
})

runtime.it('every returned source is one of the five contract literals (exhaustive)', () => {
  const scenarios = [
    { config: { runtimeVersionOverride: '0.2.1-rc.2' }, env: {}, requireFrom: () => { throw new Error('x') }, asarDirs: [] },
    { config: {}, env: { DSH_VERSION: '0.2.1-rc.2' }, requireFrom: () => { throw new Error('x') }, asarDirs: [] },
    { config: {}, env: {}, requireFrom: () => ({ version: '0.2.1-rc.2' }), asarDirs: [] },
    { config: {}, env: {}, requireFrom: () => { throw new Error('x') }, asarDirs: [] },
  ]
  for (const options of scenarios) {
    const resolved = runtime.ns.resolveRuntimeVersion(options)
    assert.ok(CONTRACT_SOURCES.includes(resolved.source), `source ${resolved.source} is outside the contract`)
  }
})

runtime.it('resolveInstalledVersion reports "unknown" for a package that is not installed', () => {
  const resolved = runtime.ns.resolveInstalledVersion('@deepseek-ai/dsh-definitely-not-installed', {
    requireFrom: () => {
      throw new Error("Cannot find module '@deepseek-ai/dsh-definitely-not-installed/package.json'")
    },
  })
  assert.equal(resolved.version, '')
  assert.equal(resolved.source, 'unknown')
})

runtime.it('resolveInstalledVersion reads a resolved package manifest', async () => {
  const fixture = await fixturePackages({ '@deepseek-ai/cordis': { version: '4.0.5' } })
  try {
    const resolved = runtime.ns.resolveInstalledVersion('@deepseek-ai/cordis', {
      requireFrom: fixture.resolve,
    })
    assert.equal(resolved.version, '4.0.5')
    assert.equal(resolved.source, 'resolve')
  } finally {
    await fixture.cleanup()
  }
})

runtime.it('resolveInstalledVersion reports "unknown" when the manifest is unreadable or versionless', async () => {
  const fixture = await fixturePackages({ '@deepseek-ai/dsh-broken': {} })
  try {
    const resolved = runtime.ns.resolveInstalledVersion('@deepseek-ai/dsh-broken', {
      requireFrom: fixture.resolve,
    })
    assert.equal(resolved.version, '')
    assert.equal(resolved.source, 'unknown')
  } finally {
    await fixture.cleanup()
  }
})

runtime.it('resolveInstalledVersion never throws, whatever the resolver does', () => {
  for (const requireFrom of [
    () => { throw new Error('boom') },
    () => null,
    () => ({}),
    () => ({ version: 'not-a-version' }),
    undefined,
  ]) {
    assert.doesNotThrow(() => runtime.ns.resolveInstalledVersion('@deepseek-ai/x', { requireFrom }))
  }
})
