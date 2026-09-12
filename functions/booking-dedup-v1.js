import { onDocumentWritten } from 'firebase-functions/v2/firestore'
import { initializeApp, getApps } from 'firebase-admin/app'
import { getFirestore, FieldValue } from 'firebase-admin/firestore'

if (!getApps().length) initializeApp()
const db = getFirestore()

const RULE_VERSION = 'booking-dedup-v1'
const SUPPORTED_COLLECTIONS = ['hotels', 'cars', 'tickets', 'trains', 'transports', 'bookings']

const CONFIG = {
  hotels: {
    fields: ['name', 'city', 'address', 'checkIn', 'checkOut', 'bookingRef', 'room', 'notes'],
    keys: (r) => compact([
      strongRef(r.bookingRef, 'hotel'),
      all(r.name, r.checkIn, r.checkOut) && `stay|${norm(r.name)}|${r.checkIn}|${r.checkOut}`,
      all(r.name, r.checkIn, r.city || r.address) && `stay-start|${norm(r.name)}|${r.checkIn}|${norm(r.city || r.address)}`
    ])
  },
  cars: {
    fields: ['company', 'pickup', 'dropoff', 'pickupDate', 'pickupTime', 'dropoffDate', 'dropoffTime', 'bookingRef', 'vehicle', 'notes'],
    keys: (r) => compact([
      strongRef(r.bookingRef, 'car'),
      all(r.company, r.pickupDate, r.dropoffDate, r.pickup, r.dropoff) && `rental|${norm(r.company)}|${r.pickupDate}|${r.dropoffDate}|${norm(r.pickup)}|${norm(r.dropoff)}`,
      all(r.company, r.pickupDate, r.pickup) && `rental-start|${norm(r.company)}|${r.pickupDate}|${norm(r.pickup)}`
    ])
  },
  tickets: {
    fields: ['title', 'venue', 'city', 'date', 'time', 'bookingRef', 'notes'],
    keys: (r) => compact([
      all(r.bookingRef, r.date, r.title || r.venue) && `ticket-ref|${norm(r.bookingRef)}|${r.date}|${norm(r.title || r.venue)}`,
      all(r.title, r.date, r.venue || r.city) && `event|${norm(r.title)}|${r.date}|${cleanTime(r.time)}|${norm(r.venue || r.city)}`
    ])
  },
  trains: {
    fields: ['operator', 'trainNumber', 'from', 'to', 'departureDate', 'departureTime', 'arrivalDate', 'arrivalTime', 'bookingRef', 'carriage', 'seat', 'notes'],
    keys: (r) => compact([
      all(r.bookingRef, r.trainNumber || r.departureDate) && `train-ref|${norm(r.bookingRef)}|${norm(r.trainNumber)}|${r.departureDate || ''}`,
      all(r.from, r.to, r.departureDate, r.departureTime) && `train|${norm(r.trainNumber || r.operator)}|${norm(r.from)}|${norm(r.to)}|${r.departureDate}|${cleanTime(r.departureTime)}`
    ])
  },
  transports: {
    fields: ['type', 'provider', 'serviceNumber', 'from', 'to', 'departureDate', 'departureTime', 'arrivalDate', 'arrivalTime', 'bookingRef', 'notes'],
    keys: (r) => compact([
      all(r.bookingRef, r.departureDate, r.from, r.to) && `transport-ref|${norm(r.bookingRef)}|${r.departureDate}|${norm(r.from)}|${norm(r.to)}`,
      all(r.from, r.to, r.departureDate, r.departureTime) && `transport|${norm(r.type)}|${norm(r.serviceNumber || r.provider)}|${norm(r.from)}|${norm(r.to)}|${r.departureDate}|${cleanTime(r.departureTime)}`
    ])
  },
  bookings: {
    fields: ['type', 'provider', 'title', 'city', 'location', 'startDate', 'startTime', 'endDate', 'endTime', 'bookingRef', 'notes'],
    keys: (r) => compact([
      all(r.bookingRef, r.title || r.provider) && `booking-ref|${norm(r.type)}|${norm(r.bookingRef)}|${norm(r.title || r.provider)}`,
      all(r.title, r.startDate, r.location || r.city) && `booking|${norm(r.type)}|${norm(r.title)}|${r.startDate}|${cleanTime(r.startTime)}|${norm(r.location || r.city)}`
    ])
  }
}

