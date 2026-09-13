import { onRequest } from 'firebase-functions/v2/https'
import { initializeApp, getApps } from 'firebase-admin/app'
import { getAuth } from 'firebase-admin/auth'
import { getFirestore, FieldValue } from 'firebase-admin/firestore'

if (!getApps().length) initializeApp()
const db = getFirestore()
const adminAuth = getAuth()

const clean = (v) => String(v || '').trim()
const emailKey = (v) => clean(v).toLowerCase()
const nameKey = (v) => clean(v).toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9\u0590-\u05ff]+/g, '-').replace(/^-|-$/g, '').slice(0, 120)
const validEmail = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)
const ms = (v) => typeof v?.toMillis === 'function' ? v.toMillis() : Number(v?.seconds || 0) * 1000

function cors(req, res) {
  const origin = req.get('origin')
  if (origin) res.set('Access-Control-Allow-Origin', origin)
  res.set('Vary', 'Origin')
  res.set('Access-Control-Allow-Headers', 'Authorization, Content-Type')
  res.set('Access-Control-Allow-Methods', 'POST, OPTIONS')
}

async function authUser(req) {
  const header = req.get('authorization') || ''
  if (!header.startsWith('Bearer ')) throw Object.assign(new Error('Authentication required'), { status: 401 })
  try { return await adminAuth.verifyIdToken(header.slice(7)) }
  catch { throw Object.assign(new Error('Invalid authentication token'), { status: 401 }) }
}

async function requireAdmin(uid) {
  const snap = await db.collection('users').doc(uid).get()
  if (!snap.exists || snap.data()?.role !== 'admin') throw Object.assign(new Error('System administrator permission required'), { status: 403 })
}

async function overview(decoded) {
  await requireAdmin(decoded.uid)
  const [familiesSnap, invitesSnap] = await Promise.all([
    db.collection('families').limit(200).get(),
    db.collection('familyInvites').limit(500).get()
  ])
  return {
    families: familiesSnap.docs.map((d) => ({ id: d.id, name: d.data().name || '', active: d.data().active !== false, createdAt: ms(d.data().createdAt) })).sort((a, b) => a.name.localeCompare(b.name, 'he')),
    invites: invitesSnap.docs.map((d) => ({
      id: d.id,
      familyId: d.data().familyId || '',
      familyName: d.data().familyName || '',
      email: d.data().email || '',
      displayName: d.data().displayName || '',
      role: d.data().role || 'familyAdmin',
      status: d.data().status || 'pending',
      createdAt: ms(d.data().createdAt),
      acceptedAt: ms(d.data().acceptedAt)
    })).sort((a, b) => b.createdAt - a.createdAt)
  }
}

async function getOrCreateFamily(name, uid) {
  const familyName = clean(name)
  if (familyName.length < 2 || familyName.length > 100) throw Object.assign(new Error('Family name must contain 2-100 characters'), { status: 400 })
  const key = nameKey(familyName)
  const existing = await db.collection('families').where('nameKey', '==', key).limit(1).get()
  if (!existing.empty) return { id: existing.docs[0].id, ...existing.docs[0].data() }
  const ref = db.collection('families').doc()
  await ref.set({ name: familyName, nameKey: key, active: true, createdBy: uid, createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() })
  return { id: ref.id, name: familyName }
}

async function createInvite(decoded, body) {
  await requireAdmin(decoded.uid)
  const email = emailKey(body?.email)
  const displayName = clean(body?.displayName).slice(0, 100)
  if (!validEmail(email)) throw Object.assign(new Error('A valid email address is required'), { status: 400 })
  const family = await getOrCreateFamily(body?.familyName, decoded.uid)
  const previous = await db.collection('familyInvites').where('email', '==', email).limit(50).get()
  const same = previous.docs.find((d) => d.data().familyId === family.id && ['pending', 'accepted'].includes(d.data().status))
  if (same) return { reused: true, invite: { id: same.id, familyId: family.id, familyName: family.name, email, displayName: same.data().displayName || displayName, status: same.data().status, role: 'familyAdmin' } }

  const ref = db.collection('familyInvites').doc()
  await ref.set({ familyId: family.id, familyName: family.name, email, displayName, role: 'familyAdmin', status: 'pending', invitedBy: decoded.uid, createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() })
  return { reused: false, invite: { id: ref.id, familyId: family.id, familyName: family.name, email, displayName, status: 'pending', role: 'familyAdmin' } }
}

