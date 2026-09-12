import { onDocumentWritten } from 'firebase-functions/v2/firestore'
import { initializeApp, getApps } from 'firebase-admin/app'
import { getFirestore, FieldValue } from 'firebase-admin/firestore'
import { normalizeTripFlights } from './flight-rules-v3.js'

if (!getApps().length) initializeApp()
const db = getFirestore()
const RULE_VERSION = 'flight-rules-v3'

export const applyFlightRulesOnTripOpenV3 = onDocumentWritten({
  document: 'users/{uid}',
  region: 'europe-west1',
  timeoutSeconds: 180,
  memory: '512MiB'
}, async (event) => {
  const after = event.data?.after
  if (!after?.exists) return
  const profile = after.data()
  const tripId = profile.lastTripId
  if (!tripId) return

  const tripRef = db.collection('trips').doc(tripId)
  const tripDoc = await tripRef.get()
  if (!tripDoc.exists) return
  const trip = tripDoc.data()
  if (trip.ownerId !== event.params.uid || trip.flightRulesVersion === RULE_VERSION) return

  await normalizeTripFlights(tripId)
  await tripRef.set({
    flightRulesVersion: RULE_VERSION,
    flightRulesUpdatedAt: FieldValue.serverTimestamp()
  }, { merge: true })
})