function text(value) {
  return String(value ?? '').trim()
}

function norm(value) {
  return text(value)
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
}

function cleanTime(value) {
  const match = text(value).match(/\b(\d{1,2}):(\d{2})\b/)
  return match ? `${match[1].padStart(2, '0')}:${match[2]}` : text(value)
}

function compact(values) {
  return [...new Set(values.filter(Boolean))]
}

function all(...values) {
  return values.every((value) => text(value))
}

function strongRef(value, prefix) {
  const normalized = norm(value)
  return normalized.length >= 4 ? `${prefix}-ref|${normalized}` : ''
}

function uniqText(values) {
  const result = []
  const seen = new Set()
  for (const raw of values.flatMap((value) => Array.isArray(value) ? value : [value])) {
    const value = text(raw)
    const key = norm(value)
    if (!value || seen.has(key)) continue
    seen.add(key)
    result.push(value)
  }
  return result
}

function sourceDocumentIds(records) {
  return uniqText(records.flatMap((record) => [
    record.sourceDocumentIds || [],
    record.sourceDocumentId || '',
    record.documentId || '',
    ...(Array.isArray(record.attachments) ? record.attachments.map((attachment) => attachment?.documentId || '') : [])
  ]))
}

function collectAttachments(records) {
  const map = new Map()
  for (const record of records) {
    for (const attachment of Array.isArray(record.attachments) ? record.attachments : []) {
      const key = text(attachment?.documentId) || text(attachment?.url) || text(attachment?.name)
      if (key) map.set(key, attachment)
    }
    const documentId = text(record.documentId || record.sourceDocumentId)
    const url = text(record.attachmentUrl)
    const name = text(record.attachmentName)
    if (documentId || url || name) {
      const key = documentId || url || name
      map.set(key, {
        documentId,
        name,
        url,
        storagePath: text(record.attachmentStoragePath),
        bookingRef: text(record.bookingRef),
        seat: text(record.seat)
      })
    }
  }
  return [...map.values()]
}

function firstValue(records, field) {
  return records.map((record) => record[field]).find((value) => value !== undefined && value !== null && value !== '') ?? ''
}

function mergeGroup(records, config) {
  const merged = {}
  for (const field of config.fields) {
    if (field === 'notes') {
      merged.notes = uniqText(records.map((record) => record.notes)).join(' · ')
    } else {
      merged[field] = firstValue(records, field)
    }
  }
  const refs = uniqText(records.flatMap((record) => [record.bookingRefs || [], record.bookingRef || '']))
  if (refs.length) {
    merged.bookingRefs = refs
    merged.bookingRef = merged.bookingRef || refs[0]
  }
  const documents = sourceDocumentIds(records)
  const attachments = collectAttachments(records)
  if (documents.length) merged.sourceDocumentIds = documents
  if (attachments.length) merged.attachments = attachments
  if (attachments[0]) {
    merged.documentId = attachments[0].documentId || documents[0] || ''
    merged.sourceDocumentId = attachments[0].documentId || documents[0] || ''
    merged.attachmentName = attachments[0].name || ''
    merged.attachmentUrl = attachments[0].url || ''
    merged.attachmentStoragePath = attachments[0].storagePath || ''
  }
  return merged
}

function groupsFor(records, config) {
  const groups = []
  for (const record of records) {
    const keys = new Set(config.keys(record))
    if (!keys.size) {
      groups.push({ records: [record], keys: new Set([`id|${record.id}`]) })
      continue
    }
    const matching = groups.filter((group) => [...keys].some((key) => group.keys.has(key)))
    if (!matching.length) {
      groups.push({ records: [record], keys })
      continue
    }
    const target = matching[0]
    target.records.push(record)
    for (const key of keys) target.keys.add(key)
    for (const extra of matching.slice(1)) {
      target.records.push(...extra.records)
      for (const key of extra.keys) target.keys.add(key)
      groups.splice(groups.indexOf(extra), 1)
    }
  }
  return groups
}

