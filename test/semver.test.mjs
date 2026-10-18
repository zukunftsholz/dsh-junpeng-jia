// Semver range semantics required by DSH's own admission rule.
//
// DSH (via @deepseek-ai/dsh-app-boot) resolves `engines.dsh` and the
// `@deepseek-ai/*` peer ranges with PRERELEASES PARTICIPATING in range matching.
// That differs from strict node-semver, so these cases are the specification
// the host engine must satisfy — not node-semver's output.
//
// Canonical run: node --test "test/*.test.mjs"

import test from 'node:test'
import assert from 'node:assert/strict'
import { hostModule, moduleSuite, expectExports } from './_helpers.mjs'

const mod = await hostModule('semver')
const semver = moduleSuite(mod, 'plugin/lib/host/semver.js')

const deps = ['satisfies', 'compare', 'parse', 'validRange']

if (mod.ok) {
  await test('plugin/lib/host/semver.js exports the locked surface', async (t) => {
    await expectExports(t, mod, 'plugin/lib/host/semver.js', deps)
  })
}

// ---------------------------------------------------------------------------
// Table-driven: [version, range, expected, why]
// ---------------------------------------------------------------------------
const SATISFIES_CASES = [
  // exact / equality
  ['1.2.3', '1.2.3', true, 'exact version'],
  ['1.2.3', '=1.2.3', true, 'explicit equals'],
  ['1.2.4', '1.2.3', false, 'exact version differs'],
  ['1.2.3', 'v1.2.3', true, 'leading v on the range is tolerated'],

  // primitive comparators
  ['1.2.4', '>1.2.3', true, 'greater than'],
  ['1.2.3', '>1.2.3', false, 'greater than is strict'],
  ['1.2.3', '>=1.2.3', true, 'greater or equal at the boundary'],
  ['1.2.2', '<1.2.3', true, 'less than'],
  ['1.2.3', '<1.2.3', false, 'less than is strict'],
  ['1.2.3', '<=1.2.3', true, 'less or equal at the boundary'],
  ['1.3.0', '<=1.2.3', false, 'less or equal above the boundary'],

  // caret
  ['1.2.3', '^1.2.3', true, 'caret at the lower bound'],
  ['1.9.9', '^1.2.3', true, 'caret stays inside the major'],
  ['2.0.0', '^1.2.3', false, 'caret excludes the next major'],
  ['1.2.2', '^1.2.3', false, 'caret below the lower bound'],
  ['0.2.5', '^0.2.3', true, '0.x caret stays inside the minor'],
  ['0.3.0', '^0.2.3', false, '0.x caret excludes the next minor'],
  ['0.0.3', '^0.0.3', true, '0.0.x caret matches exactly'],
  ['0.0.4', '^0.0.3', false, '0.0.x caret excludes any other patch'],

  // tilde
  ['4.0.5', '~4.0.5', true, 'tilde matches the exact patch (spec case)'],
  ['4.1.0', '~4.0.5', false, 'tilde excludes the next minor (spec case)'],
  ['4.0.9', '~4.0.5', true, 'tilde stays inside the patch range'],
  ['4.0.5', '~4.0', true, 'partial tilde 4.0 := >=4.0.0 <4.1.0'],
  ['4.1.0', '~4.0', false, 'partial tilde 4.0 excludes 4.1.0'],
  ['4.5.0', '~4', true, 'tilde on a bare major allows every minor'],
  ['4.0.5', '~4', true, 'tilde on a major'],
  ['5.0.0', '~4', false, 'tilde on a major excludes the next major'],

  // wildcard / partial
  ['1.2.3', '*', true, 'star matches any release'],
  ['1.2.3', 'x', true, 'x wildcard'],
  ['1.2.3', 'X', true, 'uppercase X wildcard'],
  ['1.2.3', '1.x', true, 'major wildcard'],
  ['1.2.3', '1.2.x', true, 'minor wildcard'],
  ['1.3.0', '1.2.x', false, 'minor wildcard excludes other minors'],
  ['2.0.0', '1.x.x', false, 'major wildcard excludes other majors'],
  ['1.2.3', '1', true, 'bare major is a wildcard minor/patch'],
  ['1.2.3', '1.2', true, 'bare minor is a wildcard patch'],
  ['2.0.0', '1', false, 'bare major excludes other majors'],

  // hyphen ranges
  ['1.2.3', '1.2.3 - 2.3.4', true, 'hyphen at the lower bound'],
  ['2.3.4', '1.2.3 - 2.3.4', true, 'hyphen at the upper bound (inclusive)'],
  ['2.3.5', '1.2.3 - 2.3.4', false, 'hyphen above the upper bound'],
  ['1.2.2', '1.2.3 - 2.3.4', false, 'hyphen below the lower bound'],
  ['1.5.0', '1.2 - 2.3', true, 'partial hyphen range'],
  ['1.2.0', '1.2 - 2.3', true, 'partial hyphen lower bound'],
  ['2.3.9', '1.2 - 2.3', true, 'partial hyphen upper bound is <2.4.0'],
  ['2.4.0', '1.2 - 2.3', false, 'partial hyphen upper bound is exclusive above the minor'],
  ['2.9.9', '1.2.3 - 2', true, 'hyphen with a bare major upper bound'],
  ['3.0.0', '1.2.3 - 2', false, 'bare major hyphen upper bound is <3.0.0'],

  // OR sets
  ['1.2.3', '^1.0.0 || ^2.0.0', true, 'first alternative'],
  ['2.5.0', '^1.0.0 || ^2.0.0', true, 'second alternative'],
  ['3.0.0', '^1.0.0 || ^2.0.0', false, 'no alternative matches'],
  ['0.3.0', '<=0.1.0 || >=0.3.0 <0.4.0', true, 'second alternative with a bounded pair'],
  ['0.2.0', '<=0.1.0 || >=0.3.0 <0.4.0', false, 'between the alternatives'],

  // prerelease participation (DSH semantics, not strict node-semver)
  ['0.2.1-rc.2', '>=0.2.0-rc.1 <0.3.0-0', true, 'spec: rc.2 satisfies the DSH engine range'],
  ['0.3.0-0', '>=0.2.0-rc.1 <0.3.0-0', false, 'spec: exclusive upper bound rejects 0.3.0-0'],
  ['0.2.0-rc.1', '>=0.2.0-rc.1', true, 'spec: lower bound includes its own prerelease'],
  ['0.2.1-rc.2', '<0.3.0-0', true, 'prerelease below an exclusive prerelease bound'],
  ['0.2.0-alpha', '>=0.2.0-rc.1', false, 'alpha sorts below rc'],
  ['0.2.5', '>=0.2.0-rc.1 <0.3.0-0', true, 'plain release inside a prerelease-bounded range'],
  ['1.0.0-rc.2', '^1.0.0-rc.1', true, 'caret with a prerelease floor'],
  ['2.0.0-rc.1', '^1.0.0-rc.1', false, 'caret with a prerelease floor still stops at the next major'],
  ['1.0.0', '>1.0.0-rc.1', true, 'release sorts above its own prerelease'],
  ['1.0.0-rc.1', '>1.0.0', false, 'prerelease does not sort above its release'],
  ['1.2.3-rc.1', '>=1.0.0 <2.0.0', true, 'prerelease participates in a plain range'],

  // build metadata is ignored for ordering and matching
  ['1.2.3+build.5', '1.2.3', true, 'build metadata is ignored'],
  ['1.2.3+build.5', '^1.0.0', true, 'build metadata with a caret'],
]

