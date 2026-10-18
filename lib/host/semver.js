// Zero-dependency semver range evaluation.
//
// Why not `semver` from npm: the Host half must not add a runtime dependency to
// a zero-build plugin, and the profile's node_modules only guarantees what the
// runtime fallback provides. This module is pure, synchronous, and unit-testable
// with `node --test` and no resolution shim.
//
// Deliberate deviation from node-semver, on purpose:
//   * Prereleases participate in range matching exactly like releases.
//     node-semver excludes a prerelease unless a comparator in the same tuple
//     mentions one; DSH's own admission ("engines.dsh" checked against the
//     running version, e.g. 0.2.1-rc.2) does NOT do that, so mirroring
//     node-semver here would make our grade contradict the runtime.
//     => satisfies('0.2.1-rc.2', '>=0.2.0-rc.1 <0.3.0-0') === true
//   * An empty range is NOT a wildcard. DSH treats an empty or invalid
//     `engines.dsh` as incompatible, so `satisfies(v, '')` is false and
//     `validRange('')` is false. Use '*' or 'x' for "any version".
//
// Supported syntax: exact versions, `=`, `>`, `>=`, `<`, `<=`, `^`, `~`,
// wildcards (`*`, `x`, `X`) and partial versions (`1`, `1.2`, `1.2.x`),
// hyphen ranges (`1.2.3 - 2.3.4`), and `||` alternatives. Build metadata is
// ignored for ordering and equality (semver §10).

