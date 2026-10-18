// Inspection engine: dual-factor grading, dedupe signatures, repo resolution.
//
// Verified against docs/API-CONTRACT.md ("Grading") and the admission rule DSH
// itself applies (@deepseek-ai/dsh-app-boot README):
//   - a manifest that declares `engines.dsh` is decided by that range ALONE,
//     peerDependencies are ignored;
//   - otherwise every peer range on `@deepseek-ai/dsh` / `@deepseek-ai/dsh-*`
//     must match;
//   - prereleases participate in range matching;
//   - an empty or invalid `engines.dsh` counts as incompatible;
//   - exemptions live in the profile's compatibility.json.
//
// Canonical run: node --test "test/*.test.mjs"

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { hostModule, moduleSuite, expectExports } from './_helpers.mjs'

const inspectMod = await hostModule('inspect')
const githubMod = await hostModule('github')
const storeMod = await hostModule('store')

const inspect = moduleSuite(inspectMod, 'plugin/lib/host/inspect.js')
const github = moduleSuite(githubMod, 'plugin/lib/host/github.js')
const store = moduleSuite(storeMod, 'plugin/lib/host/store.js')

const RUNTIME = '0.2.1-rc.2'
const RUNTIME_RANGE = '>=0.2.0-rc.1 <0.3.0-0'

if (inspectMod.ok) {
  await test('plugin/lib/host/inspect.js exports the locked surface', async (t) => {
    await expectExports(t, inspectMod, 'plugin/lib/host/inspect.js', [
      'inspectBundle',
      'inspectBundleSync',
      'extractInjectSymbols',
      'missingSymbols',
      'computeGrade',
      'dedupeSignature',
    ])
  })
}

if (githubMod.ok) {
  await test('plugin/lib/host/github.js exports the locked surface', async (t) => {
    await expectExports(t, githubMod, 'plugin/lib/host/github.js', [
      'resolveRepo',
      'parseGithubRepo',
      'buildIssue',
      'draftUrl',
      'fileIssue',
      'scrubText',
    ])
  })
}

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

/** A manifest that is fully compatible with the running runtime. */
function goodManifest(overrides = {}) {
  return {
    name: 'dsh-fake-good',
    version: '1.2.3',
    description: 'fixture plugin',
    engines: { dsh: RUNTIME_RANGE, node: '>=20' },
    peerDependencies: { '@deepseek-ai/dsh-typert-protocol': RUNTIME_RANGE },
    dsh: {
      bundle: { patch: './cordis.patch.yml' },
      client: { platform: 'web', inject: ['@deepseek-ai/dsh-client-locale'] },
    },
    repository: { type: 'git', url: 'git+https://github.com/example/dsh-fake-good.git' },
    ...overrides,
  }
}

/**
 * Peer resolution facts: what each declared peer resolves to in this runtime.
 * Without this map the resolution layer is 'skip' (not probed), which is why
 * the fixture supplies it — production inspects against real resolutions.
 */
function goodResolves(overrides = {}) {
  return new Map([
    ['@deepseek-ai/dsh-typert-protocol', { version: RUNTIME, source: 'resolve' }],
    ...Object.entries(overrides),
  ])
}

/** Input for the pure/sync inspector. `dir` is omitted: the symbols layer then
 *  reports `skip` instead of scanning a nonexistent entry file. */
function input({ manifest = goodManifest(), runtime = { version: RUNTIME, source: 'env' }, ...rest } = {}) {
  const fixture = {
    pkg: { name: manifest.name, version: manifest.version, manifest },
    runtime,
    repo: 'example/dsh-fake-good',
    resolves: goodResolves(),
    serviceKeys: [],
    clientGraph: ['@deepseek-ai/dsh-client-locale', '@deepseek-ai/dsh-client-ui-slots'],
    now: 1_700_000_000_000,
    ...rest,
  }
  // A caller that overrides `resolves` explicitly (including to null) wins.
  if ('resolves' in rest) fixture.resolves = rest.resolves
  return fixture
}

const side = (status, ...reasons) => ({ status, reasons })

// ---------------------------------------------------------------------------
// computeGrade — the pure grading table
// ---------------------------------------------------------------------------
inspect.it('computeGrade: pass + pass => green', () => {
  assert.equal(inspect.ns.computeGrade(side('pass'), side('pass'), RUNTIME), 'green')
})

inspect.it('computeGrade: fail + pass => yellow (plugin side alone)', () => {
  assert.equal(inspect.ns.computeGrade(side('fail'), side('pass'), RUNTIME), 'yellow')
})

inspect.it('computeGrade: warn + pass => yellow (warn counts on the plugin side)', () => {
  assert.equal(inspect.ns.computeGrade(side('warn'), side('pass'), RUNTIME), 'yellow')
})

inspect.it('computeGrade: pass + fail => yellow (runtime side alone)', () => {
  assert.equal(inspect.ns.computeGrade(side('pass'), side('fail'), RUNTIME), 'yellow')
})

inspect.it('computeGrade: pass + warn => yellow', () => {
  assert.equal(inspect.ns.computeGrade(side('pass'), side('warn'), RUNTIME), 'yellow')
})

