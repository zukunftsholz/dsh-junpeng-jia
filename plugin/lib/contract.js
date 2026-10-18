// Shared contract between the Host half and the browser half.
//
// The browser bundle cannot import this file (it is loaded through the Client
// module loader, whose `require` only resolves the browser module table), so the
// same literals are duplicated in lib/client.js. Keep both in sync.
//
// Host-side modules must treat this file as the single source of truth for:
//   - the Remote namespace and method names,
//   - finding codes (stable, used in dedupe signatures and issue bodies),
//   - default settings.

export const PACKAGE = 'dsh-junpeng-jia'
export const ROW_ID = 'junpengjia'
export const NAMESPACE = 'junpengjia'
export const SERVICE_KEY = 'junpengjia'
export const TOKEN_REF = 'JUNPENG_JIA_GITHUB_TOKEN'
export const STATE_DIRNAME = '.junpeng-jia'
export const STATE_FILENAME = 'state.json'
export const ISSUE_LABEL_HINT = 'compatibility'
export const GENERATOR = `dsh-junpeng-jia (${PACKAGE})`

/** Remote methods, in the order the client expects them. */
export const REMOTE_METHODS = [
  'overview',
  'inspect',
  'nudge',
  'settings',
  'saveSettings',
  'setToken',
  'history',
]

/** Grades shown by the badge and used by the nudge gate. */
export const GRADES = ['green', 'yellow', 'red', 'unknown']

/** Layer ids of the inspection engine. */
export const LAYERS = ['manifest', 'resolution', 'symbols', 'activation']

/** Finding severities. */
export const SEVERITIES = ['info', 'warn', 'fail']

/**
 * Stable finding codes. A code is part of the dedupe signature, so never
 * renumber or reuse one; add a new code instead.
 */
export const CODES = {
  manifestUnreadable: 'manifest.unreadable',
  manifestEnginesMissing: 'manifest.engines-missing',
  manifestEnginesUnsatisfied: 'manifest.engines-unsatisfied',
  manifestPeerMissing: 'manifest.peer-missing',
  manifestPeerUnsatisfied: 'manifest.peer-unsatisfied',
  manifestBundlePatchMissing: 'manifest.bundle-patch-missing',
  manifestClientPlatform: 'manifest.client-platform',
  manifestClientInjectMissing: 'manifest.client-inject-missing',
  symbolsInjectMissing: 'symbols.inject-missing',
  symbolsInjectUnknown: 'symbols.inject-unknown',
  activationRowFailed: 'activation.row-failed',
  activationBundleError: 'activation.bundle-error',
  activationDisabled: 'activation.disabled',
  activationUnaddressable: 'activation.unaddressable',
  dshExempted: 'dsh.exempted',
  dshDenied: 'dsh.denied',
  dshRuntimeUnknown: 'dsh.runtime-unknown',
  repoMissing: 'repo.missing',
  repoNotGithub: 'repo.not-github',
}

/** Default settings; the Config schema must mirror these. */
export const DEFAULTS = {
  autoNudge: false,
  draftOnly: true,
  renudgeAfterDays: 30,
  maxIssuesPerDay: 3,
  runtimeVersionOverride: '',
  tokenRef: TOKEN_REF,
  repoOverrides: {},
  checkTimeoutMs: 5000,
  maxBundles: 100,
}

/** Per-call time budget for one bundle inspection. */
export const INSPECT_BUDGET_MS = 5000
