// GitHub nudge: issue payload contents, path-privacy scrubbing, draft URL
// encoding and HTTP status mapping (injected fetch stub — no network).
//
// Canonical run: node --test "test/*.test.mjs"

import test from 'node:test'
import assert from 'node:assert/strict'
import { hostModule, moduleSuite, expectExports, findAbsolutePath, ABSOLUTE_PATH_PATTERNS } from './_helpers.mjs'

const githubMod = await hostModule('github')
const github = moduleSuite(githubMod, 'lib/host/github.js')

const RUNTIME = '0.2.1-rc.2'

if (githubMod.ok) {
  await test('lib/host/github.js exports the locked surface', async (t) => {
    await expectExports(t, githubMod, 'lib/host/github.js', [
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
// a realistic Report, including hostile absolute paths that MUST be scrubbed
// ---------------------------------------------------------------------------
function reportFixture() {
  return {
    name: 'dsh-fake-third-party',
    version: '0.9.0',
    title: 'Third Party Plugin',
    repo: 'example-owner/dsh-fake-third-party',
    runtimeVersion: RUNTIME,
    runtimeSource: 'env',
    checkedAt: 1_700_000_000_000,
    grade: 'red',
    eligible: true,
    factorA: { status: 'fail', reasons: ['engines.dsh does not match the running runtime'] },
    factorB: { status: 'fail', reasons: ['admission denied: incompatible-version'] },
    layers: [
      {
        id: 'manifest',
        label: 'Manifest',
        status: 'fail',
        findings: [
          {
            code: 'manifest.engines-unsatisfied',
            severity: 'fail',
            message: 'engines.dsh does not accept the running runtime',
            expected: '>=0.2.0-rc.1 <0.3.0-0',
            actual: '>=0.3.0',
          },
        ],
      },
      {
        id: 'resolution',
        label: 'Resolution',
        status: 'pass',
        findings: [],
      },
      {
        id: 'symbols',
        label: 'Symbols',
        status: 'fail',
        findings: [
          {
            code: 'symbols.inject-missing',
            severity: 'fail',
            message: 'the entry declares a service the live context does not provide',
            expected: 'ctx.webServer',
            actual: 'missing',
            hint: 'loaded from C:\\Users\\Mutou\\.dsh\\profiles\\desktop\\node_modules\\dsh-fake\\lib\\index.js',
          },
        ],
      },
      {
        id: 'activation',
        label: 'Activation',
        status: 'warn',
        findings: [],
      },
    ],
    findings: [
      {
        code: 'manifest.engines-unsatisfied',
        severity: 'fail',
        message: 'engines.dsh does not accept the running runtime',
        expected: '>=0.2.0-rc.1 <0.3.0-0',
        actual: '>=0.3.0',
      },
      {
        code: 'symbols.inject-missing',
        severity: 'fail',
        message: 'the entry declares a service the live context does not provide',
        expected: 'ctx.webServer',
        actual: 'missing',
        hint: 'loaded from C:\\Users\\Mutou\\.dsh\\profiles\\desktop\\node_modules\\dsh-fake\\lib\\index.js',
      },
      {
        code: 'dsh.denied',
        severity: 'fail',
        message: 'DSH refused to load this plugin',
        expected: 'admitted',
        actual: 'incompatible-version',
      },
    ],
    activation: { rows: [], error: null },
    dedupe: { key: 'a'.repeat(64), lastNudgedAt: null, allowedAt: null, duplicate: false },
  }
}

// ---------------------------------------------------------------------------
// issue content
// ---------------------------------------------------------------------------
github.it('buildIssue returns { title, body }, both non-empty strings', () => {
  const issue = github.ns.buildIssue(reportFixture())
  assert.equal(typeof issue.title, 'string')
  assert.equal(typeof issue.body, 'string')
  assert.ok(issue.title.trim().length > 0)
  assert.ok(issue.body.trim().length > 0)
})

github.it('issue title contains the plugin name, plugin version and runtime version', () => {
  const { title } = github.ns.buildIssue(reportFixture())
  assert.match(title, /dsh-fake-third-party/, `title must name the plugin: ${title}`)
  assert.match(title, /0\.9\.0/, `title must carry the plugin version: ${title}`)
  assert.match(title, /0\.2\.1-rc\.2/, `title must carry the runtime version: ${title}`)
})

github.it('issue body contains the plugin, the runtime and every finding code', () => {
  const report = reportFixture()
  const { body } = github.ns.buildIssue(report)
  assert.match(body, /dsh-fake-third-party/, 'body must name the plugin')
  assert.match(body, /0\.9\.0/, 'body must carry the plugin version')
  assert.match(body, /0\.2\.1-rc\.2/, 'body must carry the runtime version')
  for (const finding of report.findings) {
    assert.ok(body.includes(finding.code), `body must contain the finding code ${finding.code}`)
  }
})

github.it('issue body carries expected/actual for each finding', () => {
  const { body } = github.ns.buildIssue(reportFixture())
  assert.ok(body.includes('>=0.3.0'), 'body must contain the actual declared range')
  assert.ok(body.includes('>=0.2.0-rc.1 <0.3.0-0'), 'body must contain the expected range')
})

github.it('issue body states the DSH admission conclusion', () => {
  const { body } = github.ns.buildIssue(reportFixture())
  assert.match(body, /admi|compatib|denied|reject/i, 'body must explain the admission verdict')
})

// ---------------------------------------------------------------------------
// privacy: no absolute local path may leak into the issue
// ---------------------------------------------------------------------------
github.it('issue body contains no absolute local path (C:\\, Users\\, /home/)', () => {
  const { body } = github.ns.buildIssue(reportFixture())
  assert.ok(!body.includes('C:\\'), 'body must not contain a drive-letter path')
  assert.ok(!/Users\\/.test(body), 'body must not contain a Windows user profile path')
  assert.ok(!/Users\//.test(body), 'body must not contain a POSIX user profile path')
  assert.ok(!/AppData/i.test(body), 'body must not contain AppData')
  const leak = findAbsolutePath(body)
  assert.equal(leak, null, `body leaked an absolute path (${leak?.pattern}): ${leak?.match}`)
})

github.it('issue title contains no absolute local path', () => {
  const { title } = github.ns.buildIssue(reportFixture())
  const leak = findAbsolutePath(title)
  assert.equal(leak, null, `title leaked an absolute path (${leak?.pattern}): ${leak?.match}`)
})

github.it('buildIssue scrubs hostile paths planted in every string field', () => {
  const report = reportFixture()
  report.findings = report.findings.map((finding) => ({
    ...finding,
    message: `/home/mutou/projects/thing ran at C:\\Users\\Mutou\\Desktop`,
    expected: '/root/.dsh/profiles/desktop',
    actual: 'C:/Users/Mutou/AppData/Local',
    hint: 'file:///C:/Users/Mutou/.dsh/state.json',
  }))
  const { title, body } = github.ns.buildIssue(report)
  const combined = `${title}\n${body}`
  const leak = findAbsolutePath(combined)
  assert.equal(leak, null, `leaked ${leak?.pattern}: ${leak?.match}`)
})

github.it('buildIssue never includes the token, if one is passed through options', () => {
  const secret = 'ghp_thisMustNeverAppear0123456789'
  const issue = github.ns.buildIssue(reportFixture(), { token: secret, dshVersion: RUNTIME })
  assert.ok(!issue.body.includes(secret), 'the PAT must never appear in an issue body')
  assert.ok(!issue.title.includes(secret), 'the PAT must never appear in an issue title')
})

github.it('scrubText removes absolute paths and keeps the useful words', () => {
  const scrubbed = github.ns.scrubText(
    'while loading C:\\Users\\Mutou\\.dsh\\profiles\\desktop\\node_modules\\dsh-fake\\lib\\index.js the export was missing',
  )
  assert.ok(!scrubbed.includes('C:\\'), `scrubText left a drive path: ${scrubbed}`)
  assert.ok(!/Users\\/.test(scrubbed), `scrubText left a user path: ${scrubbed}`)
  assert.match(scrubbed, /missing/, 'scrubText must keep the meaningful text')
  assert.equal(github.ns.scrubText(''), '')
})

// ---------------------------------------------------------------------------
// draft URL
// ---------------------------------------------------------------------------
github.it('draftUrl builds a GitHub new-issue URL for the right repo', () => {
  const issue = github.ns.buildIssue(reportFixture())
  const url = github.ns.draftUrl('example-owner', 'dsh-fake-third-party', issue)
  const parsed = new URL(url)
  assert.equal(parsed.origin, 'https://github.com')
  assert.equal(parsed.pathname, '/example-owner/dsh-fake-third-party/issues/new')
})

github.it('draftUrl percent-encodes the title and body', () => {
  const issue = { title: 'compat: a & b ? c #d', body: 'line 1\nline 2 & "quoted" 100% + plus' }
  const url = github.ns.draftUrl('owner', 'repo', issue)
  const parsed = new URL(url)
  assert.equal(parsed.searchParams.get('title'), issue.title, 'title must round-trip through the query string')
  assert.equal(parsed.searchParams.get('body'), issue.body, 'body must round-trip through the query string')

  const raw = url.slice(url.indexOf('?'))
  assert.ok(!raw.includes('\n'), 'a literal newline must not survive into the URL')
  assert.ok(!raw.includes('#'), 'a literal # must be encoded, not treated as a fragment')
  assert.ok(raw.includes('%0A'), 'newlines must be percent-encoded')
})

github.it('draftUrl output is a valid absolute https URL for a realistic report', () => {
  const issue = github.ns.buildIssue(reportFixture())
  const url = github.ns.draftUrl('example-owner', 'dsh-fake-third-party', issue)
  assert.doesNotThrow(() => new URL(url))
  assert.ok(url.startsWith('https://github.com/example-owner/dsh-fake-third-party/issues/new?'), url.slice(0, 80))
  assert.ok(url.length > 200, 'the body must actually be included in the URL')
})

github.it('draftUrl refuses to emit a URL for a missing owner/repo', () => {
  const issue = { title: 't', body: 'b' }
  for (const [owner, repo] of [['', 'r'], ['o', ''], [null, 'r'], ['o', null], [undefined, undefined]]) {
    let url = null
    try {
      url = github.ns.draftUrl(owner, repo, issue)
    } catch {
      continue // throwing is a valid refusal
    }
    // If it returns instead of throwing, it must not be a usable GitHub URL.
    assert.equal(url, null, `draftUrl(${JSON.stringify(owner)}, ${JSON.stringify(repo)}) returned ${url}`)
  }
})

github.it('draftUrl does not produce a URL that would file against a nonexistent repo', () => {
  let url = null
  try {
    url = github.ns.draftUrl('', 'r', { title: 't', body: 'b' })
  } catch {
    return
  }
  assert.ok(
    url === null || url === '',
    `draftUrl with an empty owner must not fabricate a repository URL, got ${url}`,
  )
})

// ---------------------------------------------------------------------------
// HTTP status mapping, injected fetch stub (no network)
// ---------------------------------------------------------------------------
function stubFetch(status, { body = '', headers = {} } = {}) {
  const calls = []
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, init })
    const hdrs = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]))
    return {
      status,
      ok: status >= 200 && status < 300,
      headers: { get: (name) => hdrs.get(String(name).toLowerCase()) ?? null },
      async text() {
        return body
      },
      async json() {
        return JSON.parse(body)
      },
    }
  }
  return { fetchImpl, calls }
}