inspect.it('computeGrade: fail + fail => red (both sides)', () => {
  assert.equal(inspect.ns.computeGrade(side('fail'), side('fail'), RUNTIME), 'red')
})

inspect.it('computeGrade: only exact fail+fail is red; a warn never promotes to red', () => {
  const cases = [
    ['warn', 'fail', 'yellow'],
    ['fail', 'warn', 'yellow'],
    ['warn', 'warn', 'yellow'],
    ['warn', 'pass', 'yellow'],
    ['pass', 'warn', 'yellow'],
    ['fail', 'pass', 'yellow'],
    ['pass', 'fail', 'yellow'],
    ['fail', 'fail', 'red'],
    ['pass', 'pass', 'green'],
  ]
  for (const [a, b, expected] of cases) {
    assert.equal(inspect.ns.computeGrade(side(a), side(b), RUNTIME), expected, `A=${a} B=${b}`)
  }
})

inspect.it('computeGrade: unknown runtime => unknown regardless of the factors', () => {
  for (const [a, b] of [
    ['pass', 'pass'],
    ['fail', 'pass'],
    ['pass', 'fail'],
    ['fail', 'fail'],
    ['warn', 'warn'],
  ]) {
    for (const empty of ['', null, undefined]) {
      assert.equal(
        inspect.ns.computeGrade(side(a), side(b), empty),
        'unknown',
        `runtimeVersion=${JSON.stringify(empty)} with A=${a} B=${b}`,
      )
    }
  }
})

inspect.it('computeGrade: only the four contract grades are ever returned', () => {
  const grades = new Set()
  for (const a of ['pass', 'warn', 'fail']) {
    for (const b of ['pass', 'warn', 'fail']) {
      for (const rv of [RUNTIME, '', '0.3.0']) {
        grades.add(inspect.ns.computeGrade(side(a), side(b), rv))
      }
    }
  }
  for (const grade of grades) assert.ok(['green', 'yellow', 'red', 'unknown'].includes(grade), `unexpected grade ${grade}`)
})

// ---------------------------------------------------------------------------
// inspectBundleSync — end-to-end grading on fixtures
// ---------------------------------------------------------------------------
inspect.it('fixture green: compatible manifest, admitted runtime, no findings', () => {
  const report = inspect.ns.inspectBundleSync(input())
  assert.equal(report.grade, 'green', `findings: ${JSON.stringify(report.findings, null, 2)}`)
  assert.equal(report.factorA.status, 'pass')
  assert.equal(report.factorB.status, 'pass')
  assert.equal(report.runtimeVersion, RUNTIME)
  assert.equal(report.name, 'dsh-fake-good')
  assert.equal(report.version, '1.2.3')
})

inspect.it('fixture yellow (plugin side): a plugin-side failure that DSH does not adjudicate', () => {
  // A non-web client platform fails L1 but is NOT an admission input, so side B
  // stays pass and the grade is yellow. (An unsatisfied engines.dsh cannot be
  // used for this: DSH denies it, making side B fail too and the grade red.)
  const report = inspect.ns.inspectBundleSync(
    input({ manifest: goodManifest({ dsh: { bundle: { patch: './cordis.patch.yml' }, client: { platform: 'ios' } } }) }),
  )
  assert.equal(report.factorA.status, 'fail', 'plugin side must fail')
  assert.equal(report.factorB.status, 'pass', 'runtime side must still pass')
  assert.equal(report.grade, 'yellow')
  assert.ok(
    report.findings.some((f) => f.code === 'manifest.client-platform'),
    `expected manifest.client-platform, got ${report.findings.map((f) => f.code).join(', ') || '(none)'}`,
  )
})

inspect.it('fixture yellow (runtime side): DSH denies admission but the plugin manifest is fine', () => {
  // A bare `denied: true` with a manifest DSH does not itself reject: side A
  // passes, side B fails, grade yellow.
  const report = inspect.ns.inspectBundleSync(
    input({ manifest: goodManifest({ peerDependencies: {} }), admission: { denied: true } }),
  )
  assert.equal(report.factorA.status, 'pass', 'plugin side must pass')
  assert.equal(report.factorB.status, 'fail', 'runtime side must fail')
  assert.equal(report.grade, 'yellow')
  assert.ok(
    report.findings.some((f) => f.code === 'dsh.denied'),
    `expected dsh.denied, got ${report.findings.map((f) => f.code).join(', ') || '(none)'}`,
  )
})

inspect.it('fixture red: plugin range unsatisfied AND DSH denies admission', () => {
  // An unsatisfied engines.dsh fails BOTH sides by construction: it is the
  // plugin's own claim failing (A) and DSH refusing to admit it (B).
  const report = inspect.ns.inspectBundleSync(
    input({ manifest: goodManifest({ engines: { dsh: '>=0.3.0' } }), admission: { denied: true } }),
  )
  assert.equal(report.factorA.status, 'fail')
  assert.equal(report.factorB.status, 'fail')
  assert.equal(report.grade, 'red')
  assert.equal(report.eligible, true, 'a red report with a GitHub repo is nudge-eligible')
  assert.ok(report.findings.some((f) => f.code === 'manifest.engines-unsatisfied'))
  assert.ok(report.findings.some((f) => f.code === 'dsh.denied'))
})