async function revokeInvite(decoded, body) {
  await requireAdmin(decoded.uid)
  const ref = db.collection('familyInvites').doc(clean(body?.inviteId))
  const snap = await ref.get()
  if (!snap.exists) throw Object.assign(new Error('Invitation not found'), { status: 404 })
  if (snap.data().status === 'accepted') throw Object.assign(new Error('Accepted invitations cannot be revoked'), { status: 409 })
  await ref.set({ status: 'revoked', revokedAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() }, { merge: true })
  return { ok: true }
}

async function acceptInvite(decoded, body) {
  const inviteId = clean(body?.inviteId)
  if (!inviteId) throw Object.assign(new Error('Invalid invitation link'), { status: 400 })
  const ref = db.collection('familyInvites').doc(inviteId)
  const snap = await ref.get()
  if (!snap.exists) throw Object.assign(new Error('Invitation not found'), { status: 404 })
  const invite = snap.data()
  const email = emailKey(decoded.email)
  if (!email || email !== emailKey(invite.email)) throw Object.assign(new Error(`This invitation is for ${invite.email}`), { status: 403, code: 'email_mismatch' })
  if (invite.status === 'revoked') throw Object.assign(new Error('This invitation was revoked'), { status: 410 })
  if (invite.status === 'accepted') {
    if (invite.acceptedByUid === decoded.uid) return { ok: true, alreadyAccepted: true, familyId: invite.familyId, familyName: invite.familyName || '' }
    throw Object.assign(new Error('This invitation was already used'), { status: 409 })
  }
  if (invite.status !== 'pending') throw Object.assign(new Error('This invitation is no longer active'), { status: 409 })

  const familyRef = db.collection('families').doc(invite.familyId)
  const family = await familyRef.get()
  if (!family.exists || family.data()?.active === false) throw Object.assign(new Error('The family is no longer active'), { status: 410 })

  const batch = db.batch()
  batch.set(familyRef.collection('members').doc(decoded.uid), { uid: decoded.uid, email, displayName: decoded.name || invite.displayName || '', role: 'familyAdmin', joinedAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() }, { merge: true })
  batch.set(db.collection('users').doc(decoded.uid), { familyIds: FieldValue.arrayUnion(invite.familyId), familyAdminOf: FieldValue.arrayUnion(invite.familyId), updatedAt: FieldValue.serverTimestamp() }, { merge: true })
  batch.set(familyRef, { managerEmails: FieldValue.arrayUnion(email), updatedAt: FieldValue.serverTimestamp() }, { merge: true })
  batch.set(ref, { status: 'accepted', acceptedByUid: decoded.uid, acceptedAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() }, { merge: true })
  await batch.commit()
  return { ok: true, familyId: invite.familyId, familyName: family.data()?.name || invite.familyName || '', role: 'familyAdmin' }
}

export const familyAdminApi = onRequest({ region: 'europe-west1', timeoutSeconds: 60, memory: '256MiB' }, async (req, res) => {
  cors(req, res)
  if (req.method === 'OPTIONS') return res.status(204).send('')
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' })
  try {
    const decoded = await authUser(req)
    const action = clean(req.body?.action)
    const result = action === 'overview' ? await overview(decoded)
      : action === 'createFamilyAdminInvite' ? await createInvite(decoded, req.body)
      : action === 'revokeInvite' ? await revokeInvite(decoded, req.body)
      : action === 'acceptInvite' ? await acceptInvite(decoded, req.body)
      : (() => { throw Object.assign(new Error('Unknown action'), { status: 400 }) })()
    return res.json(result)
  } catch (error) {
    console.error('familyAdminApi', error?.message)
    return res.status(error?.status || 500).json({ error: error?.message || 'Family administration failed', code: error?.code || '' })
  }
})
