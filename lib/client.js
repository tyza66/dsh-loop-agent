// @tyza66/dsh-loop-agent client half — browser ModuleLoader bundle.
//
// Registers one settings section ("Endless loop") into the settings
// sidebar alongside General / Models / Plugins, and renders a switch that
// turns the loop on or off. The switch writes the user-layer patch file
// through a Host RPC; the change takes effect on the next profile start,
// which the section says out loud rather than pretending the toggle is
// instant.
//
// Hand-written in ModuleLoader format (no build step): `require` resolves
// the shared browser packages the profile already serves, and everything
// is plain ES5-flavoured JavaScript with React.createElement — no JSX,
// no import/require statements, no TypeScript syntax.

window.__ModuleLoader__.load({ id: '@tyza66/dsh-loop-agent', factory: (require) => {
  var module = { exports: {} }
  var exports = module.exports
  var React = require('react')

  /** Slot name every settings page registers into; the sidebar lists it. */
  var SECTION_SLOT = 'settings.section'
  /** Dictionary namespace owned by this plugin. */
  var NS = 'settings.loopAgent'

  var en = {
    nav: 'Endless loop',
    title: 'Endless loop',
    intro: 'Keep every agent running: after each answer, the loop queues the next continuation prompt automatically.',
    enableLabel: 'Endless loop',
    enableHint: 'Attach the loop to every new agent. User messages always run first.',
    on: 'On',
    off: 'Off',
    restartNotice: 'Saved. Restart the web profile for this to take effect — running agents finish their current round and are not killed.',
    attached: 'Agents with a live loop right now',
    loading: 'Loading…',
    failed: 'Could not reach the host; the switch was left as it was.',
    saving: 'Saving…'
  }

  var zh = {
    nav: '无尽模式',
    title: '无尽模式',
    intro: '让每个 agent 一直跑下去：每轮回答结束后，loop 自动排队下一条延续语。',
    enableLabel: '无尽模式',
    enableHint: '给每个新 agent 挂上 loop。用户消息永远优先执行。',
    on: '开',
    off: '关',
    restartNotice: '已保存。重启 web profile 后生效——正在跑的 agent 会跑完当前轮，不会被强杀。',
    attached: '当前正在跑 loop 的 agent 数',
    loading: '加载中…',
    failed: '无法连接 host，开关保持原样。',
    saving: '保存中…'
  }

  /**
   * The endless-loop settings section.
   *
   * Props arrive from the slot: `t` is this namespace's bound translator.
   * State is read once on mount and after every write; there is no live
   * subscription, because the underlying value is a file the Host owns and
   * the only writer is this switch. The Host is reached over the webserver
   * the loop's host half registers (`/api/loop-agent/{state,enabled}`) — a
   * plain `fetch` is enough; the dynamic-only `host.call` channel does not
   * exist in static dual-face plugins.
   */
  function LoopSection(props) {
    var t = props.t
    var state = React.useState(null)
    var snapshot = state[0]
    var setSnapshot = state[1]
    var busy = React.useState(false)
    var saving = busy[0]
    var setSaving = busy[1]
    var error = React.useState('')
    var errorMessage = error[0]
    var setErrorMessage = error[1]
    var saved = React.useState(false)
    var showSaved = saved[0]
    var setShowSaved = saved[1]

    React.useEffect(function () {
      var cancelled = false
      fetch('/api/loop-agent/state', { method: 'GET', headers: { accept: 'application/json' } })
        .then(function (res) { return res.ok ? res.json() : Promise.reject(new Error('http ' + res.status)) })
        .then(function (result) {
          if (cancelled) return
          setSnapshot(result)
        })['catch'](function () {
          if (!cancelled) setErrorMessage(t('failed'))
        })
      return function () {
        cancelled = true
      }
    }, [])

    /** Flip the switch: write, then re-read what the Host now holds. */
    function toggle(next) {
      setSaving(true)
      setErrorMessage('')
      setShowSaved(false)
      fetch('/api/loop-agent/enabled', {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ enabled: next })
      })
        .then(function (res) { return res.ok ? res.json() : Promise.reject(new Error('http ' + res.status)) })
        .then(function (result) {
          setSnapshot(result)
          setShowSaved(true)
        })['catch'](function () {
          setErrorMessage(t('failed'))
        })['finally'](function () {
          setSaving(false)
        })
    }

    if (snapshot === null && errorMessage === '') {
      return React.createElement('p', null, t('loading'))
    }

    var enabled = snapshot !== null && snapshot.enabled === true
    var attachedCount = snapshot === null ? 0 : (snapshot.attachedAgents || 0)

    return React.createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: '16px', maxWidth: '760px' } }, [
      React.createElement('h2', { key: 'title', style: { margin: 0, fontSize: '18px', fontWeight: 600 } }, t('title')),
      React.createElement('p', { key: 'intro', style: { margin: 0, fontSize: '13px', opacity: 0.7 } }, t('intro')),

      // The switch row.
      React.createElement('div', {
        key: 'row',
        style: {
          display: 'flex', alignItems: 'center', gap: '12px',
          padding: '12px 0', borderTop: '1px solid rgba(128,128,128,0.2)'
        }
      }, [
        React.createElement('div', { key: 'text', style: { flex: 1, minWidth: 0 } }, [
          React.createElement('div', { key: 'label', style: { fontSize: '13px', fontWeight: 500 } }, t('enableLabel')),
          React.createElement('div', { key: 'hint', style: { fontSize: '12px', opacity: 0.6, marginTop: '2px' } }, t('enableHint'))
        ]),
        React.createElement('button', {
          key: 'btn',
          type: 'button',
          role: 'switch',
          'aria-checked': enabled ? 'true' : 'false',
          disabled: saving,
          onClick: function () { toggle(!enabled) },
          style: {
            flex: 'none', cursor: saving ? 'default' : 'pointer', font: 'inherit',
            fontSize: '13px', padding: '5px 14px', borderRadius: '8px',
            border: '1px solid rgba(128,128,128,0.3)',
            background: enabled ? 'rgba(60,160,90,0.16)' : 'transparent',
            color: 'inherit'
          }
        }, saving ? t('saving') : (enabled ? t('on') : t('off')))
      ]),

      // Status lines: live agent count, and the restart notice after a write.
      snapshot !== null && attachedCount > 0
        ? React.createElement('p', { key: 'attached', style: { margin: 0, fontSize: '12px', opacity: 0.6 } },
            t('attached') + ': ' + attachedCount)
        : null,
      showSaved
        ? React.createElement('p', { key: 'saved', role: 'status', style: { margin: 0, fontSize: '12px' } }, t('restartNotice'))
        : null,
      errorMessage !== ''
        ? React.createElement('p', { key: 'error', role: 'status', style: { margin: 0, fontSize: '12px', color: '#d64545' } }, errorMessage)
        : null
    ])
  }

  /**
   * Mount the settings section.
   * @param ctx - the browser plugin context.
   */
  function apply(ctx) {
    var t = ctx.locale.bind(NS)
    ctx.effect(
      function () {
        return ctx.locale.register(NS, { zh: zh, en: en })
      },
      'loop-agent: section dictionaries'
    )
    ctx.slots.inject(SECTION_SLOT, function () {
      return ctx.slots.register(
        {
          name: SECTION_SLOT,
          id: 'loop-agent',
          // Sort after the shipped pages (general=0, models and plugins
          // follow); 100 leaves room for anything a deployment adds.
          order: 100,
          label: function () { return t('nav') },
          locale: NS
        },
        function (slotProps) {
          return React.createElement(LoopSection, {
            t: t,
            close: slotProps.close
          })
        }
      )
    })
  }

  /**
   * Services the browser half needs before it can register anything. `host`
   * is intentionally absent: that service only exists for dynamic cordis
   * packages (the `dsh-cordis-client-runner` sandbox), never for static
   * dual-face plugins like this one. Static halves reach the host through
   * the webserver the host plugin registers — a plain `fetch` is the wire.
   */
  var inject = ['slots', 'locale']

  exports.apply = apply
  exports.inject = inject
  return module.exports
}})
