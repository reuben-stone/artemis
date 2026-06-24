import type { Project } from '../../../preload'

/**
 * The Projects panel — the UI for the multi-project foundation. Lists every repo
 * Artemis oversees, lets you add more (native multi-select folder picker), switch
 * the active one (drives the agent's file-tool cwd), and remove them.
 */
export function ProjectsPanel({
  projects,
  busy,
  onAdd,
  onRemove,
  onSelect,
  onClose
}: {
  projects: Project[]
  busy: boolean
  onAdd: () => void
  onRemove: (id: number) => void
  onSelect: (path: string) => void
  onClose: () => void
}): JSX.Element {
  return (
    <div className="projects-overlay" onClick={onClose}>
      <div className="projects-panel" onClick={(e) => e.stopPropagation()}>
        <div className="projects-head">
          <span>PROJECTS</span>
          <div className="projects-head-actions">
            <button className="projects-add" onClick={onAdd} disabled={busy}>
              {busy ? '…' : '+ Add folder(s)'}
            </button>
            <button className="projects-close" onClick={onClose} title="Close">
              ✕
            </button>
          </div>
        </div>

        <div className="projects-list">
          {projects.length === 0 && (
            <div className="projects-empty">No projects yet — add a repo folder to begin.</div>
          )}
          {projects.map((p) => (
            <div
              key={p.id}
              className={`project-row ${p.active ? 'active' : ''}`}
              onClick={() => onSelect(p.path)}
              title={p.active ? 'Active project' : 'Click to make active'}
            >
              <div className="project-main">
                <span className="project-dot">{p.active ? '●' : '○'}</span>
                <span className="project-name">{p.name}</span>
                {p.branch && (
                  <span className={`project-branch ${p.dirty ? 'dirty' : ''}`}>
                    {p.branch}
                    {p.dirty ? ' · changes' : ' · clean'}
                  </span>
                )}
                <button
                  className="project-remove"
                  onClick={(e) => {
                    e.stopPropagation()
                    onRemove(p.id)
                  }}
                  title="Remove from Artemis (does not delete the folder)"
                >
                  ×
                </button>
              </div>
              <div className="project-sub">
                <span className="project-path">{p.path}</span>
                {p.gh && (
                  <a
                    className="project-remote"
                    href={p.gh.url}
                    target="_blank"
                    rel="noreferrer"
                    onClick={(e) => e.stopPropagation()}
                  >
                    {p.gh.slug} ↗
                  </a>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