function recordProjection(record, config) {
  const projected = {}
  for (const field of config.fields) projected[field] = record[field] ?? ''
  projected.bookingRefs = Array.isArray(record.bookingRefs) ? record.bookingRefs : []
  projected.sourceDocumentIds = Array.isArray(record.sourceDocumentIds) ? record.sourceDocumentIds : []
  projected.attachments = Array.isArray(record.attachments) ? record.attachments : []
  projected.documentId = record.documentId || ''
  projected.sourceDocumentId = record.sourceDocumentId || ''
  projected.attachmentName = record.attachmentName || ''
  projected.attachmentUrl = record.attachmentUrl || ''
  projected.attachmentStoragePath = record.attachmentStoragePath || ''
  projected.dedupIdentity = record.dedupIdentity || ''
  projected.dedupVersion = record.dedupVersion || ''
  projected.dedupFingerprint = record.dedupFingerprint || ''
  return projected
}

function fingerprint(merged, identity, config) {
  const core = {}
  for (const field of config.fields) core[field] = merged[field] ?? ''
  core.bookingRefs = merged.bookingRefs || []
  core.sourceDocumentIds = merged.sourceDocumentIds || []
  core.attachments = (merged.attachments || []).map((attachment) => ({
    documentId: attachment?.documentId || '',
    name: attachment?.name || '',
    url: attachment?.url || ''
  }))
  core.identity = identity
  return JSON.stringify(core)
}

async function linkDocuments(tripRef, collectionName, canonicalId, documentIds, identity) {
  for (const documentId of documentIds) {
    await tripRef.collection('documents').doc(documentId).set({
      linkedCollection: collectionName,
      linkedId: canonicalId,
      dedupIdentity: identity,
      updatedAt: FieldValue.serverTimestamp()
    }, { merge: true })
  }
}

export async function normalizeBookingCollection(tripId, collectionName) {
  const config = CONFIG[collectionName]
  if (!config) return { groups: 0, removedDuplicates: 0 }

  const tripRef = db.collection('trips').doc(tripId)
  const snapshot = await tripRef.collection(collectionName).limit(500).get()
  const records = snapshot.docs.map((document) => ({ id: document.id, ...document.data() }))
  const groups = groupsFor(records, config)
  let removedDuplicates = 0

  for (const group of groups) {
    group.records.sort((a, b) => Number(a.id.startsWith('import_')) - Number(b.id.startsWith('import_')) || a.id.localeCompare(b.id))
    const canonical = group.records[0]
    const merged = mergeGroup(group.records, config)
    const identity = [...group.keys].sort()[0] || `id|${canonical.id}`
    const dedupFingerprint = fingerprint(merged, identity, config)
    const desired = {
      ...merged,
      dedupIdentity: identity,
      dedupVersion: RULE_VERSION,
      dedupFingerprint
    }

    if (JSON.stringify(recordProjection(canonical, config)) !== JSON.stringify(recordProjection(desired, config))) {
      await tripRef.collection(collectionName).doc(canonical.id).set({
        ...desired,
        updatedAt: FieldValue.serverTimestamp()
      }, { merge: true })
    }

    for (const duplicate of group.records.slice(1)) {
      await tripRef.collection(collectionName).doc(duplicate.id).delete()
      removedDuplicates += 1
    }

    const documents = desired.sourceDocumentIds || []
    if (documents.length) await linkDocuments(tripRef, collectionName, canonical.id, documents, identity)
  }

  return { groups: groups.length, removedDuplicates }
}

function itineraryKey(date, item) {
  return [
    date,
    cleanTime(item.time),
    norm(item.type),
    norm(item.title),
    norm(item.location)
  ].join('|')
}

