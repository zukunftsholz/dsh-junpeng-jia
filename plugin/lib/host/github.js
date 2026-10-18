// GitHub repository resolution, issue drafting, and filing.
//
// Two hard rules drive this module:
//   1. A nudge must never leak the local machine. The body is built from the
//      Report only — no absolute paths, no usernames, no session ids — and every
//      free-text field that could carry one passes through `scrubText` first.
//   2. Nothing here throws at the caller: `fileIssue` resolves to a discriminated
//      result for every HTTP status we care about, and network failures are
//      `ok:false` with `status: 0` (the draft link still works offline).
//
// `fetch` is assumed to exist globally (Node 20+) but is injectable so the tests
// never touch the network.

import { GENERATOR, ISSUE_LABEL_HINT } from '../contract.js'

const GITHUB_HOSTS = new Set(['github.com', 'www.github.com'])
const API_BASE = 'https://api.github.com'
const USER_AGENT = 'dsh-junpeng-jia'
const DEFAULT_TIMEOUT_MS = 10_000

// ── repository parsing ───────────────────────────────────────────────────────

/**
 * Extract `owner/repo` from any of the URL forms GitHub's own docs produce.
 * Pure; returns null for anything that is not a github.com repository URL.
 *
 * @param {unknown} value
 * @returns {{ owner: string, repo: string, url: string }|null}
 */
