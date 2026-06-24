import { app, safeStorage } from 'electron'
import { promises as fs, existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { createSign } from 'crypto'

/**
 * Google Analytics (GA4) read-only connector — no SDK, just a service-account JWT
 * signed with Node crypto + the GA Data API over REST. The service-account JSON is
 * stored encrypted at rest (Electron safeStorage), like the Anthropic key, and never
 * leaves the main process.
 *
 * Setup: create a GA4 service account, download its JSON key, and grant that account
 * "Viewer" on each GA4 property. Then point each Artemis project at its property id.
 */

interface ServiceAccount {
  client_email: string
  private_key: string
}

const credFile = (): string => join(app.getPath('userData'), 'ga-service-account.enc')

export function hasGaCredentials(): boolean {
  return existsSync(credFile())
}

/** Validate + store the service-account JSON (encrypted). */
export async function setGaCredentials(json: string): Promise<void> {
  const parsed = JSON.parse(json) as Partial<ServiceAccount>
  if (!parsed.client_email || !parsed.private_key) {
    throw new Error('Not a valid GA service-account JSON (missing client_email / private_key).')
  }
  if (!safeStorage.isEncryptionAvailable()) throw new Error('OS encryption unavailable')
  await fs.writeFile(credFile(), safeStorage.encryptString(json))
  _token = null
}

export async function clearGaCredentials(): Promise<void> {
  await fs.rm(credFile(), { force: true })
  _token = null
}

function getCredentials(): ServiceAccount | null {
  try {
    return JSON.parse(safeStorage.decryptString(readFileSync(credFile()))) as ServiceAccount
  } catch {
    return null
  }
}

// --- OAuth: service-account JWT -> access token (cached until ~expiry) ---------

let _token: { value: string; exp: number } | null = null

function base64url(input: Buffer | string): string {
  return Buffer.from(input)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

async function getAccessToken(): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  if (_token && _token.exp - 60 > now) return _token.value

  const creds = getCredentials()
  if (!creds) throw new Error('No Google Analytics credentials configured.')

  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
  const claim = base64url(
    JSON.stringify({
      iss: creds.client_email,
      scope: 'https://www.googleapis.com/auth/analytics.readonly',
      aud: 'https://oauth2.googleapis.com/token',
      iat: now,
      exp: now + 3600
    })
  )
  const signer = createSign('RSA-SHA256')
  signer.update(`${header}.${claim}`)
  const jwt = `${header}.${claim}.${base64url(signer.sign(creds.private_key))}`

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt
    })
  })
  if (!res.ok) throw new Error(`Google token error ${res.status}: ${(await res.text()).slice(0, 200)}`)
  const data = (await res.json()) as { access_token: string; expires_in: number }
  _token = { value: data.access_token, exp: now + (data.expires_in ?? 3600) }
  return _token.value
}

// --- GA4 Data API report ------------------------------------------------------

function fmt(n: number): string {
  return n.toLocaleString('en-US')
}

export interface GaMetrics {
  users: number
  newUsers: number
  sessions: number
  views: number
}

/** Structured last-7-days metrics for one GA4 property. */
export async function gaMetrics(propertyId: string): Promise<GaMetrics> {
  const token = await getAccessToken()
  const id = propertyId.replace(/^properties\//, '')
  const res = await fetch(`https://analyticsdata.googleapis.com/v1beta/properties/${id}:runReport`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      dateRanges: [{ startDate: '7daysAgo', endDate: 'today' }],
      metrics: [
        { name: 'activeUsers' },
        { name: 'newUsers' },
        { name: 'sessions' },
        { name: 'screenPageViews' }
      ]
    })
  })
  if (!res.ok) throw new Error(`GA report error ${res.status}: ${(await res.text()).slice(0, 200)}`)
  const data = (await res.json()) as { rows?: Array<{ metricValues: Array<{ value: string }> }> }
  const v = data.rows?.[0]?.metricValues?.map((m) => Number(m.value) || 0) ?? [0, 0, 0, 0]
  return { users: v[0], newUsers: v[1], sessions: v[2], views: v[3] }
}

/** A compact last-7-days summary string for one GA4 property (used in ecosystem_status). */
export async function gaSummary(propertyId: string): Promise<string> {
  const m = await gaMetrics(propertyId)
  return `GA last 7d — ${fmt(m.users)} active users (${fmt(m.newUsers)} new), ${fmt(m.sessions)} sessions, ${fmt(m.views)} views`
}