async function normalizeItinerary(tripId) {
  const days = await db.collection('trips').doc(tripId).collection('itineraryDays').limit(120).get()
  let removed = 0
  for (const dayDoc of days.docs) {
    const day = dayDoc.data()
    const items = Array.isArray(day.items) ? day.items : []
    const map = new Map()
    for (const item of items) {
      const key = itineraryKey(day.date || dayDoc.id, item)
      if (!map.has(key)) {
        map.set(key, { ...item, sourceDocumentIds: uniqText([item.sourceDocumentIds || [], item.sourceDocumentId || '']) })
        continue
      }
      const existing = map.get(key)
      existing.notes = uniqText([existing.notes || '', item.notes || '']).join(' · ')
      existing.sourceDocumentIds = uniqText([existing.sourceDocumentIds || [], item.sourceDocumentIds || [], item.sourceDocumentId || ''])
      removed += 1
    }
    if (map.size !== items.length) {
      const normalized = [...map.values()].sort((a, b) => text(a.time || '99:99').localeCompare(text(b.time || '99:99')))
      await dayDoc.ref.set({ items: normalized, updatedAt: FieldValue.serverTimestamp() }, { merge: true })
    }
  }
  return removed
}

async function normalizeImportedPlaces(tripId) {
  const snapshot = await db.collection('trips').doc(tripId).collection('places').limit(500).get()
  const seen = new Map()
  let removed = 0
  for (const document of snapshot.docs) {
    const place = document.data()
    if (place.source !== 'document-import') continue
    const key = [norm(place.type), norm(place.name), norm(place.city), text(place.date)].join('|')
    if (!key.replace(/\|/g, '')) continue
    if (!seen.has(key)) {
      seen.set(key, document.id)
      continue
    }
    await document.ref.delete()
    removed += 1
  }
  return removed
}

export async function normalizeTripBookings(tripId) {
  const results = {}
  for (const collectionName of SUPPORTED_COLLECTIONS) {
    results[collectionName] = await normalizeBookingCollection(tripId, collectionName)
  }
  results.itineraryDuplicatesRemoved = await normalizeItinerary(tripId)
  results.placeDuplicatesRemoved = await normalizeImportedPlaces(tripId)
  return results
}

function fingerprintForRecord(collectionName, record) {
  const config = CONFIG[collectionName]
  if (!config) return ''
  const keys = config.keys(record)
  const identity = [...keys].sort()[0] || `id|${record.id || ''}`
  return fingerprint(mergeGroup([record], config), identity, config)
}

function collectionTrigger(collectionName) {
  return onDocumentWritten({
    document: `trips/{tripId}/${collectionName}/{itemId}`,
    region: 'europe-west1',
    timeoutSeconds: 120,
    memory: '512MiB'
  }, async (event) => {
    const after = event.data?.after
    if (!after?.exists) return
    const record = { id: event.params.itemId, ...after.data() }
    if (record.dedupVersion === RULE_VERSION && record.dedupFingerprint === fingerprintForRecord(collectionName, record)) return
    await normalizeBookingCollection(event.params.tripId, collectionName)
    await normalizeItinerary(event.params.tripId)
  })
}

export const normalizeHotelsV1 = collectionTrigger('hotels')
export const normalizeCarsV1 = collectionTrigger('cars')
export const normalizeTicketsV1 = collectionTrigger('tickets')
export const normalizeTrainsV1 = collectionTrigger('trains')
export const normalizeTransportsV1 = collectionTrigger('transports')
export const normalizeGenericBookingsV1 = collectionTrigger('bookings')

export const applyBookingDedupOnTripOpenV1 = onDocumentWritten({
  document: 'users/{uid}',
  region: 'europe-west1',
  timeoutSeconds: 240,
  memory: '512MiB'
}, async (event) => {
  const after = event.data?.after
  if (!after?.exists) return
  const profile = after.data()
  const tripId = profile.lastTripId
  if (!tripId) return

  const tripRef = db.collection('trips').doc(tripId)
  const tripSnapshot = await tripRef.get()
  if (!tripSnapshot.exists) return
  const trip = tripSnapshot.data()
  if (trip.ownerId !== event.params.uid || trip.bookingDedupVersion === RULE_VERSION) return

  const results = await normalizeTripBookings(tripId)
  await tripRef.set({
    bookingDedupVersion: RULE_VERSION,
    bookingDedupUpdatedAt: FieldValue.serverTimestamp(),
    bookingDedupLastResult: results
  }, { merge: true })
})
