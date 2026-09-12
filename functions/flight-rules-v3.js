import { onCall, HttpsError } from 'firebase-functions/v2/https'
import { onDocumentWritten } from 'firebase-functions/v2/firestore'
import { initializeApp, getApps } from 'firebase-admin/app'
import { getFirestore, FieldValue } from 'firebase-admin/firestore'

if (!getApps().length) initializeApp()
const db = getFirestore()
const RULE_VERSION = 'flight-rules-v3'

const text = (v) => String(v || '').trim()
const upper = (v) => text(v).toUpperCase().replace(/\s+/g, ' ')
const numberKey = (v) => upper(v).replace(/\s+/g, '')

function airportKey(v) {
  const value = upper(v)
  const codes = value.match(/\b[A-Z]{3}\b/g)
  return codes?.at(-1) || value.replace(/[^A-Z0-9]/g, '')
}

function groupKey(f) {
  const route = [text(f.departureDate), text(f.departureTime), airportKey(f.from), airportKey(f.to)]
  if (route.every(Boolean)) return route.join('|')
  return [numberKey(f.flightNumber), ...route].join('|')
}

function fingerprint(f) {
  return [groupKey(f), numberKey(f.flightNumber), upper(f.airline), text(f.arrivalDate), text(f.arrivalTime)].join('|')
}

function pseudoMs(date, time) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '') || !/^\d{2}:\d{2}$/.test(time || '')) return null
  const [y, m, d] = date.split('-').map(Number)
  const [hh, mm] = time.split(':').map(Number)
  return Date.UTC(y, m - 1, d, hh, mm)
}

function threeHoursBefore(date, time) {
  const ms = pseudoMs(date, time)
  if (ms === null) return null
  const value = new Date(ms - 3 * 60 * 60 * 1000)
  return { date: value.toISOString().slice(0, 10), time: value.toISOString().slice(11, 16) }
}

function inTrip(date, trip) {
  return Boolean(date && (!trip.startDate || date >= trip.startDate) && (!trip.endDate || date <= trip.endDate))
}

function first(group, field) {
  return group.map((x) => x[field]).find((v) => v !== undefined && v !== null && v !== '') || ''
}

function uniq(values) {
  return [...new Set(values.flatMap((v) => text(v).split('·')).map((v) => v.trim()).filter(Boolean))]
}

function attachments(group) {
  const map = new Map()
  for (const f of group) {
    for (const a of Array.isArray(f.attachments) ? f.attachments : []) {
      if (a?.documentId) map.set(a.documentId, a)
    }
    const id = f.documentId || f.sourceDocumentId
    if (id) map.set(id, {
      documentId: id,
      name: f.attachmentName || '',
      url: f.attachmentUrl || '',
      storagePath: f.attachmentStoragePath || '',
      seat: f.seat || '',
      bookingRef: f.bookingRef || ''
    })
  }
  return [...map.values()]
}

function isConnection(flight, flights) {
  const departure = pseudoMs(flight.departureDate, flight.departureTime)
  const airport = airportKey(flight.from)
  if (departure === null || !airport) return false
  return flights.some((previous) => {
    if (previous.id === flight.id || airportKey(previous.to) !== airport) return false
    const arrival = pseudoMs(previous.arrivalDate, previous.arrivalTime)
    if (arrival === null) return false
    const hours = (departure - arrival) / 3600000
    return hours > 0 && hours <= 12
  })
}

function removeOldFlightItems(items, dayDate, flight, groupIds, sourceIds, key) {
  const flightNo = numberKey(flight.flightNumber)
  return items.filter((item) => {
    const type = text(item.type)
    if (!['flight', 'flight-arrival', 'airport-arrival'].includes(type)) return true
    if (item.sourceFlightKey === key) return false
    if (item.flightId && groupIds.has(item.flightId)) return false
    if (item.sourceDocumentId && sourceIds.has(item.sourceDocumentId)) return false
    if (type === 'flight' && dayDate === flight.departureDate && flightNo && numberKey(item.title).includes(flightNo)) return false
    return true
  })
}