for (const [version, range, expected, why] of SATISFIES_CASES) {
  semver.it(`satisfies(${JSON.stringify(version)}, ${JSON.stringify(range)}) === ${expected} — ${why}`, () => {
    assert.equal(semver.ns.satisfies(version, range), expected)
  })
}

// ---------------------------------------------------------------------------
// Spec-mandated assertions, named individually so they are visible in reports
// ---------------------------------------------------------------------------
semver.it("spec: '0.2.1-rc.2' satisfies '>=0.2.0-rc.1 <0.3.0-0'", () => {
  assert.equal(semver.ns.satisfies('0.2.1-rc.2', '>=0.2.0-rc.1 <0.3.0-0'), true)
})

semver.it("spec: '~4.0.5' matches '4.0.5'", () => {
  assert.equal(semver.ns.satisfies('4.0.5', '~4.0.5'), true)
})

semver.it("spec: '~4.0.5' does not match '4.1.0'", () => {
  assert.equal(semver.ns.satisfies('4.1.0', '~4.0.5'), false)
})

semver.it("spec: '0.3.0-0' does not satisfy '>=0.2.0-rc.1 <0.3.0-0'", () => {
  assert.equal(semver.ns.satisfies('0.3.0-0', '>=0.2.0-rc.1 <0.3.0-0'), false)
})

semver.it("spec: '0.2.0-rc.1' satisfies '>=0.2.0-rc.1'", () => {
  assert.equal(semver.ns.satisfies('0.2.0-rc.1', '>=0.2.0-rc.1'), true)
})

// ---------------------------------------------------------------------------
// prerelease ordering chain
// ---------------------------------------------------------------------------
semver.it('prerelease identifiers order per semver: alpha < alpha.1 < alpha.beta < beta < beta.2 < beta.11 < rc.1 < release', () => {
  const chain = [
    '1.0.0-alpha',
    '1.0.0-alpha.1',
    '1.0.0-alpha.beta',
    '1.0.0-beta',
    '1.0.0-beta.2',
    '1.0.0-beta.11',
    '1.0.0-rc.1',
    '1.0.0',
  ]
  for (let i = 1; i < chain.length; i += 1) {
    assert.equal(
      semver.ns.compare(chain[i - 1], chain[i]),
      -1,
      `${chain[i - 1]} must sort before ${chain[i]}`,
    )
    assert.equal(
      semver.ns.compare(chain[i], chain[i - 1]),
      1,
      `${chain[i]} must sort after ${chain[i - 1]}`,
    )
  }
})

