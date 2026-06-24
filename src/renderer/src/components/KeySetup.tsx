import { useState } from 'react'
import { Hexagon } from 'lucide-react'

/**
 * Shown only when Artemis can't find a Claude subscription login to inherit.
 * Subscription-first is the happy path; this is the fallback for entering an
 * Anthropic API key (stored encrypted in the main process, never in the renderer).
 */
export default function KeySetup({ onDone }: { onDone: () => void }) {
  const [key, setKey] = useState('')
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState('')

  const save = async () => {
    if (!key.trim()) return
    setSaving(true)
    setErr('')
    try {
      await window.artemis.auth.setKey(key.trim())
      onDone()
    } catch (e: any) {
      setErr(String(e?.message ?? e))
      setSaving(false)
    }
  }

  return (
    <div className="keysetup">
      <div className="brand big">
        <Hexagon size={22} strokeWidth={2.5} /> ARTEMIS
      </div>
      <div className="ks-acronym">
        Autonomous Repository-Tending Engineering, Monitoring &amp; Intelligence System
      </div>
      <p className="ks-lead">
        I couldn't find a Claude Code login to run on. Log into Claude Code (run{' '}
        <code>claude</code> in a terminal once) and reopen me, or paste an Anthropic
        API key to run metered instead.
      </p>
      <input
        className="ks-input"
        type="password"
        placeholder="sk-ant-…"
        value={key}
        onChange={(e) => setKey(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && save()}
      />
      {err && <div className="ks-err">{err}</div>}
      <div className="ks-actions">
        <button className="ks-skip" onClick={onDone}>
          I'll log into Claude Code instead
        </button>
        <button className="ks-save" onClick={save} disabled={saving || !key.trim()}>
          {saving ? 'Saving…' : 'Save key'}
        </button>
      </div>
    </div>
  )
}