async function rewriteItinerary(tripRef, trip, flight, allFlights, group, key) {
  const daysSnapshot = await tripRef.collection('itineraryDays').get()
  const days = new Map(daysSnapshot.docs.map((d) => [d.id, { ...d.data(), items: Array.isArray(d.data().items) ? d.data().items : [] }]))
  const dirty = new Set()
  const groupIds = new Set(group.map((f) => f.id))
  const sourceIds = new Set(uniq(group.map((f) => f.sourceDocumentId || f.documentId)))

  for (const [date, day] of days) {
    const filtered = removeOldFlightItems(day.items, date, flight, groupIds, sourceIds, key)
    if (filtered.length !== day.items.length) dirty.add(date)
    day.items = filtered
  }

  const ensure = (date) => {
    if (!days.has(date)) days.set(date, { date, city: '', title: '', items: [] })
    return days.get(date)
  }

  if (inTrip(flight.departureDate, trip)) {
    ensure(flight.departureDate).items.push({
      time: text(flight.departureTime),
      title: `✈️ ${text(flight.flightNumber || flight.airline || 'טיסה')}`,
      location: [text(flight.from), text(flight.to)].filter(Boolean).join(' → '),
      type: 'flight',
      notes: '',
      flightId: flight.id,
      sourceFlightKey: key,
      detailsSection: 'flights'
    })
    dirty.add(flight.departureDate)
  }

  if (!isConnection(flight, allFlights)) {
    const arrival = threeHoursBefore(flight.departureDate, flight.departureTime)
    if (arrival && inTrip(arrival.date, trip)) {
      ensure(arrival.date).items.push({
        time: arrival.time,
        title: 'הגעה לשדה התעופה',
        location: text(flight.from),
        type: 'airport-arrival',
        notes: '',
        flightId: flight.id,
        sourceFlightKey: key,
        detailsSection: 'flights'
      })
      dirty.add(arrival.date)
    }
  }

  for (const date of dirty) {
    const day = days.get(date)
    day.items.sort((a, b) => text(a.time || '99:99').localeCompare(text(b.time || '99:99')))
    await tripRef.collection('itineraryDays').doc(date).set({
      date,
      city: day.city || '',
      title: day.title || '',
      items: day.items,
      updatedAt: FieldValue.serverTimestamp()
    }, { merge: true })
  }
}

export async function normalizeTripFlights(tripId) {
  const tripRef = db.collection('trips').doc(tripId)
  const [tripDoc, flightDocs] = await Promise.all([tripRef.get(), tripRef.collection('flights').get()])
  if (!tripDoc.exists) return { groups: 0, removedDuplicates: 0 }

  const groups = new Map()
  for (const doc of flightDocs.docs) {
    const flight = { id: doc.id, ...doc.data() }
    const key = groupKey(flight)
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(flight)
  }

  const canonicals = []
  let removedDuplicates = 0

  for (const [key, group] of groups) {
    group.sort((a, b) => Number(a.id.startsWith('import_')) - Number(b.id.startsWith('import_')) || a.id.localeCompare(b.id))
    const canonical = group[0]
    const docs = attachments(group)
    const seats = uniq(group.map((f) => f.seat))
    const bookingRefs = uniq(group.map((f) => f.bookingRef))
    const merged = {
      airline: first(group, 'airline'), flightNumber: first(group, 'flightNumber'),
      from: first(group, 'from'), to: first(group, 'to'),
      departureDate: first(group, 'departureDate'), departureTime: first(group, 'departureTime'),
      arrivalDate: first(group, 'arrivalDate'), arrivalTime: first(group, 'arrivalTime'),
      bookingRef: bookingRefs[0] || '', bookingRefs,
      terminal: first(group, 'terminal'), seat: seats.join(' · '), notes: first(group, 'notes'),
      attachments: docs, sourceDocumentIds: uniq(group.map((f) => f.sourceDocumentId || f.documentId)),
      flightKey: key, flightRulesVersion: RULE_VERSION, updatedAt: FieldValue.serverTimestamp()
    }
    if (docs[0]) Object.assign(merged, {
      documentId: docs[0].documentId, sourceDocumentId: docs[0].documentId,
      attachmentName: docs[0].name || '', attachmentUrl: docs[0].url || '', attachmentStoragePath: docs[0].storagePath || ''
    })
    merged.flightRulesFingerprint = fingerprint({ ...canonical, ...merged })
    await tripRef.collection('flights').doc(canonical.id).set(merged, { merge: true })
    for (const duplicate of group.slice(1)) {
      await tripRef.collection('flights').doc(duplicate.id).delete()
      removedDuplicates += 1
    }
    canonicals.push({ id: canonical.id, ...canonical, ...merged })
  }

  for (const [key, group] of groups) {
    const flight = canonicals.find((f) => f.flightKey === key)
    if (flight) await rewriteItinerary(tripRef, tripDoc.data(), flight, canonicals, group, key)
  }

  return { groups: groups.size, removedDuplicates }
}

export const normalizeImportedFlightV3 = onDocumentWritten({
  document: 'trips/{tripId}/flights/{flightId}', region: 'europe-west1', timeoutSeconds: 120, memory: '512MiB'
}, async (event) => {
  if (!event.data?.after?.exists) return
  const flight = event.data.after.data()
  if (flight.flightRulesVersion === RULE_VERSION && flight.flightRulesFingerprint === fingerprint(flight)) return
  await normalizeTripFlights(event.params.tripId)
})

export const normalizeFlightDataV3 = onCall({ region: 'europe-west1', timeoutSeconds: 180, memory: '512MiB' }, async (request) => {
  if (!request.auth?.uid) throw new HttpsError('unauthenticated', 'Authentication required')
  const trips = await db.collection('trips').where('ownerId', '==', request.auth.uid).get()
  const results = []
  for (const trip of trips.docs) results.push({ tripId: trip.id, ...(await normalizeTripFlights(trip.id)) })
  return { ok: true, trips: results }
})
