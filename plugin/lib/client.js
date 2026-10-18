// dsh-junpeng-jia — browser half: the compatibility badge, detail section and
// Plugins-page tab for third-party plugin bundles.
//
// Mechanics follow dsh-sekaisync-connect, the proven zero-build path on
// 0.2.1-rc.2:
//   - window.__ModuleLoader__.load({ id, factory(require) }); React comes from
//     require('react') only, so no @deepseek-ai/dsh-client-* import can drift.
//   - the Host service is reached through a hand-written TYPERT_REMOTE
//     contribution mounted with ctx.remote.$mount(). The gateway only checks
//     that every parameter codec's `mode` is 'strict' (requireStrictInputs) and
//     that a strict codec carries `typeSymbol` plus a create() factory; neither
//     create() nor parse() is ever called, so the placeholder codec below is
//     sufficient. Parameters travel positionally (the Host's SRC fallback wants
//     single-identifier names) and results as `src-json`.
//   - two-stage mount: $mount first, then ctx.inject([...], registerUi), so the
//     slot registrations run inside a fiber that already has remote.junpengjia.
//   - one <style> element, removed by the same effect that added it; only
//     --dsw-alias-* theme tokens are used so light and dark themes both work.
//   - slot components never see ctx: services stay in the apply closure and are
//     projected into the registration's `inject` factory (docs/subsystems/slots.md,
//     "Component inputs").
window.__ModuleLoader__.load({
  id: 'dsh-junpeng-jia',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const NS = 'junpengjia'
    const PKG = 'dsh-junpeng-jia'
    const NAMESPACE = 'junpengjia'
    const SERVICE = 'junpengjia'

    // Slot keys and registration ids. List slots key their entries by `id`.
    const SLOT_BADGE = 'plugins.detail.badge'
    const SLOT_SECTION = 'plugins.detail.section'
    const SLOT_TAB = 'plugins.tab'
    const ID_BADGE = 'junpengjia-badge'
    const ID_SECTION = 'junpengjia-section'
    const ID_TAB = 'junpengjia-tab'

    // Duplicated from lib/contract.js on purpose: the Client module loader
    // cannot resolve a relative import, and lib/contract.js is ESM for the Host.
    const LAYERS = ['manifest', 'resolution', 'symbols', 'activation']
    const GRADES = ['green', 'yellow', 'red', 'unknown']

    const OVERVIEW_TTL_MS = 20000
    const REPORT_TTL_MS = 60000
    const HISTORY_TTL_MS = 15000

    /**
     * Hand-written Typert Remote contribution: exposes the Host service
     * (namespace `junpengjia`, Cordis key `junpengjia`) as
     * ctx.remote.junpengjia.<method>(). One descriptor per method of
     * docs/API-CONTRACT.md, in contract order.
     */
    const codec = (typeSymbol) => ({
      mode: 'strict',
      typeSymbol,
      create: () => ({ parse: (value) => value }),
    })
    const param = (name, typeSymbol) => ({
      name,
      wire: name,
      source: 'json',
      codec: codec(typeSymbol),
    })
    const descriptor = (method, parameters) => ({
      id: `${PKG}#${NAMESPACE}/${method}`,
      service: SERVICE,
      namespace: NAMESPACE,
      method,
      invocation: { kind: 'direct' },
      parameters,
      result: { mode: 'src-json' },
    })
    const TYPERT_REMOTE = {
      package: PKG,
      descriptors: [
        descriptor('overview', []),
        descriptor('inspect', [param('name', `${PKG}#${NAMESPACE}/inspect:name`)]),
        descriptor('nudge', [
          param('name', `${PKG}#${NAMESPACE}/nudge:name`),
          param('mode', `${PKG}#${NAMESPACE}/nudge:mode`),
        ]),
        descriptor('settings', []),
        descriptor('saveSettings', [param('patch', `${PKG}#${NAMESPACE}/saveSettings:patch`)]),
        descriptor('setToken', [param('token', `${PKG}#${NAMESPACE}/setToken:token`)]),
        descriptor('history', []),
      ],
    }

    const CSS = `
.jpj-badge{display:inline-flex;align-items:center;gap:5px;padding:0 8px;border-radius:99px;
  border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);
  font-size:11px;line-height:18px;font-weight:600;white-space:nowrap;vertical-align:middle}
.jpj-dot{width:6px;height:6px;border-radius:50%;background:currentColor;flex:0 0 auto}
.jpj-badge-green{color:var(--dsw-alias-state-success-primary);border-color:var(--dsw-alias-state-success-primary)}
.jpj-badge-yellow{color:var(--dsw-alias-state-warn-primary);border-color:var(--dsw-alias-state-warn-primary)}
.jpj-badge-red{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}
.jpj-badge-unknown{color:var(--dsw-alias-label-secondary);border-color:var(--dsw-alias-border-l2)}

.jpj-section{display:block;margin-top:4px}
.jpj-card{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:12px 14px;
  background:var(--dsw-alias-bg-layer-1);display:flex;flex-direction:column;gap:10px}
.jpj-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.jpj-head-main{flex:1 1 220px;min-width:0;display:flex;flex-direction:column;gap:2px}
.jpj-title{margin:0;font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary);line-height:1.5}
.jpj-sub{margin:0;font-size:12px;line-height:1.6;color:var(--dsw-alias-label-secondary)}
.jpj-muted{font-size:12px;line-height:1.6;color:var(--dsw-alias-label-secondary)}
.jpj-label{font-size:11.5px;font-weight:600;letter-spacing:.02em;color:var(--dsw-alias-label-secondary)}
.jpj-block{display:flex;flex-direction:column;gap:6px}
.jpj-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.jpj-kv{display:flex;gap:10px;align-items:baseline;font-size:12.5px;line-height:1.6;flex-wrap:wrap}
.jpj-k{flex:0 0 auto;min-width:76px;color:var(--dsw-alias-label-secondary)}
.jpj-v{flex:1 1 160px;min-width:0;color:var(--dsw-alias-label-primary);word-break:break-word}
.jpj-mono{font-family:"SF Mono","JetBrains Mono","Fira Code",Consolas,Menlo,Courier,monospace;font-size:11.5px}
.jpj-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:2px 18px}

.jpj-btn{padding:5px 11px;border-radius:7px;border:1px solid var(--dsw-alias-border-l2);
  background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);
  font:inherit;font-size:12.5px;line-height:1.6;cursor:pointer;white-space:nowrap}
.jpj-btn:hover:not(:disabled){border-color:var(--dsw-alias-brand-primary)}
.jpj-btn:disabled{opacity:.5;cursor:default}
.jpj-btn-sm{padding:3px 9px;font-size:12px}
/* Filled brand button: the label uses bg-base, the one colour that reads against
   brand-primary in both themes (never a hard-coded #fff). */
.jpj-btn-primary{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);
  color:var(--dsw-alias-bg-base);font-weight:600}
.jpj-btn-primary:hover:not(:disabled){filter:brightness(1.08)}

.jpj-tag{display:inline-block;padding:0 7px;border-radius:99px;border:1px solid var(--dsw-alias-border-l2);
  font-size:11px;line-height:18px;color:var(--dsw-alias-label-secondary);white-space:nowrap}
.jpj-tag-green{color:var(--dsw-alias-state-success-primary);border-color:var(--dsw-alias-state-success-primary)}
.jpj-tag-yellow{color:var(--dsw-alias-state-warn-primary);border-color:var(--dsw-alias-state-warn-primary)}
.jpj-tag-red{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}
.jpj-tag-unknown{color:var(--dsw-alias-label-secondary);border-color:var(--dsw-alias-border-l2)}

.jpj-layers{display:flex;flex-direction:column;gap:5px}
.jpj-layer{display:flex;gap:8px;align-items:baseline;flex-wrap:wrap;font-size:12.5px;line-height:1.55}
.jpj-layer-name{flex:0 1 140px;min-width:0;color:var(--dsw-alias-label-primary)}
.jpj-layer-note{flex:1 1 160px;min-width:0;color:var(--dsw-alias-label-secondary);font-size:11.5px}

.jpj-findings{display:flex;flex-direction:column;gap:8px}
.jpj-finding{border-left:2px solid var(--dsw-alias-border-l2);padding-left:9px;
  display:flex;flex-direction:column;gap:3px}
.jpj-finding-fail{border-left-color:var(--dsw-alias-state-error-primary)}
.jpj-finding-warn{border-left-color:var(--dsw-alias-state-warn-primary)}
.jpj-finding-info{border-left-color:var(--dsw-alias-state-business-primary)}
.jpj-finding-head{display:flex;gap:8px;align-items:baseline;flex-wrap:wrap;font-size:12.5px}
.jpj-code{font-family:"SF Mono","JetBrains Mono","Fira Code",Consolas,Menlo,Courier,monospace;
  font-size:11px;color:var(--dsw-alias-label-secondary)}
.jpj-sev{font-size:10.5px;font-weight:600;letter-spacing:.02em}
.jpj-sev-fail{color:var(--dsw-alias-state-error-primary)}
.jpj-sev-warn{color:var(--dsw-alias-state-warn-primary)}
.jpj-sev-info{color:var(--dsw-alias-state-business-primary)}
.jpj-finding-msg{flex:1 1 200px;min-width:0;color:var(--dsw-alias-label-primary)}

.jpj-msg{display:flex;gap:8px;align-items:center;flex-wrap:wrap;padding:7px 10px;border-radius:7px;
  border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);font-size:12.5px;line-height:1.55}
.jpj-msg-err{color:var(--dsw-alias-state-error-primary)}
.jpj-msg-warn{color:var(--dsw-alias-state-warn-primary)}
.jpj-msg-ok{color:var(--dsw-alias-state-success-primary)}
.jpj-link{color:var(--dsw-alias-link);text-decoration:none;word-break:break-all}
.jpj-link:hover{text-decoration:underline}

.jpj-page{display:flex;flex-direction:column;gap:12px;min-width:0}
.jpj-list{display:flex;flex-direction:column;gap:8px}
.jpj-item{display:flex;align-items:flex-start;gap:12px;flex-wrap:wrap;
  border:1px solid var(--dsw-alias-border-l1);border-radius:9px;padding:10px 12px;
  background:var(--dsw-alias-bg-layer-1)}
.jpj-item-main{flex:1 1 240px;min-width:0;display:flex;flex-direction:column;gap:3px}
.jpj-item-name{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary);word-break:break-all}
.jpj-item-meta{display:flex;gap:12px;flex-wrap:wrap;font-size:11.5px;line-height:1.6;
  color:var(--dsw-alias-label-secondary)}
.jpj-item-actions{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-left:auto}
.jpj-empty{border:1px dashed var(--dsw-alias-border-l2);border-radius:10px;padding:18px;
  display:flex;flex-direction:column;gap:6px;background:var(--dsw-alias-bg-layer-1)}
.jpj-empty-title{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary)}
.jpj-scope{font-size:11.5px;line-height:1.65;color:var(--dsw-alias-label-tertiary);
  border-top:1px solid var(--dsw-alias-border-l1);padding-top:9px}
`

    /** Inject the panel stylesheet once; the returned effect removes it. */
    function installStyles() {
      const tagId = 'dsh-junpeng-jia/client.css'
      if (typeof document === 'undefined') return () => {}
      if (document.querySelector('style[data-plugin-css=' + JSON.stringify(tagId) + ']') !== null) return () => {}
      const tag = document.createElement('style')
      tag.dataset.plugin = PKG
      tag.dataset.pluginCss = tagId
      tag.textContent = CSS
      document.head.appendChild(tag)
      return () => { tag.remove() }
    }

    /* ----------------------------- small helpers ---------------------------- */

    const str = (value) => (value === null || value === undefined ? '' : String(value))
    const list = (value) => (Array.isArray(value) ? value : [])

    const pad2 = (value) => (value < 10 ? '0' + value : String(value))

    /** Locale-neutral absolute timestamp (YYYY-MM-DD HH:mm, local time). */
    function formatTime(input) {
      const stamp = Number(input)
      if (!Number.isFinite(stamp) || stamp <= 0) return ''
      const date = new Date(stamp)
      if (Number.isNaN(date.getTime())) return ''
      return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ` +
        `${pad2(date.getHours())}:${pad2(date.getMinutes())}`
    }

    function errorOf(error) {
      if (!error) return { message: 'unknown error' }
      if (typeof error === 'string') return { message: error }
      const code = str(error.code)
      const message = str(error.message) || code
      return { message: message || 'unknown error', code }
    }

    /**
     * Call one Remote method and flatten the transport envelope.
     * Resolves to {ok:true,value}|{ok:false,error}; it never rejects, so no
     * component render path can be broken by a failing Host call.
     */
    async function invoke(thunk) {
      try {
        const result = await thunk()
        if (result === null || result === undefined) return { ok: true, value: null }
        if (typeof result === 'object' && result.ok === false) return { ok: false, error: errorOf(result.error) }
        if (typeof result === 'object' && result.ok === true && 'value' in result) return { ok: true, value: result.value }
        return { ok: true, value: result }
      } catch (error) {
        return { ok: false, error: errorOf(error) }
      }
    }

    /**
     * Flatten the second envelope a service method may add inside `value`
     * (`inspect`/`nudge`/`saveSettings`/`setToken` answer with their own
     * `{ok,...}` per docs/API-CONTRACT.md). A plain payload passes through, so
     * the UI also works if a Host returns the payload directly.
     */
    function unwrapResult(value) {
      if (value === null || value === undefined) return { ok: false, error: { message: 'empty response' } }
      if (typeof value !== 'object') return { ok: false, error: { message: 'malformed response' } }
      if (value.ok === false) return { ok: false, error: errorOf(value.error) }
      if (value.ok === true) {
        if (value.report !== undefined) return { ok: true, value: value.report }
        if (value.settings !== undefined) return { ok: true, value: value.settings }
        if (value.entries !== undefined) return { ok: true, value }
        return { ok: true, value }
      }
      return { ok: true, value }
    }

    function gradeOf(value) {
      const grade = str(value)
      return GRADES.indexOf(grade) >= 0 ? grade : 'unknown'
    }

    const STATUSES = ['pass', 'warn', 'fail', 'skip']
    function statusOf(value) {
      const status = str(value)
      return STATUSES.indexOf(status) >= 0 ? status : 'skip'
    }

    const SEVERITIES = ['info', 'warn', 'fail']
    function severityOf(value) {
      const severity = str(value)
      return SEVERITIES.indexOf(severity) >= 0 ? severity : 'info'
    }

    function openExternal(url) {
      if (!url) return
      try {
        if (typeof window !== 'undefined' && typeof window.open === 'function') {
          window.open(url, '_blank', 'noopener,noreferrer')
        }
      } catch (error) {
        // A blocked popup must not break the flow; the link stays on screen.
      }
    }

    function copyText(text) {
      if (!text) return false
      try {
        if (typeof navigator !== 'undefined' && navigator.clipboard &&
          typeof navigator.clipboard.writeText === 'function') {
          navigator.clipboard.writeText(text).catch(() => {})
          return true
        }
      } catch (error) {
        // Clipboard is optional.
      }
      return false
    }

    /* ------------------------------ cache store ----------------------------- */

    /**
     * One shared read cache for every slot entry: the overview is fetched once
     * per TTL (and again after a manual action), a report is reused until it
     * goes stale, and history backs the "last update request" line.
     *
     * The store is created in registerUi and handed to components through the
     * registration `inject` factory; components never touch ctx.
     */
    function createStore(api) {
      const cache = {
        overview: null,
        overviewAt: 0,
        overviewError: '',
        overviewBusy: false,
        overviewPromise: null,
        reports: new Map(),
        reportPromises: new Map(),
        history: null,
        historyAt: 0,
        historyError: '',
        historyPromise: null,
        listeners: new Set(),
      }

      function emit() {
        for (const listener of Array.from(cache.listeners)) {
          try { listener() } catch (error) { /* one broken subscriber must not stop the rest */ }
        }
      }

      function subscribe(listener) {
        cache.listeners.add(listener)
        return () => { cache.listeners.delete(listener) }
      }

      function getOverview() { return cache.overview }
      function getOverviewError() { return cache.overviewError }
      function isOverviewBusy() { return cache.overviewBusy }

      function lookupBundle(name) {
        const bundles = cache.overview ? list(cache.overview.bundles) : []
        for (const bundle of bundles) {
          if (bundle && bundle.name === name) return bundle
        }
        return null
      }

      function getSettings() {
        const settings = cache.overview ? cache.overview.settings : null
        return settings && typeof settings === 'object' ? settings : null
      }

      function getOverviewRuntime() {
        const overview = cache.overview
        return {
          runtimeVersion: str(overview && overview.runtimeVersion),
          runtimeSource: str(overview && overview.runtimeSource),
          profile: str(overview && overview.profile),
          checkedAt: Number(overview && overview.checkedAt) || 0,
        }
      }

      function ensureOverview(force) {
        const now = Date.now()
        if (!force && cache.overview && now - cache.overviewAt < OVERVIEW_TTL_MS) {
          return Promise.resolve({ ok: true, value: cache.overview })
        }
        if (cache.overviewPromise) return cache.overviewPromise
        cache.overviewBusy = true
        emit()
        const promise = (async () => {
          const result = await invoke(api.overview)
          if (result.ok && result.value && typeof result.value === 'object') {
            cache.overview = result.value
            cache.overviewAt = Date.now()
            cache.overviewError = ''
          } else if (!result.ok) {
            cache.overviewError = result.error.message
          } else {
            cache.overviewError = 'overview: malformed response'
          }
          cache.overviewBusy = false
          cache.overviewPromise = null
          emit()
          return cache.overview
            ? { ok: true, value: cache.overview }
            : { ok: false, error: { message: cache.overviewError || 'overview unavailable' } }
        })()
        cache.overviewPromise = promise
        return promise
      }

      /** Last read of one bundle's report: {report, error, at, busy} or null. */
      function getReport(name) { return cache.reports.get(name) || null }

      function loadReport(name, force) {
        if (!name) return Promise.resolve({ ok: false, error: { message: 'missing bundle name' } })
        const existing = cache.reports.get(name)
        const now = Date.now()
        if (!force && existing && existing.report && now - existing.at < REPORT_TTL_MS) {
          return Promise.resolve({ ok: true, value: existing.report })
        }
        const inFlight = cache.reportPromises.get(name)
        if (inFlight) return inFlight

        cache.reports.set(name, {
          report: existing ? existing.report : null,
          error: '',
          at: existing ? existing.at : 0,
          busy: true,
        })
        emit()

        const promise = (async () => {
          const result = await invoke(() => api.inspect(name))
          const flattened = result.ok ? unwrapResult(result.value) : result
          const current = cache.reports.get(name)
          if (flattened.ok && flattened.value && typeof flattened.value === 'object') {
            cache.reports.set(name, { report: flattened.value, error: '', at: Date.now(), busy: false })
          } else {
            cache.reports.set(name, {
              report: current && current.report ? current.report : null,
              error: flattened.ok ? 'inspect: malformed report' : flattened.error.message,
              at: current && current.at ? current.at : 0,
              busy: false,
            })
          }
          cache.reportPromises.delete(name)
          emit()
          return flattened
        })()
        cache.reportPromises.set(name, promise)
        return promise
      }

      function ensureHistory(force) {
        const now = Date.now()
        if (!force && cache.history && now - cache.historyAt < HISTORY_TTL_MS) {
          return Promise.resolve({ ok: true, value: cache.history })
        }
        if (cache.historyPromise) return cache.historyPromise
        const promise = (async () => {
          const result = await invoke(api.history)
          const flattened = result.ok ? unwrapResult(result.value) : result
          if (flattened.ok && flattened.value && typeof flattened.value === 'object') {
            cache.history = flattened.value
            cache.historyAt = Date.now()
            cache.historyError = ''
          } else {
            cache.historyError = flattened.ok ? 'history: malformed response' : flattened.error.message
          }
          cache.historyPromise = null
          emit()
          return cache.history
            ? { ok: true, value: cache.history }
            : { ok: false, error: { message: cache.historyError || 'history unavailable' } }
        })()
        cache.historyPromise = promise
        return promise
      }

      /** Newest history record for one package, if any. */
      function latestNudgeRecord(name) {
        const entries = cache.history ? list(cache.history.entries) : []
        for (const entry of entries) {
          if (entry && entry.package === name) return entry
        }
        return null
      }

      function nudge(name, mode) {
        return invoke(() => api.nudge(name, mode)).then((result) => {
          if (!result.ok) return result
          const flattened = unwrapResult(result.value)
          if (flattened.ok) {
            // A nudge changes the dedupe window: let the next read refill.
            cache.historyAt = 0
            const current = cache.reports.get(name)
            if (current) cache.reports.set(name, { report: current.report, error: current.error, at: 0, busy: current.busy })
            emit()
          }
          return flattened
        })
      }

      return {
        subscribe,
        getOverview,
        getOverviewError,
        getOverviewRuntime,
        isOverviewBusy,
        ensureOverview,
        lookupBundle,
        getSettings,
        getReport,
        loadReport,
        ensureHistory,
        latestNudgeRecord,
        nudge,
      }
    }

    /** Re-render the calling component whenever the shared cache changes. */
    function useStoreVersion(store) {
      const [, setVersion] = React.useState(0)
      React.useEffect(() => {
        if (!store || typeof store.subscribe !== 'function') return undefined
        return store.subscribe(() => setVersion((value) => value + 1))
      }, [store])
    }

    /* ------------------------------- atoms --------------------------------- */

    function Kv(props) {
      const value = props.value
      const empty = value === '' || value === null || value === undefined
      return h('div', { className: 'jpj-kv' },
        h('span', { className: 'jpj-k' }, props.label),
        h('span', { className: 'jpj-v' }, empty ? '—' : value))
    }

    function GradeTag(props) {
      const grade = gradeOf(props.grade)
      return h('span', { className: 'jpj-tag jpj-tag-' + grade }, props.t('grade_' + grade))
    }

    function Notice(props) {
      const { t, notice } = props
      const [copied, setCopied] = React.useState(false)
      React.useEffect(() => { setCopied(false) }, [notice])
      if (!notice || !notice.text) return null
      const url = str(notice.url)
      return h('div', { className: 'jpj-msg jpj-msg-' + (notice.tone || 'warn') },
        h('span', null, notice.text),
        url ? h('a', {
          className: 'jpj-link',
          href: url,
          target: '_blank',
          rel: 'noreferrer noopener',
        }, t('openLink')) : null,
        url ? h('button', {
          className: 'jpj-btn jpj-btn-sm',
          type: 'button',
          onClick: () => { if (copyText(url)) setCopied(true) },
        }, copied ? t('copied') : t('copyLink')) : null)
    }

    function LayerRow(props) {
      const { t, layer } = props
      const id = str(layer && layer.id)
      const status = statusOf(layer && layer.status)
      const label = str(layer && layer.label) || t('layer_' + (LAYERS.indexOf(id) >= 0 ? id : 'manifest'))
      const findingCount = list(layer && layer.findings).length
      const note = status === 'skip'
        ? t('status_skip')
        : (findingCount > 0 ? t('layerFindingCount', { count: findingCount }) : t('status_' + status))
      return h('div', { className: 'jpj-layer' },
        h('span', { className: 'jpj-layer-name' }, label),
        h('span', { className: 'jpj-tag jpj-tag-' + (status === 'pass' ? 'green' : status === 'warn' ? 'yellow' : status === 'fail' ? 'red' : 'unknown') },
          status === 'skip' ? t('status_skip') : t('status_' + status)),
        h('span', { className: 'jpj-layer-note' }, note))
    }

    function FindingItem(props) {
      const { t, finding } = props
      const severity = severityOf(finding && finding.severity)
      const expected = str(finding && finding.expected)
      const actual = str(finding && finding.actual)
      const hint = str(finding && finding.hint)
      const code = str(finding && finding.code)
      return h('div', { className: 'jpj-finding jpj-finding-' + severity },
        h('div', { className: 'jpj-finding-head' },
          h('span', { className: 'jpj-sev jpj-sev-' + severity }, t('severity_' + severity)),
          h('span', { className: 'jpj-finding-msg' }, str(finding && finding.message) || code),
          code ? h('span', { className: 'jpj-code' }, code) : null),
        expected || actual ? h('div', { className: 'jpj-kv' },
          expected ? h('span', { className: 'jpj-k' }, t('expectedLabel')) : null,
          expected ? h('span', { className: 'jpj-v jpj-mono' }, expected) : null,
          actual ? h('span', { className: 'jpj-k' }, t('actualLabel')) : null,
          actual ? h('span', { className: 'jpj-v jpj-mono' }, actual) : null) : null,
        hint ? h('div', { className: 'jpj-muted' }, t('hintLabel') + ': ' + hint) : null)
    }

    function outcomeText(t, state) {
      const known = ['drafted', 'filed', 'duplicate', 'blocked', 'none']
      return known.indexOf(state) >= 0 ? t('outcome_' + state) : state
    }

    /* ------------------------------- badge --------------------------------- */

    /**
     * `plugins.detail.badge` — one small status tag for a third-party bundle.
     * Rows and official plugins render null; the overview is read from the
     * shared cache (one fetch per open, forced only by a manual action).
     */
    function JunpengJiaBadge(props) {
      const { t, store, subject } = props
      useStoreVersion(store)
      const name = subject && subject.kind === 'bundle' && subject.pkg && !subject.pkg.official
        ? str(subject.pkg.name)
        : ''
      React.useEffect(() => {
        if (!name || !store) return undefined
        store.ensureOverview(false)
        return undefined
      }, [store, name])
      if (!name) return null

      const bundle = store.lookupBundle(name)
      const grade = gradeOf(bundle && bundle.grade)
      const checkedAt = formatTime(bundle && bundle.lastCheckedAt)
      const detail = checkedAt
        ? t('badgeTitleChecked', { grade: t('grade_' + grade), when: checkedAt })
        : t('badgeTitle', { grade: t('grade_' + grade) })
      return h('span', {
        className: 'jpj-badge jpj-badge-' + grade,
        title: detail,
        'data-jpj-badge': grade,
      },
        h('span', { className: 'jpj-dot' }),
        t('grade_' + grade))
    }

    /* ------------------------------ section -------------------------------- */

    /**
     * `plugins.detail.section` — the full verdict for a third-party bundle:
     * grade, runtime, the four layers, every finding, the two actions and the
     * last update-request record. Renders null for every other subject.
     */
    function JunpengJiaSection(props) {
      const { t, store, subject } = props
      useStoreVersion(store)

      const name = subject && subject.kind === 'bundle' && subject.pkg && !subject.pkg.official
        ? str(subject.pkg.name)
        : ''

      React.useEffect(() => {
        if (!name || !store) return undefined
        store.ensureOverview(false)
        store.loadReport(name, false)
        store.ensureHistory(false)
        return undefined
      }, [store, name])

      const [busy, setBusy] = React.useState('')
      const [notice, setNotice] = React.useState(null)

      const onDeepCheck = React.useCallback(async () => {
        if (!name) return
        setBusy('inspect')
        setNotice(null)
        try {
          const result = await store.loadReport(name, true)
          if (!result.ok) setNotice({ tone: 'err', text: result.error.message })
          await store.ensureOverview(true)
        } finally {
          setBusy('')
        }
      }, [store, name])

      const onNudge = React.useCallback(async () => {
        if (!name) return
        const settings = store.getSettings() || {}
        const autoMode = !!(settings.autoNudge && !settings.draftOnly)
        setBusy('nudge')
        setNotice(null)
        try {
          const result = await store.nudge(name, autoMode ? 'auto' : 'draft')
          if (!result.ok) {
            setNotice({ tone: 'err', text: result.error.message })
            return
          }
          const value = result.value && typeof result.value === 'object' ? result.value : {}
          const outcome = str(value.outcome)
          const url = str(value.url)
          if (outcome === 'drafted' || outcome === 'filed') {
            const head = outcome === 'filed' && value.number
              ? t('outcome_filed_number', { number: String(value.number) })
              : outcomeText(t, outcome)
            setNotice({ tone: 'ok', text: head, url })
            openExternal(url)
          } else if (outcome === 'duplicate') {
            setNotice({ tone: 'warn', text: str(value.message) || t('outcome_duplicate') })
          } else {
            setNotice({ tone: 'warn', text: str(value.message) || t('outcome_blocked') })
          }
          await store.ensureOverview(true)
          await store.ensureHistory(true)
        } finally {
          setBusy('')
        }
      }, [store, name, t])

      if (!name) return null

      const entry = store.getReport(name)
      const report = entry && entry.report ? entry.report : null
      const summary = store.lookupBundle(name)
      const grade = gradeOf((report && report.grade) || (summary && summary.grade))
      const runtime = store.getOverviewRuntime()
      const runtimeVersion = str(report && report.runtimeVersion) || runtime.runtimeVersion
      const runtimeSource = str(report && report.runtimeSource) || runtime.runtimeSource
      const repo = str((report && report.repo) || (summary && summary.repo))
      const checkedAt = formatTime((report && report.checkedAt) || (summary && summary.lastCheckedAt))
      const settings = store.getSettings() || {}
      const autoMode = !!(settings.autoNudge && !settings.draftOnly)
      const eligible = !!report && !!repo && grade === 'red'
      const blockedReason = !report
        ? ''
        : (!repo ? t('blockedNoRepo') : (grade !== 'red' ? t('blockedNotRed') : ''))

      const layers = report && list(report.layers).length > 0
        ? list(report.layers)
        : LAYERS.map((id) => ({ id, status: 'skip', findings: [] }))
      const findings = list(report && report.findings)
      const activation = report && report.activation ? report.activation : null
      const failedRows = activation
        ? list(activation.rows).filter((row) => str(row && row.fiberPhase) === 'failed')
        : []

      const historyRecord = store.latestNudgeRecord(name)
      const summaryNudge = summary && summary.nudge ? summary.nudge : null
      const recordAt = Number((historyRecord && historyRecord.at) || (summaryNudge && summaryNudge.at)) || 0
      const recordState = str((historyRecord && historyRecord.outcome) || (summaryNudge && summaryNudge.state))
      const recordUrl = str((historyRecord && historyRecord.url) || (summaryNudge && summaryNudge.url))
      const hasRecord = !!(recordAt || recordState)

      return h('section', { className: 'jpj-section', 'data-jpj-section': name },
        h('div', { className: 'jpj-card' },
          h('div', { className: 'jpj-head' },
            h('h4', { className: 'jpj-title' }, t('sectionTitle')),
            h(GradeTag, { t, grade }),
            entry && entry.busy ? h('span', { className: 'jpj-muted' }, t('deepChecking')) : null),
          h('p', { className: 'jpj-sub' }, t('sectionSub')),

          h('div', { className: 'jpj-grid' },
            h(Kv, { label: t('gradeLabel'), value: t('grade_' + grade) }),
            h(Kv, { label: t('runtimeLabel'), value: runtimeVersion || t('runtimeUnknown') }),
            h(Kv, { label: t('runtimeSourceLabel'), value: runtimeSource || t('runtimeUnknown') }),
            h(Kv, { label: t('repoLabel'), value: repo || t('noRepo') }),
            h(Kv, { label: t('checkedAtLabel'), value: checkedAt || t('notChecked') })),

          h('div', { className: 'jpj-block' },
            h('div', { className: 'jpj-label' }, t('layersLabel')),
            report
              ? h('div', { className: 'jpj-layers' }, layers.map((layer, index) => h(LayerRow, {
                key: str(layer && layer.id) || 'layer-' + index,
                t,
                layer,
              })))
              : h('div', { className: 'jpj-muted' }, t('sectionIdle'))),

          report && activation && (list(activation.rows).length > 0 || activation.error)
            ? h('div', { className: 'jpj-block' },
              h('div', { className: 'jpj-label' }, t('activationLabel')),
              h('div', { className: 'jpj-muted' }, failedRows.length > 0
                ? t('activationFailed', { rows: failedRows.map((row) => str(row && row.rowId)).join(', ') })
                : t('activationOk', { count: String(list(activation.rows).length) })),
              activation.error ? h('div', { className: 'jpj-msg jpj-msg-err' }, str(activation.error)) : null)
            : null,

          report
            ? h('div', { className: 'jpj-block' },
              h('div', { className: 'jpj-label' }, t('findingsLabel')),
              findings.length === 0
                ? h('div', { className: 'jpj-muted' }, t('findingsEmpty'))
                : h('div', { className: 'jpj-findings' }, findings.map((finding, index) => h(FindingItem, {
                  key: (str(finding && finding.code) || 'finding') + ':' + index,
                  t,
                  finding,
                }))))
            : null,

          entry && entry.error ? h('div', { className: 'jpj-msg jpj-msg-err' }, entry.error) : null,

          h('div', { className: 'jpj-row' },
            h('button', {
              className: 'jpj-btn',
              type: 'button',
              disabled: busy !== '',
              onClick: onDeepCheck,
            }, busy === 'inspect' ? t('deepChecking') : (report ? t('recheck') : t('deepCheck'))),
            h('button', {
              className: 'jpj-btn jpj-btn-primary',
              type: 'button',
              disabled: busy !== '' || !eligible,
              title: blockedReason,
              onClick: onNudge,
            }, busy === 'nudge' ? t('draftPreparing') : (autoMode ? t('fileIssue') : t('draftRequest')))),

          blockedReason ? h('div', { className: 'jpj-muted' }, blockedReason) : null,
          autoMode ? h('div', { className: 'jpj-muted' }, t('autoHint')) : null,
          h(Notice, { t, notice }),

          h('div', { className: 'jpj-kv' },
            h('span', { className: 'jpj-k' }, t('nudgeLabel')),
            h('span', { className: 'jpj-v' },
              hasRecord
                ? (recordState ? outcomeText(t, recordState) : t('nudgeNone'))
                : t('nudgeNone'),
              hasRecord && recordAt ? h('span', { className: 'jpj-mono' }, ' · ' + formatTime(recordAt)) : null,
              recordUrl ? h('a', {
                className: 'jpj-link',
                href: recordUrl,
                target: '_blank',
                rel: 'noreferrer noopener',
              }, ' · ' + t('openLink')) : null))))
    }

    /* --------------------------------- tab --------------------------------- */

    /** One bundle row of the Compatibility tab. */
    function BundleRow(props) {
      const { t, store, bundle, pending, onCheck, onDraft } = props
      const name = str(bundle && bundle.name)
      const grade = gradeOf(bundle && bundle.grade)
      const repo = str(bundle && bundle.repo)
      const version = str(bundle && bundle.version)
      const title = str(bundle && bundle.title)
      const checkedAt = formatTime(bundle && bundle.lastCheckedAt)
      const eligible = grade === 'red' && !!repo
      const reason = !repo ? t('blockedNoRepo') : (grade !== 'red' ? t('blockedNotRed') : '')
      const entry = store.getReport(name)
      const reportBusy = !!(entry && entry.busy)
      const checking = reportBusy || pending === 'check:' + name
      const drafting = pending === 'draft:' + name
      const globalBusy = pending === 'all' || pending === 'refresh'

      return h('div', { className: 'jpj-item', 'data-jpj-bundle': name },
        h('div', { className: 'jpj-item-main' },
          h('div', { className: 'jpj-item-name' }, title && title !== name ? title : name),
          title && title !== name ? h('div', { className: 'jpj-mono jpj-muted' }, name) : null,
          h('div', { className: 'jpj-item-meta' },
            h('span', { className: 'jpj-mono' }, version ? 'v' + version : '—'),
            h('span', null, repo || t('noRepo')),
            h('span', null, checkedAt || t('neverChecked')),
            bundle && bundle.stale ? h('span', null, t('stale')) : null)),
        h('div', { className: 'jpj-item-actions' },
          h(GradeTag, { t, grade }),
          h('button', {
            className: 'jpj-btn jpj-btn-sm',
            type: 'button',
            disabled: globalBusy || checking,
            onClick: () => onCheck(name),
          }, checking ? t('checking') : t('check')),
          h('button', {
            className: 'jpj-btn jpj-btn-sm',
            type: 'button',
            disabled: globalBusy || pending !== '' || !eligible,
            title: reason,
            onClick: () => onDraft(name),
          }, drafting ? t('draftPreparing') : t('draft'))))
    }

    /**
     * `plugins.tab` — the Compatibility page: every third-party bundle with its
     * grade and the two per-row actions, plus a Check-all button and an empty
     * state that explains what the detection scope is.
     *
     * The owner props (`install`, `openPackage`) are deliberately not used: this
     * page only reads and reports.
     */
    function JunpengJiaTab(props) {
      const { t, store } = props
      useStoreVersion(store)

      React.useEffect(() => {
        if (!store) return undefined
        store.ensureOverview(false)
        store.ensureHistory(false)
        return undefined
      }, [store])

      const [pending, setPending] = React.useState('')
      const [notice, setNotice] = React.useState(null)

      const onRefresh = React.useCallback(async () => {
        setPending('refresh')
        setNotice(null)
        try {
          const result = await store.ensureOverview(true)
          if (!result.ok) setNotice({ tone: 'err', text: result.error.message })
          await store.ensureHistory(true)
        } finally {
          setPending('')
        }
      }, [store])

      const onCheck = React.useCallback(async (name) => {
        if (!name) return
        setPending('check:' + name)
        setNotice(null)
        try {
          const result = await store.loadReport(name, true)
          if (!result.ok) setNotice({ tone: 'err', text: result.error.message })
          await store.ensureOverview(true)
        } finally {
          setPending('')
        }
      }, [store])

      const onDraft = React.useCallback(async (name) => {
        if (!name) return
        setPending('draft:' + name)
        setNotice(null)
        try {
          const result = await store.nudge(name, 'draft')
          if (!result.ok) {
            setNotice({ tone: 'err', text: result.error.message })
            return
          }
          const value = result.value && typeof result.value === 'object' ? result.value : {}
          const outcome = str(value.outcome)
          const url = str(value.url)
          if (outcome === 'drafted' || outcome === 'filed') {
            const head = outcome === 'filed' && value.number
              ? t('outcome_filed_number', { number: String(value.number) })
              : outcomeText(t, outcome)
            setNotice({ tone: 'ok', text: head, url })
            openExternal(url)
          } else if (outcome === 'duplicate') {
            setNotice({ tone: 'warn', text: str(value.message) || t('outcome_duplicate') })
          } else {
            setNotice({ tone: 'warn', text: str(value.message) || t('outcome_blocked') })
          }
          await store.ensureOverview(true)
          await store.ensureHistory(true)
        } finally {
          setPending('')
        }
      }, [store, t])

      const onCheckAll = React.useCallback(async () => {
        const overview = store.getOverview()
        const names = list(overview && overview.bundles).map((bundle) => str(bundle && bundle.name)).filter(Boolean)
        setPending('all')
        setNotice(null)
        try {
          if (names.length === 0) {
            await store.ensureOverview(true)
            return
          }
          const results = await Promise.all(names.map((name) => store.loadReport(name, true)))
          const failed = results.filter((result) => !result || !result.ok).length
          await store.ensureOverview(true)
          setNotice(failed > 0
            ? { tone: 'warn', text: t('checkAllPartial', { total: String(names.length), failed: String(failed) }) }
            : { tone: 'ok', text: t('checkAllDone', { total: String(names.length) }) })
        } finally {
          setPending('')
        }
      }, [store, t])

      const overview = store.getOverview()
      const bundles = list(overview && overview.bundles)
      const runtime = store.getOverviewRuntime()
      const overviewError = store.getOverviewError()
      const loading = !overview && store.isOverviewBusy()
      const meta = runtime.runtimeVersion
        ? t('overviewMeta', {
          runtime: runtime.runtimeVersion,
          profile: runtime.profile || '—',
          when: formatTime(runtime.checkedAt) || '—',
        })
        : ''
      const draftTitle = t('tabDraftHint')

      return h('div', { className: 'jpj-page', 'data-jpj-tab': 'compatibility' },
        h('div', { className: 'jpj-head' },
          h('div', { className: 'jpj-head-main' },
            h('div', { className: 'jpj-title' }, t('tabTitle')),
            h('div', { className: 'jpj-sub' }, t('tabIntro'))),
          h('div', { className: 'jpj-row' },
            h('button', {
              className: 'jpj-btn',
              type: 'button',
              disabled: pending !== '',
              title: draftTitle,
              onClick: onRefresh,
            }, pending === 'refresh' ? t('refreshing') : t('refresh')),
            h('button', {
              className: 'jpj-btn jpj-btn-primary',
              type: 'button',
              disabled: pending !== '' || bundles.length === 0,
              onClick: onCheckAll,
            }, pending === 'all' ? t('checkingAll') : t('checkAll')))),

        meta ? h('div', { className: 'jpj-muted' }, meta) : null,
        overviewError ? h('div', { className: 'jpj-msg jpj-msg-err' }, overviewError) : null,
        loading ? h('div', { className: 'jpj-muted' }, t('loading')) : null,
        h(Notice, { t, notice }),

        overview && bundles.length === 0
          ? h('div', { className: 'jpj-empty' },
            h('div', { className: 'jpj-empty-title' }, t('emptyTitle')),
            h('div', { className: 'jpj-sub' }, t('emptyBody')))
          : null,

        bundles.length > 0
          ? h('div', { className: 'jpj-list' }, bundles.map((bundle, index) => h(BundleRow, {
            key: str(bundle && bundle.name) || 'bundle-' + index,
            t,
            store,
            bundle,
            pending,
            onCheck,
            onDraft,
          })))
          : null,

        h('div', { className: 'jpj-scope' }, t('scopeNote')))
    }

    /* ------------------------------ dictionaries --------------------------- */

    const ZH = {
      // badge
      grade_green: '兼容',
      grade_yellow: '需关注',
      grade_red: '不兼容',
      grade_unknown: '未检测',
      badgeTitle: '兼容性等级：{grade}',
      badgeTitleChecked: '兼容性等级：{grade}，检测于 {when}',

      // section
      sectionTitle: '兼容性检测',
      sectionSub: '以当前运行的 DSH 版本为基准，对插件侧与运行时侧分别判定；两侧同时不兼容时才可发起催更。',
      sectionIdle: '尚未检测，点击「深度检测」获取结果。',
      gradeLabel: '等级',
      runtimeLabel: '运行版本',
      runtimeSourceLabel: '版本来源',
      runtimeUnknown: '未知',
      repoLabel: '仓库',
      checkedAtLabel: '检测时间',
      layersLabel: '四层检测',
      layer_manifest: 'L1 清单声明',
      layer_resolution: 'L2 依赖解析',
      layer_symbols: 'L3 运行时符号',
      layer_activation: 'L4 装载状态',
      status_pass: '通过',
      status_warn: '警告',
      status_fail: '不通过',
      status_skip: '跳过',
      layerFindingCount: '{count} 项发现',
      activationLabel: '插件行',
      activationOk: '{count} 个插件行在册。',
      activationFailed: '装载失败的插件行：{rows}',
      findingsLabel: '发现项',
      findingsEmpty: '未发现不兼容项。',
      severity_info: '提示',
      severity_warn: '警告',
      severity_fail: '失败',
      expectedLabel: '期望',
      actualLabel: '实际',
      hintLabel: '建议',
      deepCheck: '深度检测',
      deepChecking: '检测中…',
      recheck: '重新检测',
      draftRequest: '生成催更草稿',
      draftPreparing: '生成中…',
      fileIssue: '提交 issue',
      blockedNoRepo: '该插件未声明 GitHub 仓库，无法发起催更。',
      blockedNotRed: '仅当插件侧与运行时侧同时不兼容时才能发起催更。',
      autoHint: '已开启自动提交：该按钮会直接调用 GitHub 接口提交 issue。',
      nudgeLabel: '最近催更',
      nudgeNone: '暂无记录',
      outcome_drafted: '已生成催更草稿',
      outcome_filed: '已提交 issue',
      outcome_filed_number: '已提交 issue #{number}',
      outcome_duplicate: '同一不兼容签名已提交过，去重窗口内不再重复提交。',
      outcome_blocked: '本次催更未通过准入条件。',
      outcome_none: '暂无记录',
      openLink: '打开',
      copyLink: '复制链接',
      copied: '已复制',

      // tab
      tabTitle: '兼容性',
      tabIntro: '检查当前 profile 中安装的第三方插件 bundle 与正在运行的 DSH 版本是否兼容。',
      overviewMeta: '运行版本 {runtime} · profile {profile} · 检测于 {when}',
      loading: '正在读取插件清单…',
      checkAll: '全部检测',
      checkingAll: '检测中…',
      refresh: '刷新',
      refreshing: '刷新中…',
      check: '检测',
      checking: '检测中…',
      draft: '草稿',
      draftPreparing: '生成中…',
      notChecked: '未检测',
      neverChecked: '从未检测',
      noRepo: '未声明仓库',
      stale: '结果已过期',
      emptyTitle: '未检测到第三方插件',
      emptyBody: '本页只检测当前 profile 以依赖形式安装、且带 bundle patch 的第三方插件；DSH 随附的官方插件不在检测范围内，其准入由 DSH 自身判断。安装或启用插件后刷新本页即可看到结果。',
      checkAllDone: '已完成 {total} 个插件的检测。',
      checkAllPartial: '{total} 个插件中 {failed} 个检测失败，请查看各自详情。',
      scopeNote: '检测全程只读：读取清单声明、依赖解析版本、入口产物的 inject 列表与 Loader 装载状态，不执行第三方插件代码，不上传本机路径、用户名或会话内容。',
      tabDraftHint: '刷新会重新读取插件清单与检测缓存。',
    }

    const EN = {
      // badge
      grade_green: 'Compatible',
      grade_yellow: 'Needs attention',
      grade_red: 'Incompatible',
      grade_unknown: 'Not checked',
      badgeTitle: 'Compatibility grade: {grade}',
      badgeTitleChecked: 'Compatibility grade: {grade}, checked {when}',

      // section
      sectionTitle: 'Compatibility check',
      sectionSub: 'Grades the plugin side and the runtime side separately against the running DSH version; an update request is offered only when both sides are unsupported.',
      sectionIdle: 'Not checked yet. Select Run deep check to read the verdict.',
      gradeLabel: 'Grade',
      runtimeLabel: 'Runtime',
      runtimeSourceLabel: 'Version source',
      runtimeUnknown: 'Unknown',
      repoLabel: 'Repository',
      checkedAtLabel: 'Checked',
      layersLabel: 'Four layers',
      layer_manifest: 'L1 Manifest',
      layer_resolution: 'L2 Resolution',
      layer_symbols: 'L3 Runtime symbols',
      layer_activation: 'L4 Activation',
      status_pass: 'Pass',
      status_warn: 'Warning',
      status_fail: 'Fail',
      status_skip: 'Skipped',
      layerFindingCount: '{count} findings',
      activationLabel: 'Plugin rows',
      activationOk: '{count} plugin rows present.',
      activationFailed: 'Rows that failed to load: {rows}',
      findingsLabel: 'Findings',
      findingsEmpty: 'No incompatibilities found.',
      severity_info: 'Info',
      severity_warn: 'Warning',
      severity_fail: 'Failure',
      expectedLabel: 'Expected',
      actualLabel: 'Actual',
      hintLabel: 'Hint',
      deepCheck: 'Run deep check',
      deepChecking: 'Checking…',
      recheck: 'Run deep check again',
      draftRequest: 'Draft update request',
      draftPreparing: 'Preparing…',
      fileIssue: 'File issue',
      blockedNoRepo: 'This plugin declares no GitHub repository, so no update request can be drafted.',
      blockedNotRed: 'An update request is offered only when both the plugin side and the runtime side are unsupported.',
      autoHint: 'Automatic submission is on: this button calls the GitHub API and files the issue directly.',
      nudgeLabel: 'Last update request',
      nudgeNone: 'None',
      outcome_drafted: 'Update request drafted',
      outcome_filed: 'Issue filed',
      outcome_filed_number: 'Issue #{number} filed',
      outcome_duplicate: 'This incompatibility signature was already reported; it is suppressed for the current dedupe window.',
      outcome_blocked: 'The update request did not pass the eligibility gate.',
      outcome_none: 'None',
      openLink: 'Open',
      copyLink: 'Copy link',
      copied: 'Copied',

      // tab
      tabTitle: 'Compatibility',
      tabIntro: 'Checks whether the third-party plugin bundles installed in this profile support the running DSH version.',
      overviewMeta: 'Runtime {runtime} · profile {profile} · checked {when}',
      loading: 'Reading the plugin inventory…',
      checkAll: 'Check all',
      checkingAll: 'Checking…',
      refresh: 'Refresh',
      refreshing: 'Refreshing…',
      check: 'Check',
      checking: 'Checking…',
      draft: 'Draft',
      draftPreparing: 'Preparing…',
      notChecked: 'Not checked',
      neverChecked: 'Never checked',
      noRepo: 'No repository',
      stale: 'Result is stale',
      emptyTitle: 'No third-party plugins detected',
      emptyBody: 'This page checks only third-party plugin bundles that this profile installs as dependencies and that declare a bundle patch. Official bundles shipped with DSH are out of scope; DSH judges their admission itself. Install or enable a plugin, then refresh this page.',
      checkAllDone: 'Checked {total} plugins.',
      checkAllPartial: '{failed} of {total} plugins could not be checked; open their details for the reason.',
      scopeNote: 'The check is read-only: it reads manifest declarations, resolved dependency versions, the entry artifact\u2019s inject list and the Loader state. It never runs third-party plugin code and never uploads local paths, user names or session content.',
      tabDraftHint: 'Refresh re-reads the plugin inventory and the inspection cache.',
    }

    /* ---------------------------- registration ----------------------------- */

    /**
     * Register the three slot entries. Must run in a fiber that already injects
     * `remote.junpengjia`; reading ctx.remote.junpengjia elsewhere triggers
     * cordis's "cannot get property without inject".
     */
    function registerUi(ctx) {
      ctx.effect(() => installStyles(), 'dsh-junpeng-jia: styles')
      ctx.effect(() => ctx.locale.register(NS, { zh: ZH, en: EN }), 'dsh-junpeng-jia: dictionaries')
      const t = ctx.locale.bind(NS)

      // The Host surface, wrapped so slot components never touch ctx. The full
      // contract is mounted even where this revision's UI does not call it
      // (settings/saveSettings/setToken are the settings surface's methods and
      // stay reachable for parity with the Agent tool).
      const api = {
        overview: () => ctx.remote.junpengjia.overview(),
        inspect: (name) => ctx.remote.junpengjia.inspect(name),
        nudge: (name, mode) => ctx.remote.junpengjia.nudge(name, mode),
        settings: () => ctx.remote.junpengjia.settings(),
        saveSettings: (patch) => ctx.remote.junpengjia.saveSettings(patch),
        setToken: (token) => ctx.remote.junpengjia.setToken(token),
        history: () => ctx.remote.junpengjia.history(),
      }
      const store = createStore(api)

      ctx.slots.inject(SLOT_BADGE, () => ctx.slots.register({
        name: SLOT_BADGE,
        id: ID_BADGE,
        order: 10,
        locale: NS,
        inject: () => ({ store }),
      }, JunpengJiaBadge))

      ctx.slots.inject(SLOT_SECTION, () => ctx.slots.register({
        name: SLOT_SECTION,
        id: ID_SECTION,
        order: 20,
        locale: NS,
        inject: () => ({ store }),
      }, JunpengJiaSection))

      ctx.slots.inject(SLOT_TAB, () => ctx.slots.register({
        name: SLOT_TAB,
        id: ID_TAB,
        order: 10,
        label: () => t('tabTitle'),
        locale: NS,
        inject: () => ({ store }),
      }, JunpengJiaTab))
    }

    return {
      inject: ['remote', 'slots', 'locale'],
      /**
       * Two-stage mount: contribute the Remote definitions, then register the
       * UI inside a child fiber that injects `remote.junpengjia`. Both stages
       * are disposed in the returned cleanup, in reverse order.
       */
      async apply(ctx) {
        const disposeRemote = await ctx.remote.$mount(TYPERT_REMOTE)
        const ui = ctx.inject(['remote.junpengjia', 'slots', 'locale'], registerUi)
        try {
          await ui
        } catch (error) {
          await ui.dispose()
          await disposeRemote()
          throw error
        }
        return async () => {
          await ui.dispose()
          await disposeRemote()
        }
      },
    }
  },
})