const PARTIAL_RE = /^v?(\d+|[xX*])(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/
const EXACT_RE = /^\s*[=v]?\s*(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?\s*$/

const isWild = (part) => part === undefined || part === 'x' || part === 'X' || part === '*'

/**
 * Parse a full version string.
 * @param {string} version
 * @returns {{major:number,minor:number,patch:number,prerelease:Array<string|number>,build:string[],raw:string}|null}
 */
export function parse(version) {
  if (typeof version !== 'string') return null
  const m = EXACT_RE.exec(version)
  if (!m) return null
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    prerelease: m[4] ? m[4].split('.').map((id) => (/^\d+$/.test(id) ? Number(id) : id)) : [],
    build: m[5] ? m[5].split('.') : [],
    raw: version.trim(),
  }
}

/** True when `version` is a full, parseable semver version. */
export function isValid(version) {
  return parse(version) !== null
}

function compareIdentifiers(a, b) {
  const an = typeof a === 'number'
  const bn = typeof b === 'number'
  if (an && bn) return a === b ? 0 : a < b ? -1 : 1
  // Numeric identifiers always have lower precedence than alphanumeric ones.
  if (an) return -1
  if (bn) return 1
  return a === b ? 0 : a < b ? -1 : 1
}

function comparePrerelease(a, b) {
  if (a.length === 0 && b.length === 0) return 0
  if (a.length === 0) return 1 // a release outranks any prerelease
  if (b.length === 0) return -1
  const len = Math.min(a.length, b.length)
  for (let i = 0; i < len; i++) {
    const result = compareIdentifiers(a[i], b[i])
    if (result !== 0) return result
  }
  return a.length === b.length ? 0 : a.length < b.length ? -1 : 1
}

/**
 * Compare two full versions. Throws on unparseable input (programmer error);
 * `satisfies` never throws.
 * @returns {number} -1 | 0 | 1
 */
export function compare(a, b) {
  const va = typeof a === 'string' ? parse(a) : a
  const vb = typeof b === 'string' ? parse(b) : b
  if (!va || !vb) throw new TypeError(`semver.compare: invalid version (${String(a)} / ${String(b)})`)
  if (va.major !== vb.major) return va.major < vb.major ? -1 : 1
  if (va.minor !== vb.minor) return va.minor < vb.minor ? -1 : 1
  if (va.patch !== vb.patch) return va.patch < vb.patch ? -1 : 1
  return comparePrerelease(va.prerelease, vb.prerelease)
}

/**
 * Sort helper (ascending) for `Array.prototype.sort`.
 */
export function rcompare(a, b) {
  return compare(b, a)
}

function partial(text) {
  const m = PARTIAL_RE.exec(text)
  if (!m) return null
  return {
    major: isWild(m[1]) ? null : Number(m[1]),
    minor: isWild(m[2]) ? null : Number(m[2]),
    patch: isWild(m[3]) ? null : Number(m[3]),
    prerelease: m[4] ? m[4].split('.').map((id) => (/^\d+$/.test(id) ? Number(id) : id)) : [],
  }
}

function v(major, minor, patch, prerelease = []) {
  return { major, minor, patch, prerelease, build: [] }
}

const ZERO = 0

/** Lower bound of a partial: `1.2` => 1.2.0, `1` => 1.0.0. Returns null for wildcards. */
function lowerOf(p) {
  if (p.major === null) return null
  return v(p.major, p.minor ?? ZERO, p.patch ?? ZERO, p.patch === null ? [] : p.prerelease)
}

/** Exclusive upper bound: the first version past `p`. `1.2` => 1.3.0-0, `1` => 2.0.0-0. */
function upperOf(p) {
  if (p.major === null) return null
  if (p.minor === null) return v(p.major + 1, 0, 0, [0])
  if (p.patch === null) return v(p.major, p.minor + 1, 0, [0])
  return null
}

/**
 * Translate one token into primitive comparators.
 * @returns {Array<{op:string,version?:object}>|null} null means "invalid token"
 */
function comparatorsOf(token) {
  const text = token.trim()
  if (text === '' || text === '*' || text === 'x' || text === 'X') return [{ op: 'any' }]

  let op = ''
  let rest = text
  if (rest.startsWith('>=') || rest.startsWith('<=')) {
    op = rest.slice(0, 2)
    rest = rest.slice(2)
  } else if (rest[0] === '>' || rest[0] === '<' || rest[0] === '=') {
    op = rest[0]
    rest = rest.slice(1)
  } else if (rest[0] === '^' || rest[0] === '~') {
    op = rest[0]
    rest = rest.slice(1)
  }

  const p = partial(rest.trim())
  if (!p) return null

  if (op === '^') {
    if (p.major === null) return [{ op: 'any' }]
    const low = lowerOf(p)
    let high
    if (p.minor === null) high = v(p.major + 1, 0, 0, [0])
    else if (p.patch === null) high = p.major > 0 ? v(p.major + 1, 0, 0, [0]) : v(0, p.minor + 1, 0, [0])
    else if (p.major > 0) high = v(p.major + 1, 0, 0, [0])
    else if (p.minor > 0) high = v(0, p.minor + 1, 0, [0])
    else high = v(0, 0, p.patch + 1, [0])
    return [{ op: '>=', version: low }, { op: '<', version: high }]
  }

  if (op === '~') {
    if (p.major === null) return [{ op: 'any' }]
    const low = lowerOf(p)
    const high = p.minor === null ? v(p.major + 1, 0, 0, [0]) : v(p.major, p.minor + 1, 0, [0])
    return [{ op: '>=', version: low }, { op: '<', version: high }]
  }

  // A bare or `=`-prefixed range with wildcards/partials expands to a bounds pair.
  if (op === '' || op === '=') {
    if (p.major === null) return [{ op: 'any' }]
    if (p.minor === null || p.patch === null) {
      return [{ op: '>=', version: lowerOf(p) }, { op: '<', version: upperOf(p) }]
    }
    return [{ op: '=', version: lowerOf(p) }]
  }

  // Primitive comparator with possible wildcards.
  if (p.major === null) {
    // >= * / <= * are unrestricted, > * / < * can never be satisfied.
    if (op === '>=' || op === '<=') return [{ op: 'any' }]
    return [{ op: 'none' }]
  }
  if (p.minor === null || p.patch === null) {
    const low = lowerOf(p)
    const high = upperOf(p)
    if (op === '>=') return [{ op: '>=', version: low }]
    if (op === '<') return [{ op: '<', version: low }]
    if (op === '>') return [{ op: '>=', version: high }]
    return [{ op: '<', version: high }] // <=
  }
  return [{ op, version: lowerOf(p) }]
}

function testComparator(version, comparator) {
  if (comparator.op === 'any') return true
  if (comparator.op === 'none') return false
  const result = compare(version, comparator.version)
  switch (comparator.op) {
    case '>': return result > 0
    case '>=': return result >= 0
    case '<': return result < 0
    case '<=': return result <= 0
    case '=':
    case '': return result === 0
    default: return false
  }
}

const HYPHEN_RE = /^\s*(\S+)\s+-\s+(\S+)\s*$/

function hyphenComparators(lowText, highText) {
  const low = partial(lowText)
  const high = partial(highText)
  if (!low || !high) return null
  const out = []
  const lowVersion = lowerOf(low)
  if (lowVersion) out.push({ op: '>=', version: lowVersion })
  if (high.major !== null) {
    if (high.minor === null) out.push({ op: '<', version: v(high.major + 1, 0, 0, [0]) })
    else if (high.patch === null) out.push({ op: '<', version: v(high.major, high.minor + 1, 0, [0]) })
    else out.push({ op: '<=', version: lowerOf(high) })
  }
  return out.length ? out : [{ op: 'any' }]
}

function tokenizeAlternative(text) {
  const hyphen = HYPHEN_RE.exec(text)
  if (hyphen) return hyphenComparators(hyphen[1], hyphen[2])
  const tokens = text.split(/[\s,]+/).filter((token) => token !== '')
  if (tokens.length === 0) return [{ op: 'any' }]
  const out = []
  for (const token of tokens) {
    const expanded = comparatorsOf(token)
    if (!expanded) return null
    out.push(...expanded)
  }
  return out
}

/**
 * Validate a range expression.
 * `''` is invalid on purpose (DSH treats an empty engines range as incompatible).
 */
export function validRange(range) {
  if (typeof range !== 'string') return false
  const trimmed = range.trim()
  if (!trimmed) return false
  for (const alternative of trimmed.split('||')) {
    if (tokenizeAlternative(alternative.trim()) === null) return false
  }
  return true
}

/** A range that admits every version ('*', 'x', or '>=0.0.0'). */
export function isWildcardRange(range) {
  if (typeof range !== 'string') return false
  const trimmed = range.trim()
  if (trimmed === '' || trimmed === '*' || trimmed === 'x' || trimmed === 'X') return true
  return trimmed.split('||').every((alternative) => {
    const inner = alternative.trim()
    return inner === '' || inner === '*' || inner === 'x' || inner === 'X'
  })
}

/**
 * Does `version` satisfy `range`?
 * Never throws: unparseable versions or ranges yield false.
 * @param {string} version
 * @param {string} range
 * @returns {boolean}
 */
export function satisfies(version, range) {
  const parsed = parse(version)
  if (!parsed) return false
  if (typeof range !== 'string') return false
  const trimmed = range.trim()
  if (!trimmed) return false
  for (const alternative of trimmed.split('||')) {
    const comparators = tokenizeAlternative(alternative.trim())
    if (comparators === null) continue // an invalid alternative matches nothing
    if (comparators.every((comparator) => testComparator(parsed, comparator))) return true
  }
  return false
}

/**
 * The `maxSatisfying` subset of node-semver we actually need: pick the highest
 * version in `versions` that satisfies `range`.
 * @returns {string|null}
 */
export function maxSatisfying(versions, range) {
  let best = null
  for (const candidate of versions) {
    if (!isValid(candidate)) continue
    if (!satisfies(candidate, range)) continue
    if (best === null || compare(candidate, best) > 0) best = candidate
  }
  return best
}

export default { parse, isValid, compare, rcompare, satisfies, validRange, isWildcardRange, maxSatisfying }