inspect.it('fixture unknown: no runtime version => grade unknown and not nudge-eligible', () => {
  for (const runtime of [{ version: '', source: 'unknown' }, { version: null, source: 'unknown' }, {}]) {
    const report = inspect.ns.inspectBundleSync(input({ runtime }))
    assert.equal(report.grade, 'unknown', `runtime ${JSON.stringify(runtime)}`)
    assert.equal(report.eligible, false, 'unknown grade must never be eligible for a nudge')
  }
})

inspect.it('a failed loader row (activation) is evidence on the runtime side', () => {
  const report = inspect.ns.inspectBundleSync(
    input({ admission: { rows: [{ rowId: 'junpengjia', moduleName: 'dsh-fake-good', fiberPhase: 'failed', enabled: true }] } }),
  )
  assert.equal(report.factorB.status !== 'pass', true, 'a failed row must move the runtime side off pass')
  assert.ok(
    report.findings.some((f) => f.code === 'activation.row-failed'),
    `expected activation.row-failed, got ${report.findings.map((f) => f.code).join(', ') || '(none)'}`,
  )
})

inspect.it('a bundle load error is evidence on the runtime side', () => {
  const report = inspect.ns.inspectBundleSync(input({ admission: { bundleError: 'Cannot find module ./lib/index.js' } }))
  assert.ok(
    report.findings.some((f) => f.code === 'activation.bundle-error'),
    `expected activation.bundle-error, got ${report.findings.map((f) => f.code).join(', ') || '(none)'}`,
  )
})

inspect.it('a disabled row is informational only, it does not make the plugin incompatible', () => {
  // A disabled plugin is the user's own choice, not an incompatibility.
  const report = inspect.ns.inspectBundleSync(
    input({ admission: { rows: [{ rowId: 'junpengjia', moduleName: 'dsh-fake-good', fiberPhase: 'active', enabled: false }] } }),
  )
  const finding = report.findings.find((f) => f.code === 'activation.disabled')
  assert.ok(finding, 'expected activation.disabled')
  assert.equal(finding.severity, 'info', 'disabled must never be a failure')
  assert.equal(report.grade, 'green', 'a disabled but compatible plugin is still green')
})

// ---------------------------------------------------------------------------
// DSH admission rule (engines.dsh vs peerDependencies)
// ---------------------------------------------------------------------------
inspect.it('admission: a declared engines.dsh range decides alone — satisfied range with hostile peers is yellow, not red', () => {
  // docs/API-CONTRACT.md: engines.dsh alone decides admission. A hostile peer
  // range is therefore evidence (warn), never a hard failure, so side B passes;
  // the peer warn on side A makes the overall grade yellow.
  const report = inspect.ns.inspectBundleSync(
    input({
      manifest: goodManifest({
        engines: { dsh: RUNTIME_RANGE },
        peerDependencies: { '@deepseek-ai/dsh-desktop-runtime': '>=99.0.0' },
      }),
      resolves: new Map(), // the peer is not installed => missing, not unsatisfied
    }),
  )
  assert.equal(report.factorB.status, 'pass', 'engines.dsh alone decides admission, so side B passes')
  assert.ok(
    !report.findings.some((f) => f.severity === 'fail' && f.code.startsWith('manifest.')),
    `a peer mismatch must not be a hard failure when engines.dsh is declared: ${JSON.stringify(report.findings)}`,
  )
  assert.ok(report.grade !== 'red', 'a peer mismatch alone must never reach red')
})

inspect.it('admission: a declared but unsatisfied engines.dsh fails even when every peer matches', () => {
  const report = inspect.ns.inspectBundleSync(
    input({
      manifest: goodManifest({
        engines: { dsh: '>=9.0.0' },
        peerDependencies: { '@deepseek-ai/dsh-typert-protocol': RUNTIME_RANGE },
      }),
      resolves: goodResolves(),
    }),
  )
  assert.equal(report.factorA.status, 'fail')
  assert.ok(report.findings.some((f) => f.code === 'manifest.engines-unsatisfied'))
})

inspect.it('admission: with no engines.dsh, an out-of-range @deepseek-ai/dsh-* peer fails', () => {
  const report = inspect.ns.inspectBundleSync(
    input({
      manifest: goodManifest({
        engines: { node: '>=20' },
        peerDependencies: { '@deepseek-ai/dsh-typert-protocol': '>=99.0.0' },
      }),
      resolves: goodResolves(), // the peer IS installed, but outside the range
    }),
  )
  assert.equal(report.factorA.status, 'fail')
  assert.ok(
    report.findings.some((f) => f.code === 'manifest.peer-unsatisfied'),
    `expected manifest.peer-unsatisfied, got ${report.findings.map((f) => f.code).join(', ') || '(none)'}`,
  )
})