const CREATED_BODY = JSON.stringify({ number: 42, html_url: 'https://github.com/example-owner/dsh-fake-third-party/issues/42' })

const STATUS_CASES = [
  [201, CREATED_BODY, true, 'created'],
  [401, JSON.stringify({ message: 'Bad credentials' }), false, 'unauthorized'],
  [403, JSON.stringify({ message: 'Resource not accessible by personal access token' }), false, 'forbidden'],
  [404, JSON.stringify({ message: 'Not Found' }), false, 'not-found'],
  [410, JSON.stringify({ message: 'Gone' }), false, 'gone'],
  [422, JSON.stringify({ message: 'Validation Failed', errors: [{ message: 'body is too long' }] }), false, 'invalid'],
  [429, JSON.stringify({ message: 'API rate limit exceeded' }), false, 'rate-limited'],
]

for (const [status, body, ok, outcome] of STATUS_CASES) {
  github.it(`fileIssue maps HTTP ${status} to a readable ${outcome} outcome`, async () => {
    const { fetchImpl, calls } = stubFetch(status, { body })
    const result = await github.ns.fileIssue({
      owner: 'example-owner',
      repo: 'dsh-fake-third-party',
      issue: github.ns.buildIssue(reportFixture()),
      token: 'ghp_test_token_do_not_log',
      fetch: fetchImpl,
    })

    assert.equal(result.ok, ok, `HTTP ${status} => ok:${ok}; got ${JSON.stringify(result)}`)
    assert.equal(result.outcome, outcome, `HTTP ${status} must map to outcome "${outcome}"`)
    assert.equal(typeof result.message, 'string')
    assert.ok(result.message.trim().length > 0, `HTTP ${status} must return a human-readable message`)
    assert.ok(!result.message.includes('ghp_test_token_do_not_log'), 'the error message must never echo the token')

    assert.equal(calls.length, 1, `HTTP ${status} must trigger exactly one request`)
    assert.equal(calls[0].url, 'https://api.github.com/repos/example-owner/dsh-fake-third-party/issues')
    assert.equal(calls[0].init.method, 'POST')

    const sent = calls[0].init.headers || {}
    const authHeader = Object.entries(sent).find(([k]) => k.toLowerCase() === 'authorization')
    assert.ok(authHeader, 'the request must carry an Authorization header')
    assert.match(String(authHeader[1]), /ghp_test_token_do_not_log/, 'the PAT must travel in the header, not the body')
    assert.ok(!String(calls[0].init.body).includes('ghp_test_token_do_not_log'), 'the PAT must not be in the JSON body')

    if (ok) {
      assert.equal(result.number, 42, 'a created issue must report its number')
      assert.match(String(result.url), /issues\/42$/, 'a created issue must report its URL')
    } else {
      assert.equal(result.status, status, `a failed call must report the HTTP status ${status}`)
    }
  })
}

