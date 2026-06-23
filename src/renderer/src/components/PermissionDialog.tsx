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
  onRespond: (allow: boolean) => void
}) {
  return (
    <div className="modal-backdrop">
      <div className="modal">
        <div className="modal-title">
          Artemis wants to run <span className="tool">{req.toolName}</span>
        </div>
        <pre className="modal-body">{describe(req)}</pre>
        <div className="modal-actions">
          <button className="btn-deny" onClick={() => onRespond(false)}>
            Deny
          </button>
          <button className="btn-allow" onClick={() => onRespond(true)} autoFocus>
            Allow
          </button>
        </div>
      </div>
    </div>
  )
}