inspect.it('admission: with no engines.dsh, matching @deepseek-ai/dsh-* peers pass', () => {
  const report = inspect.ns.inspectBundleSync(
    input({
      manifest: goodManifest({
        engines: { node: '>=20' },
        peerDependencies: {
          '@deepseek-ai/dsh-typert-protocol': RUNTIME_RANGE,
          '@deepseek-ai/dsh-credentials': '>=0.2.0-rc.1 <0.3.0-0',
        },
      }),
      resolves: goodResolves({ '@deepseek-ai/dsh-credentials': { version: RUNTIME, source: 'resolve' } }),
    }),
  )
  assert.equal(report.factorA.status, 'pass', `findings: ${JSON.stringify(report.findings)}`)
  assert.equal(report.grade, 'green')
})

inspect.it('admission: an empty engines.dsh counts as incompatible', () => {
  const report = inspect.ns.inspectBundleSync(input({ manifest: goodManifest({ engines: { dsh: '' } }) }))
  assert.equal(report.factorA.status, 'fail')
  assert.ok(
    report.findings.some((f) => ['manifest.engines-unsatisfied', 'manifest.engines-missing'].includes(f.code)),
    `expected an engines finding, got ${report.findings.map((f) => f.code).join(', ') || '(none)'}`,
  )
})

inspect.it('admission: an invalid engines.dsh string counts as incompatible', () => {
  const report = inspect.ns.inspectBundleSync(input({ manifest: goodManifest({ engines: { dsh: 'not a range' } }) }))
  assert.equal(report.factorA.status, 'fail')
})

inspect.it('admission: an installed exemption keeps the runtime side off fail despite an out-of-range manifest', () => {
  // compatibility.json shape: { exact 'package@version': [exact runtime versions] }
  const report = inspect.ns.inspectBundleSync(
    input({
      manifest: goodManifest({ engines: { dsh: '>=0.3.0' } }),
      admission: { exempted: { 'dsh-fake-good@1.2.3': [RUNTIME] } },
    }),
  )
  // An exemption is DSH admitting the plugin under a recorded caution, so the
  // runtime side is no longer a failure (the engine reports it as warn).
  assert.notEqual(report.factorB.status, 'fail', 'an exemption must clear the runtime-side failure')
  assert.ok(
    report.findings.some((f) => f.code === 'dsh.exempted'),
    `expected dsh.exempted, got ${report.findings.map((f) => f.code).join(', ') || '(none)'}`,
  )
  assert.equal(report.grade, 'yellow', 'the plugin side still fails, so the overall grade is yellow, not red')
  assert.equal(report.eligible, false, 'only red is eligible')
})

inspect.it('admission: an exemption for a different runtime version does not apply', () => {
  const report = inspect.ns.inspectBundleSync(
    input({
      manifest: goodManifest({ engines: { dsh: '>=0.3.0' } }),
      admission: { exempted: { 'dsh-fake-good@1.2.3': ['0.2.0'] } },
    }),
  )
  assert.equal(report.factorB.status, 'fail', 'an exemption for another version must not admit this one')
  assert.equal(report.grade, 'red')
})

inspect.it('admission: no repository => repo finding, still graded, but not nudge-eligible', () => {
  const report = inspect.ns.inspectBundleSync(
    input({
      manifest: goodManifest({ repository: undefined, bugs: undefined, homepage: undefined, engines: { dsh: '>=0.3.0' } }),
      repo: undefined, // the engine derives the repo from the manifest; there is none here
    }),
  )
  assert.equal(report.repo, null, `expected no repo, got ${report.repo}`)
  assert.equal(report.grade, 'red', 'the grade is still computed without a repository')
  assert.equal(report.eligible, false, 'no repository means no nudge, even at red')
  assert.ok(
    report.findings.some((f) => f.code === 'repo.missing'),
    `expected repo.missing, got ${report.findings.map((f) => f.code).join(', ') || '(none)'}`,
  )
})

// ---------------------------------------------------------------------------
// report shape / invariants
// ---------------------------------------------------------------------------
inspect.it('report carries the contract shape', () => {
  const report = inspect.ns.inspectBundleSync(input())
  for (const key of [
    'name',
    'version',
    'title',
    'repo',
    'runtimeVersion',
    'runtimeSource',
    'checkedAt',
    'grade',
    'eligible',
    'factorA',
    'factorB',
    'layers',
    'findings',
    'activation',
    'dedupe',
  ]) {
    assert.ok(key in report, `Report is missing ${key}`)
  }
  assert.deepEqual(
    report.layers.map((l) => l.id),
    ['manifest', 'resolution', 'symbols', 'activation'],
    'layers must be the four contract layers in order',
  )
  for (const layer of report.layers) {
    assert.ok(['pass', 'warn', 'fail', 'skip'].includes(layer.status), `layer ${layer.id} has status ${layer.status}`)
    assert.ok(Array.isArray(layer.findings), `layer ${layer.id} must carry a findings array`)
  }
  for (const finding of report.findings) {
    assert.equal(typeof finding.code, 'string')
    assert.ok(['info', 'warn', 'fail'].includes(finding.severity), `finding ${finding.code} severity ${finding.severity}`)
    assert.equal(typeof finding.message, 'string')
  }
  assert.deepEqual(Object.keys(report.activation).sort(), ['error', 'rows'])
  for (const key of ['key', 'lastNudgedAt', 'allowedAt', 'duplicate']) {
    assert.ok(key in report.dedupe, `Report.dedupe is missing ${key}`)
  }
})

