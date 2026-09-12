import { onDocumentWritten } from 'firebase-functions/v2/firestore'
import { initializeApp, getApps } from 'firebase-admin/app'
import { getFirestore, FieldValue } from 'firebase-admin/firestore'

if (!getApps().length) initializeApp()
const db = getFirestore()

const clean = (value) => typeof value === 'string' ? value.trim() : value

function firstMatchingFlight(flights, documentId) {
  return flights.find((flight) =>
    flight.sourceDocumentId === documentId ||
    flight.documentId === documentId ||
    (Array.isArray(flight.sourceDocumentIds) && flight.sourceDocumentIds.includes(documentId)) ||
    (Array.isArray(flight.attachments) && flight.attachments.some((attachment) => attachment?.documentId === documentId))
  )
}

function firstMatching(records, documentId) {
  return records.find((record) => record.sourceDocumentId === documentId || record.documentId === documentId)
}

function metadataFor(type, record) {
  if (type === 'flights') {
    return {
      category: 'טיסה', recognizedType: 'flight', recognizedTypeLabel: 'טיסה', recognizedTypeIcon: '✈️',
      summaryTitle: [record.airline, record.flightNumber].filter(Boolean).join(' · ') || 'טיסה',
      summaryCity: [record.from, record.to].filter(Boolean).join(' → '),
      summaryLocation: [record.from, record.to].filter(Boolean).join(' → '),
      summaryStartDate: clean(record.departureDate || ''), summaryEndDate: clean(record.arrivalDate || ''),
      mapQuery: clean(record.from || '')
    }
  }
  if (type === 'hotels') {
    return {
      category: 'מלון', recognizedType: 'hotel', recognizedTypeLabel: 'מלון', recognizedTypeIcon: '🏨',
      summaryTitle: clean(record.name || 'מלון'), summaryCity: clean(record.city || ''),
      summaryLocation: clean(record.address || record.city || ''),
      summaryStartDate: clean(record.checkIn || ''), summaryEndDate: clean(record.checkOut || ''),
      mapQuery: clean(record.address || record.city || '')
    }
  }
  if (type === 'cars') {
    return {
      category: 'השכרת רכב', recognizedType: 'car', recognizedTypeLabel: 'השכרת רכב', recognizedTypeIcon: '🚗',
      summaryTitle: clean(record.company || 'השכרת רכב'), summaryCity: clean(record.pickup || ''),
      summaryLocation: [record.pickup, record.dropoff].filter(Boolean).join(' → '),
      summaryStartDate: clean(record.pickupDate || ''), summaryEndDate: clean(record.dropoffDate || ''),
      mapQuery: clean(record.pickup || '')
    }
  }
  return {
    category: 'כרטיס / אטרקציה', recognizedType: 'ticket', recognizedTypeLabel: 'כרטיס / אטרקציה', recognizedTypeIcon: '🎟️',
    summaryTitle: clean(record.title || 'כרטיס / אטרקציה'), summaryCity: clean(record.city || ''),
    summaryLocation: clean(record.venue || record.city || ''),
    summaryStartDate: clean(record.date || ''), summaryEndDate: clean(record.date || ''),
    mapQuery: clean(record.venue || record.city || '')
  }
}

function sameValue(a, b) {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null)
}

export const enrichImportedDocumentV1 = onDocumentWritten({
  document: 'trips/{tripId}/documents/{documentId}',
  region: 'europe-west1',
  timeoutSeconds: 120,
  memory: '512MiB'
}, async (event) => {
  const after = event.data?.after
  if (!after?.exists) return
  const documentData = after.data()
  if (documentData.processingStatus !== 'done') return

  const { tripId, documentId } = event.params
  const tripRef = db.collection('trips').doc(tripId)
  const [flightSnapshot, hotelSnapshot, carSnapshot, ticketSnapshot] = await Promise.all([
    tripRef.collection('flights').limit(100).get(),
    tripRef.collection('hotels').limit(100).get(),
    tripRef.collection('cars').limit(100).get(),
    tripRef.collection('tickets').limit(100).get()
  ])

  const flights = flightSnapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }))
  const hotels = hotelSnapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }))
  const cars = carSnapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }))
  const tickets = ticketSnapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }))

  const matches = []
  const flight = firstMatchingFlight(flights, documentId)
  const hotel = firstMatching(hotels, documentId)
  const car = firstMatching(cars, documentId)
  const ticket = firstMatching(tickets, documentId)
  if (flight) matches.push({ type: 'flights', record: flight })
  if (hotel) matches.push({ type: 'hotels', record: hotel })
  if (car) matches.push({ type: 'cars', record: car })
  if (ticket) matches.push({ type: 'tickets', record: ticket })

  let desired
  if (matches.length === 1) {
    const match = matches[0]
    desired = {
      ...metadataFor(match.type, match.record),
      linkedCollection: match.type,
      linkedId: match.record.id,
      recognizedCollections: [match.type],
      summaryStatus: 'פוענח'
    }
  } else if (matches.length > 1) {
    const primary = matches[0]
    desired = {
      ...metadataFor(primary.type, primary.record),
      category: 'מסמך נסיעה משולב',
      recognizedType: 'mixed',
      recognizedTypeLabel: 'מסמך משולב',
      recognizedTypeIcon: '🧾',
      linkedCollection: primary.type,
      linkedId: primary.record.id,
      recognizedCollections: matches.map((match) => match.type),
      summaryStatus: 'פוענח'
    }
  } else {
    desired = {
      category: documentData.category === 'זיהוי אוטומטי' ? 'מסמך' : documentData.category || 'מסמך',
      recognizedType: 'document', recognizedTypeLabel: documentData.category === 'זיהוי אוטומטי' ? 'מסמך' : documentData.category || 'מסמך',
      recognizedTypeIcon: '📄', recognizedCollections: [],
      summaryTitle: clean(documentData.extractionSummary || documentData.name || 'מסמך'),
      summaryCity: '', summaryLocation: '', summaryStartDate: '', summaryEndDate: '', mapQuery: '', summaryStatus: 'פוענח'
    }
  }

  const changed = Object.entries(desired).some(([key, value]) => !sameValue(documentData[key], value))
  if (!changed) return

  await after.ref.set({
    ...desired,
    autoClassifiedAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp()
  }, { merge: true })
})
