// dsh-junpeng-jia — Host entry point.
//
// A zero-build, plain-ESM Cordis plugin. `apply(ctx, config)` does four things:
//   1. keeps the profile-row config (a Volatile-bearing object) for live reads;
//   2. registers the `junpengjia` service (Typert Remote backend for the panel)
//      in a fiber that has `settings`;
//   3. registers the `junpengjia` agent tool, calling the same service methods;
//   4. invalidates the cached Reports whenever the plugin composition changes.
//
// Why the config object is kept by reference rather than snapshotted: fields
// declared `.volatile()` in Config arrive as frozen `{ get() }` references. A
// `settings.update` writes into those references in place and emits
// `loader/volatile-update` — `apply()` does NOT run again. Every read therefore
// goes through config.js's `readConfig()`/`snapshotConfig()`, which re-`get()`.

import { Config } from './config.js'
import { Service, currentService } from './host/service.js'

export const name = 'dsh-junpeng-jia'

/** Hard dependencies of the Host half: the tool registry must exist. */
export const inject = ['tools']

export { Config }

/**
 * Tool parameter schema. The registry validates `arguments` against this as a
 * plain JSON Schema, so the root must be `type: 'object'`.
 */
const TOOL_SCHEMA = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: ['status', 'check', 'nudge'],
      description: 'status = list third-party plugins with grades; check = deep-inspect one plugin; nudge = prepare or file an update request.',
    },
    name: {
      type: 'string',
      description: 'Plugin package name, e.g. dsh-zgit. Required for check and nudge.',
    },
    mode: {
      type: 'string',
      enum: ['draft', 'auto'],
      description: 'For nudge: draft returns a pre-filled GitHub link, auto files the issue when a token and autoNudge are configured.',
    },
  },
  required: ['action'],
}

/** Compact text renderer for the agent tool result. */
function renderReport(report) {
  if (!report) return 'No report.'
  const lines = []
  lines.push(`${report.name}@${report.version} — ${report.grade.toUpperCase()}`)
  lines.push(`DeepSeek Harness ${report.runtimeVersion || 'unknown'} (${report.runtimeSource}) · repo: ${report.repo || 'none'}`)
  lines.push(`Plugin side: ${report.factorA.status} · Runtime side: ${report.factorB.status}`)
  const findings = Array.isArray(report.findings) ? report.findings : []
  const important = findings.filter((item) => item.severity !== 'info')
  if (important.length === 0) {
    lines.push('No failed or warning findings.')
  } else {
    lines.push('')
    for (const item of important) {
      const expected = item.expected ? ` expected ${item.expected}` : ''
      const actual = item.actual ? ` actual ${item.actual}` : ''
      lines.push(`- [${item.severity}] ${item.code} (${item.layer}): ${item.message}${expected}${actual}`)
    }
  }
  if (report.eligible) lines.push('', 'Eligible for an update request (grade red and a GitHub repository is known).')
  return lines.join('\n')
}

function renderStatus(overview) {
  const lines = []
  lines.push(`DeepSeek Harness ${overview.runtimeVersion || 'unknown'} (source: ${overview.runtimeSource}) · profile ${overview.profile}`)
  const bundles = Array.isArray(overview.bundles) ? overview.bundles : []
  if (bundles.length === 0) {
    lines.push('No third-party bundles are installed in this profile.')
    return lines.join('\n')
  }
  lines.push('')
  for (const bundle of bundles) {
    lines.push(`${bundle.name}@${bundle.version}: ${bundle.grade}${bundle.repo ? ` (${bundle.repo})` : ' (no repository)'} — ${bundle.counts.fail} fail, ${bundle.counts.warn} warn`)
  }
  return lines.join('\n')
}

/**
 * Cordis plugin entry point.
 *
 * @param {any} ctx Cordis context of this plugin's fiber
 * @param {any} config profile-row config (may hold Volatile references)
 */
export function apply(ctx, config) {
  // The service reads live values through readConfig()/snapshotConfig(), so only
  // the reference is needed here.

  // ── service ─────────────────────────────────────────────────────────────
  // The panel backend only exists in compositions that have Settings; a
  // headless profile keeps the agent tool and simply has no panel.
  ctx.inject(['settings'], (settingsCtx) => {
    settingsCtx.plugin(Service, config)
  })

  // ── agent tool ──────────────────────────────────────────────────────────
  // `ctx.tools.register` is available because of the static `inject`.
  ctx.effect(() => ctx.tools.register({
    name: 'junpengjia',
    description: 'Inspect DeepSeek Harness third-party plugin compatibility and, only for a red verdict with a known GitHub repository, prepare or file an update request. action=status lists plugins; check inspects one; nudge drafts or files an issue.',
    timeoutMs: 60_000,
    // Inspection walks a handful of package.json files and one service table;
    // it does not touch the network unless action=nudge files an issue.
    isConcurrencySafe: () => true,
    parameters: TOOL_SCHEMA,
    async execute(args) {
      const action = args && typeof args.action === 'string' ? args.action : ''
      const service = currentService()
      if (!service) {
        return 'ERROR: the junpengjia service is not active in this composition (no Settings service).'
      }
      const target = args && typeof args.name === 'string' ? args.name.trim() : ''
      try {
        if (action === 'status') {
          return renderStatus(await service.overview())
        }
        if (action === 'check') {
          if (!target) return 'ERROR: action=check requires `name`.'
          const result = await service.inspect(target)
          if (!result.ok) return `ERROR: ${result.error}`
          return renderReport(result.report)
        }
        if (action === 'nudge') {
          if (!target) return 'ERROR: action=nudge requires `name`.'
          const mode = args && args.mode === 'auto' ? 'auto' : 'draft'
          const result = await service.nudge(target, mode)
          if (!result.ok) return `ERROR: ${result.error}`
          const where = result.url ? `\n${result.url}` : ''
          const number = result.number !== null && result.number !== undefined ? ` #${result.number}` : ''
          return `${result.outcome.toUpperCase()}${number}: ${result.message}${where}`
        }
        return 'ERROR: action must be one of status, check, nudge.'
      } catch (error) {
        return `ERROR: ${error && error.message ? error.message : String(error)}`
      }
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
  }), 'dsh-junpeng-jia: agent tool')

  // ── cache invalidation ──────────────────────────────────────────────────
  // Install/uninstall/enable/disable and composition changes all land here. The
  // cached Reports describe the *previous* composition, so drop them; the panel
  // re-inspects on its next call.
  ctx.effect(() => ctx.on('plugin-manager/changed', () => {
    try {
      const service = currentService()
      if (service && service.store) service.store.clearReports()
    } catch { /* invalidation is best-effort */ }
  }), 'dsh-junpeng-jia: invalidate reports on plugin changes')
}