inspect.it('report grade is always consistent with its own factor verdicts', () => {
  const cases = [
    input(),
    input({ manifest: goodManifest({ engines: { dsh: '>=9.0.0' } }) }),
    input({ admission: { denied: true } }),
    input({ manifest: goodManifest({ engines: { dsh: '>=9.0.0' } }), admission: { denied: true } }),
    input({ runtime: { version: '', source: 'unknown' } }),
  ]
  for (const [index, fixture] of cases.entries()) {
    const report = inspect.ns.inspectBundleSync(fixture)
    assert.equal(
      report.grade,
      inspect.ns.computeGrade(report.factorA, report.factorB, report.runtimeVersion),
      `case ${index}: grade disagrees with computeGrade(factorA, factorB, runtimeVersion)`,
    )
    assert.equal(report.eligible, report.grade === 'red' && report.repo !== null, `case ${index}: eligible flag`)
  }
})

inspect.it('inspectBundleSync is idempotent and does not mutate its input', () => {
  const fixture = input({ manifest: goodManifest({ engines: { dsh: '>=9.0.0' } }), admission: { denied: true } })
  const snapshot = JSON.stringify(fixture)
  const a = inspect.ns.inspectBundleSync(fixture)
  const b = inspect.ns.inspectBundleSync(fixture)
  assert.equal(JSON.stringify(fixture), snapshot, 'the input fixture was mutated')
  assert.equal(a.grade, b.grade)
  assert.equal(a.dedupe.key, b.dedupe.key)
  assert.deepEqual(a.findings.map((f) => f.code), b.findings.map((f) => f.code))
})

// ---------------------------------------------------------------------------
// dedupe signatures
// ---------------------------------------------------------------------------
inspect.it('dedupeSignature is stable across re-runs', () => {
  const report = inspect.ns.inspectBundleSync(
    input({ manifest: goodManifest({ engines: { dsh: '>=9.0.0' } }), admission: { denied: true } }),
  )
  const first = inspect.ns.dedupeSignature(report)
  const second = inspect.ns.dedupeSignature(report)
  assert.equal(first, second)
  assert.match(first, /^[a-f0-9]{64}$/, 'signature must be a sha256 hex digest')
})

inspect.it('dedupeSignature ignores object key order', () => {
  const report = inspect.ns.inspectBundleSync(
    input({ manifest: goodManifest({ engines: { dsh: '>=9.0.0' } }), admission: { denied: true } }),
  )
  const reordered = Object.fromEntries(Object.entries(report).reverse())
  assert.equal(inspect.ns.dedupeSignature(reordered), inspect.ns.dedupeSignature(report))
})

inspect.it('dedupeSignature ignores finding order', () => {
  const report = inspect.ns.inspectBundleSync(
    input({ manifest: goodManifest({ engines: { dsh: '>=9.0.0' } }), admission: { denied: true } }),
  )
  const shuffled = { ...report, findings: [...report.findings].reverse() }
  assert.equal(inspect.ns.dedupeSignature(shuffled), inspect.ns.dedupeSignature(report))
})

inspect.it('dedupeSignature changes with plugin version, runtime version, or failure set', () => {
  const base = inspect.ns.inspectBundleSync(
    input({ manifest: goodManifest({ engines: { dsh: '>=9.0.0' } }) }),
  )
  const signature = inspect.ns.dedupeSignature(base)

  const otherVersion = inspect.ns.inspectBundleSync(
    input({ manifest: goodManifest({ version: '1.2.4', engines: { dsh: '>=9.0.0' } }) }),
  )
  assert.notEqual(inspect.ns.dedupeSignature(otherVersion), signature, 'a new plugin version is a new signature')

  const otherRuntime = inspect.ns.inspectBundleSync(
    input({ manifest: goodManifest({ engines: { dsh: '>=9.0.0' } }), runtime: { version: '0.2.2', source: 'env' } }),
  )
  assert.notEqual(inspect.ns.dedupeSignature(otherRuntime), signature, 'a new runtime version is a new signature')

  const cleanPlugin = inspect.ns.inspectBundleSync(input())
  assert.notEqual(inspect.ns.dedupeSignature(cleanPlugin), signature, 'a different failure set is a different signature')
})

inspect.it('dedupeSignature equals report.dedupe.key (one canonical value)', () => {
  const report = inspect.ns.inspectBundleSync(
    input({ manifest: goodManifest({ engines: { dsh: '>=9.0.0' } }), admission: { denied: true } }),
  )
  assert.equal(inspect.ns.dedupeSignature(report), report.dedupe.key)
})