github.it('fileIssue maps a network failure (fetch throws) to ok:false with status 0', async () => {
  const result = await github.ns.fileIssue({
    owner: 'example-owner',
    repo: 'dsh-fake-third-party',
    issue: { title: 't', body: 'b' },
    token: 'tok',
    fetch: async () => {
      throw new Error('getaddrinfo ENOTFOUND api.github.com')
    },
  })
  assert.equal(result.ok, false)
  assert.equal(result.status, 0, 'a transport failure reports status 0')
  assert.equal(typeof result.message, 'string')
  assert.ok(result.message.length > 0)
})

github.it('fileIssue refuses to call the API without a token', async () => {
  let called = false
  const result = await github.ns.fileIssue({
    owner: 'example-owner',
    repo: 'dsh-fake-third-party',
    issue: { title: 't', body: 'b' },
    token: '',
    fetch: async () => {
      called = true
      return { status: 201, ok: true, headers: { get: () => null }, text: async () => CREATED_BODY }
    },
  })
  assert.equal(called, false, 'no request may be made without a token')
  assert.equal(result.ok, false)
  assert.equal(typeof result.message, 'string')
})

github.it('fileIssue distinct messages per status (no two failure statuses share a message)', async () => {
  const messages = new Map()
  for (const [status, body] of STATUS_CASES.filter(([s]) => s >= 400)) {
    const { fetchImpl } = stubFetch(status, { body })
    const result = await github.ns.fileIssue({
      owner: 'o',
      repo: 'r',
      issue: { title: 't', body: 'b' },
      token: 'tok',
      fetch: fetchImpl,
    })
    messages.set(status, result.message)
  }
  const rendered = [...messages.entries()].map(([s, m]) => `${s}:${m}`)
  const distinct = new Set([...messages.values()])
  assert.equal(distinct.size, messages.size, `each failure status needs its own guidance:\n${rendered.join('\n')}`)
})

