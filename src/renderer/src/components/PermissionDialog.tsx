import type { PermissionDecision } from '../../../preload'

export interface PermissionReq {
  permId: number
  toolName: string
  input: unknown
}

/** Summarize a tool call for the approval prompt. */
function describe(req: PermissionReq): string {
  const i = req.input as Record<string, unknown>
  switch (req.toolName) {
    case 'Bash':
      return String(i?.command ?? '')
    case 'Write':
    case 'Edit':
      return String(i?.file_path ?? i?.path ?? '')
    default:
      return JSON.stringify(i, null, 2).slice(0, 600)
  }
}

export default function PermissionDialog({
  req,
  onRespond
}: {
  req: PermissionReq
  onRespond: (decision: PermissionDecision) => void
}) {
  // "Allow & don't ask again" remembers an exact command, so it only makes sense for
  // Bash (Write/Edit differ every call — there's nothing stable to remember).
  const canRemember = req.toolName === 'Bash'
  return (
    <div className="modal-backdrop">
      <div className="modal">
        <div className="modal-title">
          Artemis wants to run <span className="tool">{req.toolName}</span>
        </div>
        <pre className="modal-body">{describe(req)}</pre>
        <div className="modal-actions">
          <button className="btn-deny" onClick={() => onRespond('deny')}>
            Deny
          </button>
          {canRemember && (
            <button className="btn-always" onClick={() => onRespond('always')} title="Run this and never ask for this exact command again (this project)">
              Allow, don&apos;t ask again
            </button>
          )}
          <button className="btn-allow" onClick={() => onRespond('once')} autoFocus>
            Allow
          </button>
        </div>
      </div>
    </div>
  )
}
