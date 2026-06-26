import { app } from 'electron'
import { exec } from 'child_process'
import { promisify } from 'util'
import { listProjects, getProjectGaProps } from './store'
import { parseGitRemote } from './github'
import { gaMetrics, hasGaCredentials, type GaMetrics } from './ga'

const execp = promisify(exec)

/**
 * Structured, code-gathered briefing data (no LLM) — fast, free, deterministic, and
 * fully controllable in the UI (clean card + accordions). Excludes Artemis's own repo;
 * the briefing is about the overseen ecosystem, not the tool itself.
 */
export interface BriefingProject {
  name: string
  url: string | null // repo web url — for linking the name, PRs, and commits to GitHub
  subdir: string | null // monorepo workspace prefix (e.g. "apps/scanner"), or null at repo root
  branch: string | null
  dirty: string[]
  activity7d: number
  lastCommit: { text: string; url: string | null } | null
  prs: Array<{ number: number; title: string; agent: boolean; url: string }>
  analytics: Array<{ label: string } & GaMetrics>
}

export interface BriefingData {
  generatedAt: number
  projects: BriefingProject[]
}

export async function gatherBriefing(): Promise<BriefingData> {
  const selfPath = app.getAppPath()
  const projects = listProjects().filter((p) => p.path !== selfPath)

  const out = await Promise.all(
    projects.map(async (p): Promise<BriefingProject> => {
      const git = async (args: string): Promise<string> => {
        try {
          return (await execp(`git ${args}`, { cwd: p.path, maxBuffer: 4 * 1024 * 1024 })).stdout.trim()
        } catch {
          return ''
        }
      }

      const branch = (await git('rev-parse --abbrev-ref HEAD')) || null
      // Scope file-level metrics to a monorepo subdir (pathspec `.` = cwd; whole repo at root).
      const subdir = (await git('rev-parse --show-prefix')).replace(/\/$/, '') || null
      const status = await git('status --porcelain .')
      const dirty = status ? status.split('\n').filter(Boolean).map((l) => l.slice(3)) : []
      const activity7d = (await git("log --since='7 days ago' --oneline -- .")).split('\n').filter(Boolean).length

      const gh = parseGitRemote(p.remote)
      const repoUrl = gh?.url ?? null

      // Last commit (touching this workspace), with a link to it on GitHub when we know the remote.
      const lcShort = await git('log -1 --pretty=format:%h -- .')
      const lcText = (await git("log -1 --pretty=format:'%h %s (%cr)' -- .")) || null
      const lastCommit = lcText
        ? { text: lcText, url: lcShort && repoUrl ? `${repoUrl}/commit/${lcShort}` : null }
        : null

      let prs: BriefingProject['prs'] = []
      if (gh) {
        try {
          const j = (
            await execp(
              `gh pr list --repo ${gh.slug} --state open --json number,title,headRefName,url --limit 20`,
              { cwd: p.path, maxBuffer: 4 * 1024 * 1024 }
            )
          ).stdout.trim()
          const arr = (j ? JSON.parse(j) : []) as Array<{ number: number; title: string; headRefName: string; url: string }>
          prs = arr.map((pr) => ({
            number: pr.number,
            title: pr.title,
            agent: !!pr.headRefName?.startsWith('artemis/'),
            url: pr.url
          }))
        } catch {
          /* gh unavailable / no access */
        }
      }

      const analytics: BriefingProject['analytics'] = []
      if (hasGaCredentials()) {
        for (const prop of getProjectGaProps(p.path)) {
          try {
            analytics.push({ label: prop.label || p.name, ...(await gaMetrics(prop.id)) })
          } catch {
            /* property unavailable */
          }
        }
      }

      return { name: p.name, url: repoUrl, subdir, branch, dirty, activity7d, lastCommit, prs, analytics }
    })
  )

  return { generatedAt: Date.now(), projects: out }
}