github.it('fileIssue sends a User-Agent (GitHub rejects requests without one)', async () => {
  const { fetchImpl, calls } = stubFetch(201, { body: CREATED_BODY })
  await github.ns.fileIssue({
    owner: 'o',
    repo: 'r',
    issue: { title: 't', body: 'b' },
    token: 'tok',
    fetch: fetchImpl,
  })
  const headers = Object.entries(calls[0].init.headers || {})
  const ua = headers.find(([k]) => k.toLowerCase() === 'user-agent')
  assert.ok(ua, 'a User-Agent header is required')
  assert.ok(String(ua[1]).length > 0)
})

github.it('fileIssue request body contains title and body but no absolute path', async () => {
  const { fetchImpl, calls } = stubFetch(201, { body: CREATED_BODY })
  await github.ns.fileIssue({
    owner: 'o',
    repo: 'r',
    issue: github.ns.buildIssue(reportFixture()),
    token: 'tok',
    fetch: fetchImpl,
  })
  const payload = JSON.parse(calls[0].init.body)
  assert.equal(typeof payload.title, 'string')
  assert.equal(typeof payload.body, 'string')
  assert.ok(payload.title.length > 0 && payload.body.length > 0)
  const leak = findAbsolutePath(`${payload.title}\n${payload.body}`)
  assert.equal(leak, null, `the API payload leaked an absolute path: ${leak?.match}`)
})

github.it('all privacy patterns are actually exercised by the fixture', () => {
  // Guard against the fixture silently losing its hostile strings.
  const raw = reportFixture().findings.map((f) => f.hint || '').join('\n')
  assert.ok(ABSOLUTE_PATH_PATTERNS.some((re) => re.test(raw)), 'the fixture must contain at least one absolute path')
})