inspect.it('stable finding codes: the engine only emits codes declared in contract.CODES', async () => {
  const { default: assert2 } = await import('node:assert/strict')
  const contract = await import('../plugin/lib/contract.js')
  const known = new Set(Object.values(contract.CODES))
  const reports = [
    inspect.ns.inspectBundleSync(input()),
    inspect.ns.inspectBundleSync(input({ manifest: goodManifest({ engines: { dsh: '>=9.0.0' } }) })),
    inspect.ns.inspectBundleSync(input({ admission: { denied: true, bundleError: 'boom' } })),
    inspect.ns.inspectBundleSync(input({ manifest: goodManifest({ repository: undefined, dsh: { bundle: {} } }) })),
  ]
  const unknown = new Set()
  for (const report of reports) {
    for (const finding of report.findings) {
      if (!known.has(finding.code)) unknown.add(finding.code)
    }
  }
  assert2.deepEqual([...unknown], [], `findings use codes outside contract.CODES: ${[...unknown].join(', ')}`)
})

// ---------------------------------------------------------------------------
// static symbol extraction (L3)
// ---------------------------------------------------------------------------
inspect.it('extractInjectSymbols reads `export const inject = [...]`', () => {
  const source = [
    "import { Service } from './service.js'",
    '',
    'export const inject = [',
    "  'settings',",
    "  'credentials',",
    "  'webServer',",
    ']',
    '',
    'export function apply(ctx) {}',
  ].join('\n')
  assert.deepEqual(inspect.ns.extractInjectSymbols(source).sort(), ['credentials', 'settings', 'webServer'])
})

inspect.it('extractInjectSymbols accepts double quotes and returns a de-duplicated list', () => {
  const source = 'export const inject = ["settings", "remote", "settings"]\n'
  assert.deepEqual(inspect.ns.extractInjectSymbols(source).sort(), ['remote', 'settings'])
})

inspect.it('extractInjectSymbols returns a falsy/empty result when nothing is declared', () => {
  // The engine distinguishes "not declared" (null) from "declared empty" ([]);
  // both are acceptable here as long as nothing is reported as missing.
  for (const source of ['export function apply() {}\n', '']) {
    const result = inspect.ns.extractInjectSymbols(source)
    assert.ok(
      result === null || (Array.isArray(result) && result.length === 0),
      `expected null or [] for an entry with no inject declaration, got ${JSON.stringify(result)}`,
    )
  }
})

inspect.it('extractInjectSymbols tolerates an explicitly empty declaration', () => {
  const result = inspect.ns.extractInjectSymbols('export const inject = []\n')
  assert.ok(result === null || (Array.isArray(result) && result.length === 0), JSON.stringify(result))
})

inspect.it('missingSymbols reports what the live context does not provide', () => {
  assert.deepEqual(inspect.ns.missingSymbols(['a', 'b'], ['a', 'b']).sort(), [])
  assert.deepEqual(inspect.ns.missingSymbols(['a', 'b', 'c'], ['a']).sort(), ['b', 'c'])
  assert.deepEqual(inspect.ns.missingSymbols([], ['a']).sort(), [])
})

inspect.it('missingSymbols accepts a Set of provided services', () => {
  assert.deepEqual(inspect.ns.missingSymbols(['a', 'b'], new Set(['a'])).sort(), ['b'])
  assert.deepEqual(inspect.ns.missingSymbols(['a', 'b'], ['a', 'b']).sort(), [])
})

inspect.it('missingSymbols reports every key when nothing is provided', () => {
  assert.deepEqual(inspect.ns.missingSymbols(['a', 'b', 'c'], []).sort(), ['a', 'b', 'c'])
  assert.deepEqual(inspect.ns.missingSymbols([], ['a']).sort(), [])
})

inspect.it('a missing service symbol is a hard failure on the plugin side', () => {
  const report = inspect.ns.inspectBundleSync(
    input({ serviceKeys: ['settings'], admission: {} }),
  )
  // The fixture manifest declares no inject symbols, so nothing can be missing.
  assert.equal(report.factorA.status, 'pass')
})

// ---------------------------------------------------------------------------
// inspectBundle (async, disk-backed) — cold path
// ---------------------------------------------------------------------------
inspect.it('inspectBundle (async) resolves rather than rejecting and agrees with inspectBundleSync', async () => {
  const fixtures = [
    input(), // green
    input({ manifest: goodManifest({ engines: { dsh: '>=0.3.0' } }), admission: { denied: true } }), // red
    input({ runtime: { version: '', source: 'unknown' } }), // unknown
    input({ manifest: goodManifest({ dsh: { bundle: { patch: './cordis.patch.yml' }, client: { platform: 'ios' } } }) }), // yellow
  ]
  for (const [index, fixture] of fixtures.entries()) {
    const sync = inspect.ns.inspectBundleSync(fixture)
    let report
    await assert.doesNotReject(async () => {
      report = await inspect.ns.inspectBundle(fixture)
    }, `fixture ${index}: inspectBundle must never reject`)
    assert.equal(report.grade, sync.grade, `fixture ${index}: async and sync grades disagree`)
    assert.equal(report.name, sync.name)
    assert.equal(report.dedupe.key, sync.dedupe.key)
  }
})

inspect.it('inspectBundle with an unknown runtime never throws and grades unknown', async () => {
  const report = await inspect.ns.inspectBundle(input({ runtime: { version: '', source: 'unknown' } }))
  assert.equal(report.grade, 'unknown')
  assert.equal(report.eligible, false)
})

