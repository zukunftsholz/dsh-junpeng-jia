// Durable local state for dsh-junpeng-jia.
//
// Location: <DSH_PROFILE_DIR>/.junpeng-jia/state.json — the profile, never the
// plugin directory (which is a linked checkout and would lose the file on
// reinstall), and never the user's home root.
//
// Durability rules:
//   * Writes are atomic: serialise to state.json.tmp-<pid>-<ts>, fsync-less
//     rename over the target (rename is atomic on NTFS and POSIX alike).
//   * A corrupt or unreadable file is moved aside to state.json.corrupt-<ts> and
//     rebuilt from defaults, so a half-written file can never wedge the plugin.
//   * Every method is synchronous and cheap; the file is small by construction
//     (history is capped, per-package records are keyed).
//
// Everything is injectable (profileDir, now, fs) so the state machine can be
// unit-tested without touching the real profile.

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { STATE_DIRNAME, STATE_FILENAME } from '../contract.js'

const SCHEMA = 1
const HISTORY_CAP = 100
const NUDGE_KEYS_CAP = 500
const REPORT_CACHE_CAP = 200

/** Empty state. Every consumer treats a missing field as its default. */
export function emptyState() {
  return {
    schema: SCHEMA,
    nudges: [],       // NudgeRecord[], newest first
    signatures: {},   // dedupeKey -> { at: epochMs, count: number, url: string|null, number: number|null }
    reports: {},      // package name -> { at, report }
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Coerce a parsed file into the current shape without trusting any field. */
export function normaliseState(raw) {
  const state = emptyState()
  if (!isPlainObject(raw)) return state
  if (Array.isArray(raw.nudges)) {
    state.nudges = raw.nudges
      .filter((entry) => isPlainObject(entry) && typeof entry.at === 'number')
      .slice(0, HISTORY_CAP)
  }
  if (isPlainObject(raw.signatures)) {
    for (const [key, value] of Object.entries(raw.signatures)) {
      if (!isPlainObject(value) || typeof value.at !== 'number') continue
      state.signatures[key] = {
        at: value.at,
        count: Number.isFinite(value.count) ? value.count : 1,
        url: typeof value.url === 'string' ? value.url : null,
        number: Number.isFinite(value.number) ? value.number : null,
      }
    }
  }
  if (isPlainObject(raw.reports)) {
    for (const [key, value] of Object.entries(raw.reports)) {
      if (!isPlainObject(value) || typeof value.at !== 'number' || !isPlainObject(value.report)) continue
      state.reports[key] = { at: value.at, report: value.report }
    }
  }
  return state
}

/**
 * Dedupe signature: sha256 over the tuple that actually changes when a plugin
 * becomes incompatible in a *new* way.
 *
 * The fail-code list is sorted so that layer ordering cannot change the hash, and
 * the missing-symbol list is normalised the same way, so re-running an
 * inspection is idempotent.
 *
 * @param {{
 *   package?: string, name?: string,
 *   version?: string,
 *   runtimeVersion?: string,
 *   findings?: Array<{ code?: string, severity?: string }>,
 *   missingSymbols?: string[],
 * }} input
 * @returns {string} 64-char hex
 */
export function signatureOf(input) {
  const source = input && typeof input === 'object' ? input : {}
  const pkg = String(source.package ?? source.name ?? '')
  const version = String(source.version ?? '')
  const runtimeVersion = String(source.runtimeVersion ?? '')
  const codes = (Array.isArray(source.findings) ? source.findings : [])
    .filter((finding) => isPlainObject(finding) && (finding.severity === 'fail' || finding.severity === 'warn'))
    .map((finding) => String(finding.code || ''))
    .filter(Boolean)
    .sort()
  const codesText = [...new Set(codes)].join(',')
  const symbols = (Array.isArray(source.missingSymbols) ? source.missingSymbols : [])
    .map((symbol) => String(symbol || ''))
    .filter(Boolean)
    .sort()
  const symbolDigest = createHash('sha256').update(symbols.join(',')).digest('hex').slice(0, 16)
  return createHash('sha256')
    .update(`${pkg}@${version}|${runtimeVersion}|${codesText}|${symbolDigest}`)
    .digest('hex')
}

/** Stable dedupe key: repo + package + signature. */
export function dedupeKey(repo, pkg, signature) {
  return `${String(repo || '')}|${String(pkg || '')}|${String(signature || '')}`
}

/** Local calendar day key (not UTC: "3 per day" should follow the user's clock). */
export function dayKey(epochMs) {
  const date = new Date(epochMs)
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

/**
 * Create a store bound to one profile directory.
 *
 * @param {{
 *   profileDir?: string,
 *   fs?: { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, rmSync },
 *   now?: () => number,
 *   log?: (message: string) => void,
 * }} [options]
 */
export function createStore(options = {}) {
  const profileDir = typeof options.profileDir === 'string' ? options.profileDir : ''
  const fs = options.fs && typeof options.fs === 'object' ? options.fs : { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, rmSync }
  const now = typeof options.now === 'function' ? options.now : () => Date.now()
  const log = typeof options.log === 'function' ? options.log : () => {}

  let cached = null
  let lastCorrupt = null

  const dir = profileDir ? path.join(profileDir, STATE_DIRNAME) : ''
  const file = dir ? path.join(dir, STATE_FILENAME) : ''

  function ensureDir() {
    if (!dir) return false
    try {
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
      return true
    } catch (error) {
      log(`state dir unavailable: ${error && error.message ? error.message : error}`)
      return false
    }
  }

  function read() {
    if (cached) return cached
    if (!file) return (cached = emptyState())
    let text = ''
    try {
      if (!fs.existsSync(file)) return (cached = emptyState())
      text = fs.readFileSync(file, 'utf8')
    } catch (error) {
      log(`state unreadable: ${error && error.message ? error.message : error}`)
      return (cached = emptyState())
    }
    try {
      return (cached = normaliseState(JSON.parse(text)))
    } catch {
      // Corrupt: keep the evidence, start clean.
      const backup = `${file}.corrupt-${now()}`
      try {
        fs.renameSync(file, backup)
        lastCorrupt = backup
        log(`state corrupt; backed up to ${path.basename(backup)}`)
      } catch (error) {
        log(`state corrupt; backup failed: ${error && error.message ? error.message : error}`)
      }
      return (cached = emptyState())
    }
  }

  function write(state) {
    const normalised = normaliseState(state)
    normalised.nudges = normalised.nudges.slice(0, HISTORY_CAP)
    // Bound the maps so a pathological profile cannot grow the file forever.
    const signatureKeys = Object.keys(normalised.signatures)
    if (signatureKeys.length > NUDGE_KEYS_CAP) {
      const keep = signatureKeys
        .sort((a, b) => normalised.signatures[b].at - normalised.signatures[a].at)
        .slice(0, NUDGE_KEYS_CAP)
      const trimmed = {}
      for (const key of keep) trimmed[key] = normalised.signatures[key]
      normalised.signatures = trimmed
    }
    const reportKeys = Object.keys(normalised.reports)
    if (reportKeys.length > REPORT_CACHE_CAP) {
      const keep = reportKeys
        .sort((a, b) => normalised.reports[b].at - normalised.reports[a].at)
        .slice(0, REPORT_CACHE_CAP)
      const trimmed = {}
      for (const key of keep) trimmed[key] = normalised.reports[key]
      normalised.reports = trimmed
    }

    cached = normalised
    if (!ensureDir()) return normalised
    const tmp = `${file}.tmp-${process.pid}-${now()}`
    try {
      fs.writeFileSync(tmp, `${JSON.stringify(normalised, null, 2)}\n`, 'utf8')
      fs.renameSync(tmp, file)
    } catch (error) {
      log(`state write failed: ${error && error.message ? error.message : error}`)
      try { fs.rmSync(tmp, { force: true }) } catch { /* best effort */ }
    }
    return normalised
  }

  const store = {
    /** Absolute state file path ('' when no profile dir is known). */
    get path() { return file },
    /** Backup path created by the most recent corruption recovery, if any. */
    get corruptBackup() { return lastCorrupt },
    /** Force a re-read from disk on the next access. */
    invalidate() { cached = null },
    read,
    write,
    state: read,

    /** Append one nudge record (newest first) and remember its dedupe key. */
    recordNudge(record) {
      const state = read()
      const entry = {
        at: Number.isFinite(record && record.at) ? record.at : now(),
        package: String(record?.package || ''),
        version: String(record?.version || ''),
        runtimeVersion: String(record?.runtimeVersion || ''),
        repo: String(record?.repo || ''),
        signature: String(record?.signature || ''),
        mode: record?.mode === 'auto' ? 'auto' : 'draft',
        outcome: ['drafted', 'filed', 'duplicate', 'blocked'].includes(record?.outcome) ? record.outcome : 'drafted',
        url: typeof record?.url === 'string' ? record.url : null,
        number: Number.isFinite(record?.number) ? record.number : null,
      }
      state.nudges = [entry, ...state.nudges].slice(0, HISTORY_CAP)
      if (entry.repo && entry.signature) {
        const key = dedupeKey(entry.repo, entry.package, entry.signature)
        const previous = state.signatures[key]
        state.signatures[key] = {
          at: entry.at,
          count: (previous ? previous.count : 0) + 1,
          url: entry.url,
          number: entry.number,
        }
      }
      write(state)
      return entry
    },

    /** Newest-first nudge history. */
    history(limit = HISTORY_CAP) {
      const cap = Number.isFinite(limit) ? Math.max(0, Math.min(HISTORY_CAP, limit)) : HISTORY_CAP
      return read().nudges.slice(0, cap)
    },

    /**
     * Dedupe evaluation for one (repo, package, signature).
     * @returns {{ key: string, lastNudgedAt: number|null, allowedAt: number|null, duplicate: boolean }}
     */
    dedupeFor(repo, pkg, signature, renudgeAfterDays = 30, at = now()) {
      const key = dedupeKey(repo, pkg, signature)
      const entry = read().signatures[key]
      if (!entry) return { key, lastNudgedAt: null, allowedAt: null, duplicate: false }
      const days = Number.isFinite(renudgeAfterDays) && renudgeAfterDays > 0 ? renudgeAfterDays : 30
      const allowedAt = entry.at + days * 24 * 60 * 60 * 1000
      return { key, lastNudgedAt: entry.at, allowedAt, duplicate: at < allowedAt }
    },

    /** How many issues were actually filed today (drafts do not count). */
    countIssuesToday(at = now(), maxIssuesPerDay = 3) {
      const day = dayKey(at)
      const count = read().nudges.filter((entry) => entry.outcome === 'filed' && dayKey(entry.at) === day).length
      const cap = Number.isFinite(maxIssuesPerDay) && maxIssuesPerDay > 0 ? maxIssuesPerDay : 3
      return { count, allowed: count < cap, cap }
    },

    /** Cache one Report so overview() is cheap after the first inspection. */
    cacheReport(report) {
      if (!isPlainObject(report) || typeof report.name !== 'string' || !report.name) return
      const state = read()
      state.reports[report.name] = { at: now(), report }
      write(state)
    },

    /** Read a cached Report when it is younger than maxAgeMs. */
    cachedReport(name, maxAgeMs = 5 * 60 * 1000) {
      const entry = read().reports[String(name || '')]
      if (!entry) return null
      if (maxAgeMs >= 0 && now() - entry.at > maxAgeMs) return null
      return entry.report
    },

    /** Drop every cached Report (e.g. after `plugin-manager/changed`). */
    clearReports() {
      const state = read()
      if (Object.keys(state.reports).length === 0) return
      state.reports = {}
      write(state)
    },

    /** Forget one dedupe key (used by "nudge again" in the UI). */
    forgetSignature(repo, pkg, signature) {
      const state = read()
      const key = dedupeKey(repo, pkg, signature)
      if (!state.signatures[key]) return false
      delete state.signatures[key]
      write(state)
      return true
    },
  }
  return store
}

export default createStore