export function parseGithubRepo(value) {
  if (value === null || value === undefined) return null
  const text = typeof value === 'string' ? value.trim() : ''
  if (!text) return null

  // scp-like shorthand: git@github.com:owner/repo.git
  const scp = /^(?:[A-Za-z0-9._-]+@)?([^/:\s]+):([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/.exec(text)
  if (scp && GITHUB_HOSTS.has(scp[1].toLowerCase())) {
    return normalise(scp[2], scp[3])
  }

  let parsed
  try {
    parsed = new URL(text)
  } catch {
    // Scheme-less host form, e.g. "github.com/owner/repo" (common in manifests).
    const hosted = /^(?:www\.)?github\.com\/([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?(?:[?#].*)?$/i.exec(text)
    if (hosted) return normalise(hosted[1], hosted[2])
    // Not a URL: accept the bare "owner/repo" form the config uses.
    const bare = /^([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/.exec(text)
    return bare ? normalise(bare[1], bare[2]) : null
  }
  if (!GITHUB_HOSTS.has(parsed.hostname.toLowerCase())) return null
  const parts = parsed.pathname.split('/').filter(Boolean)
  if (parts.length < 2) return null
  return normalise(parts[0], parts[1].replace(/\.git$/i, ''))
}

function normalise(owner, repo) {
  const cleanOwner = String(owner || '').trim()
  const cleanRepo = String(repo || '').trim().replace(/\.git$/i, '')
  if (!cleanOwner || !cleanRepo) return null
  // GitHub owner/repo characters are conservative; reject anything else loudly
  // rather than building a URL that 404s.
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,38})$/.test(cleanOwner)) return null
  if (!/^[A-Za-z0-9._-]{1,100}$/.test(cleanRepo)) return null
  if (cleanRepo === '.' || cleanRepo === '..') return null
  return { owner: cleanOwner, repo: cleanRepo, url: `https://github.com/${cleanOwner}/${cleanRepo}` }
}

function urlOf(value) {
  if (typeof value === 'string') return value.trim()
  if (value && typeof value === 'object' && typeof value.url === 'string') return value.url.trim()
  return ''
}

/**
 * Resolve the public repository from a package manifest.
 * Order: repository.url, repository (string), bugs.url, homepage.
 *
 * @param {object|string|null|undefined} manifest parsed package.json
 * @returns {{ owner: string, repo: string, url: string }|null}
 */
export function resolveRepo(manifest) {
  if (!manifest || typeof manifest !== 'object') return null
  const candidates = [
    urlOf(manifest.repository),
    typeof manifest.repository === 'string' ? manifest.repository : '',
    urlOf(manifest.bugs),
    typeof manifest.homepage === 'string' ? manifest.homepage : '',
  ]
  for (const candidate of candidates) {
    const parsed = parseGithubRepo(candidate)
    if (parsed) return parsed
  }
  return null
}

/**
 * Apply the user's `repoOverrides` map on top of the manifest.
 *
 * @param {string} packageName
 * @param {object|string|null|undefined} manifest
 * @param {Record<string,string>} [repoOverrides] `{ 'dsh-x': 'owner/repo' }`
 * @returns {{ owner: string, repo: string, url: string, via: 'override'|'manifest' }|null}
 */
export function resolveRepoFor(packageName, manifest, repoOverrides = {}) {
  const overrides = repoOverrides && typeof repoOverrides === 'object' ? repoOverrides : {}
  const override = typeof packageName === 'string' ? overrides[packageName] : undefined
  if (typeof override === 'string' && override.trim()) {
    const parsed = parseGithubRepo(override)
    if (parsed) return { ...parsed, via: 'override' }
  }
  const fromManifest = resolveRepo(manifest)
  return fromManifest ? { ...fromManifest, via: 'manifest' } : null
}

// ── text hygiene ─────────────────────────────────────────────────────────────

const PATH_PATTERNS = [
  // Windows absolute paths: C:\... , D:/..., \\server\share
  /\b[A-Za-z]:[\\/][^\s"'`<>)\]]*/g,
  /\\\\[^\s"'`<>)\]]+/g,
  // POSIX absolute paths under common home-ish roots (the lookbehind keeps
  // "https://..." and "pkg/lib/..." from being eaten).
  /(?<![\w:./-])\/(?:Users|home|root|private|var|opt|srv|mnt|Volumes)\/[^\s"'`<>)\]]*/g,
  // User-profile segments that survive other scrubbing.
  /\b(?:Users|home)[\\/][A-Za-z0-9._-]+/g,
]

/**
 * Remove anything that could identify the local machine.
 * Used on every string that reaches an issue body or title.
 */
export function scrubText(value) {
  if (value === null || value === undefined) return ''
  let text = String(value)
  for (const pattern of PATH_PATTERNS) {
    text = text.replace(pattern, '<path>')
  }
  // DeepSeek/Harness session ids and npm-style absolute node_modules paths.
  text = text.replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<id>')
  return text.replace(/\s+$/gm, '').trim()
}

/** True when the text still looks like it contains a local absolute path. */
export function containsLocalPath(value) {
  if (typeof value !== 'string') return false
  if (/\b[A-Za-z]:[\\/]/.test(value)) return true
  if (/\\\\[A-Za-z0-9._-]+\\/.test(value)) return true
  if (/(?:^|\s)\/(?:Users|home|root|Volumes)\//.test(value)) return true
  return false
}

// ── issue construction ───────────────────────────────────────────────────────

/** Strip a leading 'v' and keep prereleases; used for range display only. */
function asVersion(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function findingRow(finding) {
  const expected = finding.expected === undefined || finding.expected === null ? '' : scrubText(finding.expected)
  const actual = finding.actual === undefined || finding.actual === null ? '' : scrubText(finding.actual)
  const message = scrubText(finding.message || '')
  // Table cells cannot contain raw pipes or newlines.
  const cell = (text) => text.replace(/\r?\n/g, ' ').replace(/\|/g, '\\|')
  return `| \`${finding.code}\` | ${finding.severity} | ${cell(message)} | ${cell(expected) || '—'} | ${cell(actual) || '—'} |`
}

/**
 * Build the issue title and body from a Report.
 *
 * The body is deliberately formal and machine-friendly: maintainers get the
 * environment, the failing findings as a table, DSH's own admission verdict,
 * reproduction steps, and a pointer at the requirement that changed.
 *
 * @param {object} report a Report from host/inspect.js
 * @param {{ dshVersion?: string, nodeVersion?: string, platform?: string }} [options]
 * @returns {{ title: string, body: string }}
 */
export function buildIssue(report, options = {}) {
  const source = report && typeof report === 'object' ? report : {}
  const name = scrubText(source.name || 'unknown-plugin')
  const version = asVersion(source.version) || 'unknown'
  const runtimeVersion = asVersion(options.dshVersion || source.runtimeVersion) || 'unknown'
  const runtimeSource = scrubText(source.runtimeSource || 'unknown')
  const platform = scrubText(options.platform || runtimePlatform())
  const nodeVersion = asVersion(options.nodeVersion || runtimeNodeVersion()) || 'unknown'
  const repo = typeof source.repo === 'string' ? source.repo : ''

  const findings = Array.isArray(source.findings) ? source.findings.filter(Boolean) : []
  const failed = findings.filter((item) => item.severity === 'fail')
  const warned = findings.filter((item) => item.severity === 'warn')
  const reported = failed.length ? failed : warned

  const factorA = source.factorA || { status: 'unknown', reasons: [] }
  const factorB = source.factorB || { status: 'unknown', reasons: [] }
  const reasons = (side) => (Array.isArray(side.reasons) ? side.reasons : []).map(scrubText).filter(Boolean)

  const title = `[compat] ${name}@${version} fails on DeepSeek Harness ${runtimeVersion}`

  const lines = []
  lines.push(`## Summary`)
  lines.push('')
  lines.push(`\`${name}@${version}\` is reported as **${scrubText(source.grade || 'unknown')}** against DeepSeek Harness \`${runtimeVersion}\`.`)
  if (failed.length) {
    lines.push('')
    lines.push(`${failed.length} requirement check(s) failed${warned.length ? `, plus ${warned.length} warning(s)` : ''}.`)
  }
  lines.push('')

  lines.push('## Environment')
  lines.push('')
  lines.push('| Item | Value |')
  lines.push('| --- | --- |')
  lines.push(`| DeepSeek Harness | \`${runtimeVersion}\` (resolved via \`${runtimeSource}\`) |`)
  lines.push(`| Node.js | \`${nodeVersion}\` |`)
  lines.push(`| Platform | \`${platform}\` |`)
  lines.push(`| Plugin | \`${name}@${version}\` |`)
  if (repo) lines.push(`| Plugin repository | \`${scrubText(repo)}\` |`)
  lines.push('')

  lines.push('## Failed checks')
  lines.push('')
  if (reported.length === 0) {
    lines.push('_No failed finding was recorded; see the verdict below._')
  } else {
    lines.push('| Code | Severity | Detail | Expected | Actual |')
    lines.push('| --- | --- | --- | --- | --- |')
    for (const finding of reported) lines.push(findingRow(finding))
  }
  lines.push('')

  lines.push('## DeepSeek Harness admission verdict')
  lines.push('')
  lines.push(`- Plugin side (manifest + resolution + symbols): **${scrubText(factorA.status || 'unknown')}**${reasons(factorA).length ? ` — ${reasons(factorA).join('; ')}` : ''}`)
  lines.push(`- Runtime side (version admission + loader state): **${scrubText(factorB.status || 'unknown')}**${reasons(factorB).length ? ` — ${reasons(factorB).join('; ')}` : ''}`)
  lines.push('')

  const requirements = source.requirements && typeof source.requirements === 'object' ? source.requirements : null
  if (requirements && Object.keys(requirements).length) {
    lines.push('## Declared requirements')
    lines.push('')
    lines.push('| Requirement | Range |')
    lines.push('| --- | --- |')
    for (const [key, value] of Object.entries(requirements)) {
      lines.push(`| \`${scrubText(key)}\` | \`${scrubText(String(value))}\` |`)
    }
    lines.push('')
  }

  lines.push('## Steps to reproduce')
  lines.push('')
  lines.push('1. Install DeepSeek Harness Desktop at the version above.')
  lines.push(`2. Install \`${name}@${version}\` into a profile (\`dsh plugin install\` / Plugins page).`)
  lines.push('3. Enable the plugin and load the Plugins page.')
  lines.push('4. Run the compatibility inspection and compare against the table above.')
  lines.push('')

  lines.push('## Suggested fix')
  lines.push('')
  lines.push(suggestedFix(reported, runtimeVersion))
  lines.push('')

  lines.push('## Notes')
  lines.push('')
  lines.push(`- Generated by ${GENERATOR}; the environment table was read from the running Harness process.`)
  lines.push('- No local filesystem paths, user names, or session content are included in this report.')
  lines.push(`- Suggested label: \`${ISSUE_LABEL_HINT}\`.`)
  lines.push('')

  return { title: scrubText(title), body: lines.join('\n') }
}

function suggestedFix(findings, runtimeVersion) {
  const codes = new Set(findings.map((finding) => finding.code))
  const tips = []
  if (codes.has('manifest.engines-unsatisfied') || codes.has('manifest.engines-missing')) {
    tips.push(`- Update \`engines.dsh\` to the range you actually support, e.g. \`>=${runtimeVersion} <next-minor\`, or widen it to accept the current line. When \`engines.dsh\` is present it alone decides admission, so it must be accurate.`)
  }
  if (codes.has('manifest.peer-unsatisfied') || codes.has('manifest.peer-missing')) {
    tips.push('- Align the `@deepseek-ai/*` peer dependency ranges with the versions the Harness ships, and declare peers you import directly.')
  }
  if (codes.has('symbols.inject-unknown') || codes.has('symbols.inject-missing')) {
    tips.push('- Every service listed in `export const inject = [...]` must be provided by the running composition; add a declared dependency or make the lookup optional via `ctx.get(name)`.')
  }
  if (codes.has('activation.row-failed') || codes.has('activation.bundle-error')) {
    tips.push('- The plugin row failed to activate. Check the Loader diagnostic for that entry (a throw during `apply()` is the usual cause).')
  }
  if (codes.has('manifest.client-inject-missing')) {
    tips.push('- `dsh.client.inject` names a browser module that is not part of the composed web graph; add it to the profile or drop the entry.')
  }
  if (codes.has('dsh.denied')) {
    tips.push('- The runtime refused this exact plugin version. Either publish a build whose `engines.dsh` admits the running Harness, or ask users to add a version exemption only if the risk is acceptable.')
  }
  if (tips.length === 0) {
    tips.push('- Republish with requirement ranges that match the current Harness release line, then re-run the inspection.')
  }
  return tips.join('\n')
}

function runtimePlatform() {
  try {
    return `${process.platform}-${process.arch}`
  } catch {
    return 'unknown'
  }
}

function runtimeNodeVersion() {
  try {
    return typeof process.version === 'string' ? process.version : ''
  } catch {
    return ''
  }
}

/**
 * Pre-filled "new issue" URL for the draft flow.
 *
 * Uses encodeURIComponent semantics for both query values, per the contract.
 *
 * Returns `null` when there is no addressable repository: `owner` or `repo`
 * empty, missing, or not a string. Interpolating a falsy value would produce
 * `https://github.com//r/issues/new`, a link that looks usable and 404s — the UI
 * must show "no repository" instead. Callers map `null` to the `blocked`
 * outcome (docs/BLUEPRINT.md §4).
 *
 * @param {string} owner
 * @param {string} repo
 * @param {{ title?: string, body?: string }} issue
 * @returns {string|null}
 */
export function draftUrl(owner, repo, issue) {
  const cleanOwner = typeof owner === 'string' ? owner.trim() : ''
  const cleanRepo = typeof repo === 'string' ? repo.trim() : ''
  if (!cleanOwner || !cleanRepo) return null
  const base = `https://github.com/${encodeURIComponent(cleanOwner)}/${encodeURIComponent(cleanRepo)}/issues/new`
  const title = encodeURIComponent(String(issue && issue.title ? issue.title : ''))
  const body = encodeURIComponent(String(issue && issue.body ? issue.body : ''))
  return `${base}?title=${title}&body=${body}`
}

// ── filing ───────────────────────────────────────────────────────────────────

/** HTTP status -> machine outcome + human message. */
export const FILING_OUTCOMES = {
  201: ['created', 'Issue created.'],
  401: ['unauthorized', 'GitHub rejected the token (401). Re-enter the token; it may be expired or revoked.'],
  403: ['forbidden', 'GitHub refused the request (403). The token may lack `public_repo`/`repo` scope, or a rate limit applies.'],
  404: ['not-found', 'The repository was not found (404). Check the resolved owner/repo, or the token may not see it.'],
  410: ['gone', 'Issues are disabled for this repository (410 gone).'],
  422: ['invalid', 'GitHub rejected the issue payload (422): a required field is missing or a label/assignee does not exist.'],
  429: ['rate-limited', 'GitHub rate limit reached (429). Retry later; nothing was filed.'],
}

function resultForStatus(status, payload) {
  const known = FILING_OUTCOMES[status]
  if (known) {
    const [outcome, base] = known
    if (outcome === 'created') return { ok: true, outcome, status, message: base }
    const detail = payload && typeof payload === 'object' && payload.message ? ` (${scrubText(payload.message).slice(0, 200)})` : ''
    return { ok: false, outcome, status, message: `${base}${detail}` }
  }
  const detail = payload && typeof payload === 'object' && payload.message ? `: ${scrubText(payload.message).slice(0, 200)}` : ''
  return { ok: false, outcome: 'error', status, message: `GitHub returned HTTP ${status}${detail}` }
}

/**
 * POST the issue through api.github.com.
 *
 * Never rejects. The status mapping is intentionally explicit: the UI shows a
 * different sentence for auth failure vs. missing permission vs. disabled issues,
 * because those need different user actions.
 *
 * @param {{
 *   owner: string,
 *   repo: string,
 *   issue: { title: string, body: string },
 *   token: string,
 *   fetch?: typeof fetch,
 *   timeoutMs?: number,
 *   userAgent?: string,
 *   labels?: string[],
 * }} opts
 * @returns {Promise<
 *   { ok: true, outcome: 'created', number: number|null, url: string|null, message: string, status: number }
 *   | { ok: false, outcome: string, status: number, message: string }
 * >}
 */
export async function fileIssue(opts) {
  const options = opts && typeof opts === 'object' ? opts : {}
  const owner = typeof options.owner === 'string' ? options.owner.trim() : ''
  const repo = typeof options.repo === 'string' ? options.repo.trim() : ''
  const token = typeof options.token === 'string' ? options.token.trim() : ''
  const issue = options.issue && typeof options.issue === 'object' ? options.issue : null

  if (!owner || !repo) {
    return { ok: false, outcome: 'invalid', status: 0, message: 'No GitHub repository is known for this plugin.' }
  }
  if (!issue || !issue.title) {
    return { ok: false, outcome: 'invalid', status: 0, message: 'The issue draft is empty.' }
  }
  if (!token) {
    return { ok: false, outcome: 'unauthorized', status: 0, message: 'No GitHub token is configured; use the draft flow instead.' }
  }

  const doFetch = typeof options.fetch === 'function' ? options.fetch : globalThis.fetch
  if (typeof doFetch !== 'function') {
    return { ok: false, outcome: 'error', status: 0, message: 'This runtime has no fetch implementation.' }
  }

  const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : DEFAULT_TIMEOUT_MS
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new DOMException('timeout', 'TimeoutError')), timeoutMs)

  const payload = { title: scrubText(issue.title), body: issue.body }
  if (Array.isArray(options.labels) && options.labels.length) payload.labels = options.labels.slice()

  try {
    const response = await doFetch(`${API_BASE}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues`, {
      method: 'POST',
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'user-agent': options.userAgent || USER_AGENT,
        'x-github-api-version': '2022-11-28',
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
      redirect: 'error',
    })
    const status = typeof response.status === 'number' ? response.status : 0
    let parsed = null
    try {
      parsed = await response.json()
    } catch {
      parsed = null
    }
    if (status === 201 && parsed && typeof parsed === 'object') {
      return {
        ok: true,
        outcome: 'created',
        status,
        number: typeof parsed.number === 'number' ? parsed.number : null,
        url: typeof parsed.html_url === 'string' ? parsed.html_url : null,
        message: 'Issue created.',
      }
    }
    return resultForStatus(status, parsed)
  } catch (error) {
    const aborted = controller.signal.aborted
    const reason = aborted ? `timed out after ${timeoutMs} ms` : scrubText(error && error.message ? error.message : String(error)).slice(0, 200)
    return {
      ok: false,
      outcome: aborted ? 'timeout' : 'error',
      status: 0,
      message: `Could not reach GitHub (${reason}). The draft link still works offline.`,
    }
  } finally {
    clearTimeout(timer)
  }
}

export default {
  parseGithubRepo,
  resolveRepo,
  resolveRepoFor,
  buildIssue,
  draftUrl,
  fileIssue,
  scrubText,
  containsLocalPath,
  FILING_OUTCOMES,
}