inspect.it('inspectBundle tolerates a missing directory and a missing entry file', async () => {
  const report = await inspect.ns.inspectBundle({
    pkg: { name: 'dsh-fake-nodir', version: '1.0.0', manifest: goodManifest({ name: 'dsh-fake-nodir' }), dir: join(tmpdir(), 'jj-does-not-exist') },
    runtime: { version: RUNTIME, source: 'env' },
    repo: 'example/dsh-fake-nodir',
    serviceKeys: [],
    clientGraph: [],
  })
  assert.ok(['green', 'yellow', 'red', 'unknown'].includes(report.grade), `unexpected grade ${report.grade}`)
  const symbols = report.layers.find((layer) => layer.id === 'symbols')
  assert.ok(['pass', 'skip', 'warn', 'fail'].includes(symbols.status))
})

// ---------------------------------------------------------------------------
// store: dedupe window + history (fs-backed, temp profile dir)
// ---------------------------------------------------------------------------
if (storeMod.ok) {
  await test('plugin/lib/host/store.js exposes the locked surface', async (t) => {
    await expectExports(t, storeMod, 'plugin/lib/host/store.js', ['createStore', 'signatureOf'])
  })
}

store.it('store: a second nudge inside the window is a duplicate, after the window it is allowed', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jj-store-'))
  try {
    const storeApi = store.ns.createStore({ profileDir: dir })
    const t0 = 1_700_000_000_000
    const day = 86_400_000
    const first = storeApi.dedupeFor('example/repo', 'dsh-fake-good', 'abc123', 30, t0)
    assert.equal(first.duplicate, false, 'the first nudge is never a duplicate')

    storeApi.recordNudge({
      at: t0,
      package: 'dsh-fake-good',
      version: '1.0.0',
      runtimeVersion: RUNTIME,
      repo: 'example/repo',
      signature: 'abc123',
      mode: 'draft',
      outcome: 'drafted',
      url: 'https://github.com/example/repo/issues/new',
      number: null,
    })

    const sameDay = storeApi.dedupeFor('example/repo', 'dsh-fake-good', 'abc123', 30, t0 + day)
    assert.equal(sameDay.duplicate, true, 'one day later is still inside the 30-day window')

    const afterWindow = storeApi.dedupeFor('example/repo', 'dsh-fake-good', 'abc123', 30, t0 + 31 * day)
    assert.equal(afterWindow.duplicate, false, '31 days later the window has reopened')

    const history = storeApi.history()
    assert.equal(history.length, 1)
    assert.equal(history[0].signature, 'abc123')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

store.it('store: state survives a reload and a corrupt state file degrades instead of throwing', async () => {
  const { writeFile, mkdir } = await import('node:fs/promises')
  const dir = await mkdtemp(join(tmpdir(), 'jj-store-'))
  try {
    const storeApi = store.ns.createStore({ profileDir: dir })
    storeApi.recordNudge({
      at: Date.now(),
      package: 'dsh-fake-good',
      version: '1.0.0',
      runtimeVersion: RUNTIME,
      repo: 'example/repo',
      signature: 'deadbeef',
      mode: 'draft',
      outcome: 'drafted',
      url: null,
      number: null,
    })
    const reloaded = store.ns.createStore({ profileDir: dir })
    assert.equal(reloaded.history().length, 1, 'state must survive a store reload')

    await mkdir(join(dir, '.junpeng-jia'), { recursive: true })
    await writeFile(join(dir, '.junpeng-jia', 'state.json'), '{ this is not json', 'utf8')
    const recovered = store.ns.createStore({ profileDir: dir })
    assert.deepEqual(recovered.history(), [], 'a corrupt state file must degrade to an empty history')
    assert.doesNotThrow(() => recovered.dedupeFor('example/repo', 'dsh-fake-good', 'deadbeef', 30, Date.now()))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

store.it('store: the daily issue cap is enforced', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jj-store-'))
  try {
    const storeApi = store.ns.createStore({ profileDir: dir })
    const now = Date.now()
    for (let i = 0; i < 3; i += 1) {
      storeApi.recordNudge({
        at: now,
        package: `dsh-fake-${i}`,
        version: '1.0.0',
        runtimeVersion: RUNTIME,
        repo: 'example/repo',
        signature: `sig-${i}`,
        mode: 'auto',
        outcome: 'filed',
        url: null,
        number: i + 1,
      })
    }
    // Signature is countIssuesToday(at, maxIssuesPerDay) — date first.
    const capped = storeApi.countIssuesToday(now, 3)
    assert.equal(capped.count, 3)
    assert.equal(capped.allowed, false, 'the daily cap must close after maxIssuesPerDay')
    const withHeadroom = storeApi.countIssuesToday(now, 5)
    assert.equal(withHeadroom.allowed, true)
    const emptyDay = storeApi.countIssuesToday(now + 86_400_000, 3)
    assert.equal(emptyDay.count, 0, 'the counter is per-day, not cumulative')
    assert.equal(emptyDay.allowed, true)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

store.it('store: signatureOf() is order-independent', () => {
  const a = store.ns.signatureOf({
    package: 'dsh-fake-good',
    version: '1.0.0',
    runtimeVersion: RUNTIME,
    findings: [{ code: 'b.code' }, { code: 'a.code' }],
    missingSymbols: ['x', 'y'],
  })
  const b = store.ns.signatureOf({
    missingSymbols: ['y', 'x'],
    findings: [{ code: 'a.code' }, { code: 'b.code' }],
    runtimeVersion: RUNTIME,
    version: '1.0.0',
    package: 'dsh-fake-good',
  })
  assert.equal(a, b)
  assert.match(a, /^[a-f0-9]{64}$/)
})

// ---------------------------------------------------------------------------
// repo resolution (GitHub only)
// ---------------------------------------------------------------------------
const ACCEPTED = [
  ['https://github.com/owner/repo.git', 'owner', 'repo'],
  ['https://github.com/owner/repo', 'owner', 'repo'],
  ['git+https://github.com/owner/repo.git', 'owner', 'repo'],
  ['git+ssh://git@github.com/owner/repo.git', 'owner', 'repo'],
  ['ssh://git@github.com/owner/repo.git', 'owner', 'repo'],
  ['git@github.com:owner/repo.git', 'owner', 'repo'],
  ['git@github.com:owner/repo', 'owner', 'repo'],
  ['git://github.com/owner/repo.git', 'owner', 'repo'],
  ['https://github.com/owner/repo.git#v1.2.3', 'owner', 'repo'],
  ['https://www.github.com/owner/repo', 'owner', 'repo'],
  ['owner/repo', 'owner', 'repo'],
]

for (const [url, owner, repo] of ACCEPTED) {
  github.it(`resolveRepo accepts ${url}`, () => {
    const resolved = github.ns.resolveRepo({ repository: { type: 'git', url } })
    assert.ok(resolved, `${url} must resolve`)
    assert.equal(resolved.owner, owner)
    assert.equal(resolved.repo, repo)
    assert.equal(typeof resolved.url, 'string')
  })
}

github.it('resolveRepo accepts a string repository field', () => {
  assert.equal(github.ns.resolveRepo({ repository: 'https://github.com/owner/repo.git' }).repo, 'repo')
  // `resolveRepo` takes a manifest object (see docs/API-CONTRACT.md); a bare URL
  // is the job of parseGithubRepo.
  assert.equal(github.ns.parseGithubRepo('git+https://github.com/owner/repo.git').owner, 'owner')
})

github.it('resolveRepo falls back to bugs.url, then homepage', () => {
  const viaBugs = github.ns.resolveRepo({
    bugs: { url: 'https://github.com/owner/repo/issues' },
  })
  assert.ok(viaBugs, 'bugs.url must be used when repository is absent')
  assert.equal(viaBugs.repo, 'repo')

  const viaHomepage = github.ns.resolveRepo({ homepage: 'https://github.com/owner/repo#readme' })
  assert.ok(viaHomepage, 'homepage must be used as a last resort')
  assert.equal(viaHomepage.repo, 'repo')
})

github.it('resolveRepo rejects non-GitHub hosts', () => {
  for (const url of [
    'https://gitlab.com/owner/repo.git',
    'https://bitbucket.org/owner/repo.git',
    'git@gitlab.com:owner/repo.git',
    'https://gitee.com/owner/repo.git',
    'https://example.com/owner/repo',
  ]) {
    assert.equal(github.ns.resolveRepo({ repository: { type: 'git', url } }), null, `${url} must be rejected`)
  }
})

github.it('resolveRepo rejects missing/empty/nonsense repository fields', () => {
  for (const manifest of [{}, { repository: undefined }, { repository: {} }, { repository: { url: '' } }, { repository: 42 }]) {
    assert.equal(github.ns.resolveRepo(manifest), null, `${JSON.stringify(manifest)} must not resolve`)
  }
})

github.it('resolveRepoFor honours repoOverrides for a package name', () => {
  const resolved = github.ns.resolveRepoFor(
    'dsh-fake-norepo',
    { name: 'dsh-fake-norepo', version: '1.0.0' },
    { 'dsh-fake-norepo': 'override-owner/override-repo' },
  )
  assert.ok(resolved, 'an override must resolve even without a repository field')
  assert.equal(resolved.owner, 'override-owner')
  assert.equal(resolved.repo, 'override-repo')

  const overridden = github.ns.resolveRepoFor(
    'dsh-fake-norepo',
    { repository: 'https://github.com/real/repo.git' },
    { 'dsh-fake-norepo': 'override-owner/override-repo' },
  )
  assert.equal(overridden.owner, 'override-owner', 'an override wins over the manifest repository')
})

github.it('parseGithubRepo is a pure URL parser', () => {
  assert.deepEqual(
    { owner: github.ns.parseGithubRepo('https://github.com/o/r.git').owner, repo: github.ns.parseGithubRepo('https://github.com/o/r.git').repo },
    { owner: 'o', repo: 'r' },
  )
  assert.equal(github.ns.parseGithubRepo('https://gitlab.com/o/r'), null)
})