semver.it('compare() is 0 for equal versions and ignores build metadata', () => {
  assert.equal(semver.ns.compare('1.2.3', '1.2.3'), 0)
  assert.equal(semver.ns.compare('1.2.3+abc', '1.2.3+xyz'), 0)
})

// ---------------------------------------------------------------------------
// parse()
// ---------------------------------------------------------------------------
semver.it('parse() splits major/minor/patch/prerelease/build', () => {
  const parsed = semver.ns.parse('1.2.3-rc.1+build.7')
  assert.deepEqual(
    { major: parsed.major, minor: parsed.minor, patch: parsed.patch, raw: parsed.raw },
    { major: 1, minor: 2, patch: 3, raw: '1.2.3-rc.1+build.7' },
  )
  // Numeric prerelease/build identifiers may be exposed as numbers or strings;
  // compare their string forms so either encoding is accepted.
  assert.deepEqual(parsed.prerelease.map(String), ['rc', '1'])
  assert.deepEqual(parsed.build.map(String), ['build', '7'])
})

semver.it('parse() yields empty prerelease/build arrays for a plain release', () => {
  const parsed = semver.ns.parse('1.2.3')
  assert.equal(parsed.prerelease.length, 0)
  assert.equal(parsed.build.length, 0)
})

semver.it('parse() returns null for a non-version', () => {
  assert.equal(semver.ns.parse('not-a-version'), null)
  assert.equal(semver.ns.parse(''), null)
})

// ---------------------------------------------------------------------------
// validRange()
// ---------------------------------------------------------------------------
semver.it('validRange() accepts the ranges used by this plugin', () => {
  for (const range of ['>=0.2.0-rc.1 <0.3.0-0', '~4.0.5', '~3.18.5', '^1.2.3', '1.2.3 - 2.3.4', '*', '1.x']) {
    assert.equal(semver.ns.validRange(range), true, `${JSON.stringify(range)} must be a valid range`)
  }
})

semver.it('validRange() rejects nonsense', () => {
  assert.equal(semver.ns.validRange('not a range'), false)
  assert.equal(semver.ns.validRange('>=banana'), false)
})

// An empty range is NOT "any version" here: DSH treats an empty or invalid
// engines.dsh as incompatible, so validRange('')/satisfies(v, '') must be false.
// Callers that mean "any" must use '*'.
semver.it("empty / whitespace-only range is invalid, not a wildcard (DSH admission rule)", () => {
  for (const range of ['', '   ', '\t', null, undefined]) {
    assert.equal(semver.ns.validRange(range), false, `validRange(${JSON.stringify(range)}) must be false`)
    assert.equal(semver.ns.satisfies('1.2.3', range), false, `satisfies('1.2.3', ${JSON.stringify(range)}) must be false`)
  }
  assert.equal(semver.ns.validRange('*'), true, 'the explicit wildcard still works')
  assert.equal(semver.ns.satisfies('1.2.3', '*'), true)
})

// ---------------------------------------------------------------------------
// robustness: never throw on junk input
// ---------------------------------------------------------------------------
semver.it('satisfies() returns false (never throws) for invalid versions or ranges', () => {
  for (const [version, range] of [
    ['not-a-version', '^1.0.0'],
    ['1.2.3', 'not a range'],
    ['', '^1.0.0'],
    ['1.2.3', '>=banana'],
  ]) {
    assert.doesNotThrow(() => semver.ns.satisfies(version, range))
    assert.equal(semver.ns.satisfies(version, range), false, `${version} vs ${range}`)
  }
})

// ---------------------------------------------------------------------------
// the ranges this plugin actually ships in plugin/package.json
// ---------------------------------------------------------------------------
test(
  'plugin/package.json declared ranges accept the observed runtime versions',
  { skip: semver.skipReason },
  async () => {
    const { readFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const { PLUGIN_DIR } = await import('./_helpers.mjs')
    const pkg = JSON.parse(readFileSync(join(PLUGIN_DIR, 'package.json'), 'utf8'))
    assert.equal(semver.ns.satisfies('0.2.1-rc.2', pkg.engines.dsh), true, 'engines.dsh must accept 0.2.1-rc.2')
    assert.equal(semver.ns.satisfies('0.3.0', pkg.engines.dsh), false, 'engines.dsh must reject 0.3.0')
    for (const [name, range] of Object.entries(pkg.peerDependencies)) {
      assert.equal(semver.ns.validRange(range), true, `peer dependency ${name} has an unparseable range: ${range}`)
    }
  },
)
