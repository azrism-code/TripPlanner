import fs from 'node:fs'
import crypto from 'node:crypto'

const projectId = 'tripplanner-94835'
const bucket = 'tripplanner-94835.firebasestorage.app'
const credentials = JSON.parse(fs.readFileSync(process.env.GOOGLE_APPLICATION_CREDENTIALS, 'utf8'))
const source = fs.readFileSync('storage.rules', 'utf8')

const base64url = (value) => Buffer.from(value).toString('base64url')
const now = Math.floor(Date.now() / 1000)
const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
const payload = base64url(JSON.stringify({
  iss: credentials.client_email,
  scope: 'https://www.googleapis.com/auth/cloud-platform',
  aud: 'https://oauth2.googleapis.com/token',
  iat: now,
  exp: now + 3600
}))
const unsignedJwt = `${header}.${payload}`
const signature = crypto.sign('RSA-SHA256', Buffer.from(unsignedJwt), credentials.private_key).toString('base64url')
const assertion = `${unsignedJwt}.${signature}`

const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion
  })
})
const tokenBody = await tokenResponse.json()
if (!tokenResponse.ok || !tokenBody.access_token) {
  throw new Error(`Could not obtain Google access token: ${JSON.stringify(tokenBody)}`)
}

const headers = {
  Authorization: `Bearer ${tokenBody.access_token}`,
  'Content-Type': 'application/json'
}

const rulesetResponse = await fetch(`https://firebaserules.googleapis.com/v1/projects/${projectId}/rulesets`, {
  method: 'POST',
  headers,
  body: JSON.stringify({
    source: {
      files: [{
        name: 'storage.rules',
        content: source,
        fingerprint: crypto.createHash('sha256').update(source).digest('base64')
      }]
    }
  })
})
const ruleset = await rulesetResponse.json()
if (!rulesetResponse.ok) {
  throw new Error(`Could not create Storage ruleset: ${JSON.stringify(ruleset)}`)
}

const releaseName = `projects/${projectId}/releases/firebase.storage/${bucket}`
const patchResponse = await fetch(`https://firebaserules.googleapis.com/v1/${releaseName}`, {
  method: 'PATCH',
  headers,
  body: JSON.stringify({
    release: { name: releaseName, rulesetName: ruleset.name },
    updateMask: 'rulesetName'
  })
})

if (patchResponse.status === 404) {
  const createResponse = await fetch(`https://firebaserules.googleapis.com/v1/projects/${projectId}/releases`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ name: releaseName, rulesetName: ruleset.name })
  })
  const created = await createResponse.json()
  if (!createResponse.ok) {
    throw new Error(`Could not create Storage rules release: ${JSON.stringify(created)}`)
  }
  console.log(`Storage rules released: ${created.name}`)
} else {
  const patched = await patchResponse.json()
  if (!patchResponse.ok) {
    throw new Error(`Could not update Storage rules release: ${JSON.stringify(patched)}`)
  }
  console.log(`Storage rules released: ${patched.name}`)
}
