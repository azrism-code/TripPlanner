import { onRequest } from 'firebase-functions/v2/https'
import { onDocumentCreated } from 'firebase-functions/v2/firestore'
import { initializeApp, getApps } from 'firebase-admin/app'
import { getAuth } from 'firebase-admin/auth'
import { getFirestore, FieldValue } from 'firebase-admin/firestore'
import OpenAI from 'openai'

if (!getApps().length) initializeApp()

const db = getFirestore()
const adminAuth = getAuth()
const IMPORT_VERSION = 'v1'

function clean(value) {
  return typeof value === 'string' ? value.trim() : value
}

function nonEmpty(value) {
  return value !== null && value !== undefined && value !== ''
}

function patchDefined(source, keys) {
  const patch = {}
  for (const key of keys) {
    if (nonEmpty(source?.[key])) patch[key] = source[key]
  }
  return patch
}

function safeId(value) {
  return String(value || '').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 120)
}

function inTripRange(date, trip) {
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return false
  if (trip.startDate && date < trip.startDate) return false
  if (trip.endDate && date > trip.endDate) return false
  return true
}

function attachmentFields(documentData, documentId) {
  return {
    documentId,
    attachmentName: documentData.name || '',
    attachmentUrl: documentData.downloadURL || '',
    attachmentStoragePath: documentData.storagePath || '',
    sourceDocumentId: documentId,
    source: 'document-import'
  }
}

async function readCollection(tripId, name, limit = 50) {
  const snapshot = await db.collection('trips').doc(tripId).collection(name).limit(limit).get()
  return snapshot.docs.map((item) => ({ id: item.id, ...item.data() }))
}

async function buildTripContext(tripId, trip) {
  const [takeItems, hotels, cars, flights, expenses, itineraryDays, documents, places] = await Promise.all([
    readCollection(tripId, 'takeItems'),
    readCollection(tripId, 'hotels'),
    readCollection(tripId, 'cars'),
    readCollection(tripId, 'flights'),
    readCollection(tripId, 'expenses'),
    readCollection(tripId, 'itineraryDays'),
    readCollection(tripId, 'documents', 20),
    readCollection(tripId, 'places', 80)
  ])

  return {
    trip: {
      title: trip.title || '',
      destination: trip.destination || '',
      startDate: trip.startDate || '',
      endDate: trip.endDate || '',
      budgetLimit: trip.budgetLimit || 0,
      budgetCurrency: trip.budgetCurrency || 'ILS'
    },
    takeItems,
    hotels,
    cars,
    flights,
    expenses,
    itineraryDays,
    places,
    documents: documents.map((item) => ({
      id: item.id,
      name: item.name || '',
      category: item.category || '',
      linkedCollection: item.linkedCollection || '',
      linkedId: item.linkedId || '',
      contentType: item.contentType || '',
      downloadURL: item.downloadURL || '',
      processingStatus: item.processingStatus || ''
    }))
  }
}

const extractionSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    summary: { type: 'string' },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    flights: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          airline: { type: 'string' },
          flightNumber: { type: 'string' },
          from: { type: 'string' },
          to: { type: 'string' },
          departureDate: { type: 'string' },
          departureTime: { type: 'string' },
          arrivalDate: { type: 'string' },
          arrivalTime: { type: 'string' },
          bookingRef: { type: 'string' },
          terminal: { type: 'string' },
          seat: { type: 'string' },
          notes: { type: 'string' }
        },
        required: ['airline', 'flightNumber', 'from', 'to', 'departureDate', 'departureTime', 'arrivalDate', 'arrivalTime', 'bookingRef', 'terminal', 'seat', 'notes']
      }
    },
    hotels: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          name: { type: 'string' },
          city: { type: 'string' },
          address: { type: 'string' },
          checkIn: { type: 'string' },
          checkOut: { type: 'string' },
          bookingRef: { type: 'string' },
          room: { type: 'string' },
          notes: { type: 'string' }
        },
        required: ['name', 'city', 'address', 'checkIn', 'checkOut', 'bookingRef', 'room', 'notes']
      }
    },
    cars: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          company: { type: 'string' },
          pickup: { type: 'string' },
          dropoff: { type: 'string' },
          pickupDate: { type: 'string' },
          pickupTime: { type: 'string' },
          dropoffDate: { type: 'string' },
          dropoffTime: { type: 'string' },
          bookingRef: { type: 'string' },
          vehicle: { type: 'string' },
          notes: { type: 'string' }
        },
        required: ['company', 'pickup', 'dropoff', 'pickupDate', 'pickupTime', 'dropoffDate', 'dropoffTime', 'bookingRef', 'vehicle', 'notes']
      }
    },
    tickets: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          title: { type: 'string' },
          venue: { type: 'string' },
          city: { type: 'string' },
          date: { type: 'string' },
          time: { type: 'string' },
          bookingRef: { type: 'string' },
          notes: { type: 'string' }
        },
        required: ['title', 'venue', 'city', 'date', 'time', 'bookingRef', 'notes']
      }
    },
    costs: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          category: { type: 'string' },
          description: { type: 'string' },
          amount: { type: 'number' },
          currency: { type: 'string' }
        },
        required: ['category', 'description', 'amount', 'currency']
      }
    }
  },
  required: ['summary', 'confidence', 'flights', 'hotels', 'cars', 'tickets', 'costs']
}

async function extractTravelDocument(documentData, trip) {
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  const fileBlock = documentData.contentType?.startsWith('image/')
    ? { type: 'input_image', image_url: documentData.downloadURL, detail: 'high' }
    : { type: 'input_file', file_url: documentData.downloadURL }

  const response = await client.responses.create({
    model: process.env.OPENAI_IMPORT_MODEL || 'gpt-5.4-mini',
    instructions: `You extract travel booking facts from uploaded tickets and confirmations for a travel-planning app. The uploaded document is the source of truth. Never invent missing values. Use empty strings or empty arrays when a fact is not present. Dates must be YYYY-MM-DD and times HH:MM when clearly available. Preserve airport names/codes, hotel names, confirmation numbers and monetary amounts exactly as shown. If one booking contains multiple flight segments, return each segment in flights. Costs must contain each actual charged/total amount only once, not once per segment. The trip currently runs from ${trip.startDate || 'unknown'} to ${trip.endDate || 'unknown'} and destination is ${trip.destination || 'unknown'}.`,
    input: [{
      role: 'user',
      content: [
        { type: 'input_text', text: `Document category selected by the user: ${documentData.category || 'unknown'}. Read this document and return all relevant travel facts.` },
        fileBlock
      ]
    }],
    text: {
      format: {
        type: 'json_schema',
        name: 'travel_booking_import',
        strict: true,
        schema: extractionSchema
      }
    }
  })

  if (!response.output_text) throw new Error('AI returned no extraction result')
  return JSON.parse(response.output_text)
}

async function upsertPlace(tripId, documentId, key, place) {
  if (!place?.name) return
  const ref = db.collection('trips').doc(tripId).collection('places').doc(`import_${safeId(documentId)}_${safeId(key)}`)
  await ref.set({
    name: clean(place.name),
    city: clean(place.city || ''),
    type: clean(place.type || 'place'),
    date: clean(place.date || ''),
    sourceDocumentId: documentId,
    source: 'document-import',
    updatedAt: FieldValue.serverTimestamp(),
    createdAt: FieldValue.serverTimestamp()
  }, { merge: true })
}

async function upsertItineraryItem(tripId, trip, documentId, sourceKey, item) {
  if (!inTripRange(item.date, trip) || !item.title) return
  const dayRef = db.collection('trips').doc(tripId).collection('itineraryDays').doc(item.date)
  await db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(dayRef)
    const current = snapshot.exists ? snapshot.data() : {}
    const items = Array.isArray(current.items) ? current.items : []
    const filtered = items.filter((existing) => !(existing.sourceDocumentId === documentId && existing.sourceKey === sourceKey))
    filtered.push({
      time: clean(item.time || ''),
      title: clean(item.title),
      location: clean(item.location || ''),
      type: clean(item.type || 'booking'),
      notes: clean(item.notes || ''),
      sourceDocumentId: documentId,
      sourceKey
    })
    filtered.sort((a, b) => String(a.time || '99:99').localeCompare(String(b.time || '99:99')))
    transaction.set(dayRef, {
      date: item.date,
      city: current.city || clean(item.city || ''),
      title: current.title || '',
      items: filtered,
      updatedAt: FieldValue.serverTimestamp()
    }, { merge: true })
  })
}

async function saveImportedData(tripId, documentId, documentData, trip, extracted) {
  const tripRef = db.collection('trips').doc(tripId)
  const attachment = attachmentFields(documentData, documentId)
  const counts = { flights: 0, hotels: 0, cars: 0, tickets: 0, expenses: 0, places: 0, itinerary: 0 }

  for (let index = 0; index < extracted.flights.length; index += 1) {
    const flight = extracted.flights[index]
    const targetId = documentData.linkedCollection === 'flights' && documentData.linkedId && index === 0
      ? documentData.linkedId
      : `import_${safeId(documentId)}_flight_${index}`
    const patch = {
      ...patchDefined(flight, ['airline', 'flightNumber', 'from', 'to', 'departureDate', 'departureTime', 'arrivalDate', 'arrivalTime', 'bookingRef', 'terminal', 'seat', 'notes']),
      ...attachment,
      importedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp()
    }
    await tripRef.collection('flights').doc(targetId).set(patch, { merge: true })
    counts.flights += 1

    if (flight.from) {
      await upsertPlace(tripId, documentId, `flight_${index}_from`, { name: flight.from, type: 'airport', date: flight.departureDate })
      counts.places += 1
    }
    if (flight.to) {
      await upsertPlace(tripId, documentId, `flight_${index}_to`, { name: flight.to, type: 'airport', date: flight.arrivalDate })
      counts.places += 1
    }
    if (flight.departureDate) {
      await upsertItineraryItem(tripId, trip, documentId, `flight_${index}_departure`, {
        date: flight.departureDate,
        time: flight.departureTime,
        title: `✈️ ${flight.airline || 'טיסה'}${flight.flightNumber ? ` ${flight.flightNumber}` : ''}`,
        location: [flight.from, flight.to].filter(Boolean).join(' → '),
        type: 'flight',
        notes: [flight.bookingRef ? `הזמנה: ${flight.bookingRef}` : '', flight.terminal ? `טרמינל: ${flight.terminal}` : '', flight.seat ? `מושב: ${flight.seat}` : ''].filter(Boolean).join(' · ')
      })
      counts.itinerary += 1
    }
    if (flight.arrivalDate && flight.arrivalDate !== flight.departureDate) {
      await upsertItineraryItem(tripId, trip, documentId, `flight_${index}_arrival`, {
        date: flight.arrivalDate,
        time: flight.arrivalTime,
        title: `נחיתה ${flight.to || ''}`.trim(),
        location: flight.to,
        type: 'flight-arrival',
        notes: flight.airline || ''
      })
      counts.itinerary += 1
    }
  }

  for (let index = 0; index < extracted.hotels.length; index += 1) {
    const hotel = extracted.hotels[index]
    const targetId = documentData.linkedCollection === 'hotels' && documentData.linkedId && index === 0
      ? documentData.linkedId
      : `import_${safeId(documentId)}_hotel_${index}`
    await tripRef.collection('hotels').doc(targetId).set({
      ...patchDefined(hotel, ['name', 'city', 'address', 'checkIn', 'checkOut', 'bookingRef', 'room', 'notes']),
      ...attachment,
      importedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp()
    }, { merge: true })
    counts.hotels += 1

    if (hotel.name) {
      await upsertPlace(tripId, documentId, `hotel_${index}`, { name: hotel.name, city: hotel.city, type: 'hotel', date: hotel.checkIn })
      counts.places += 1
    }
    if (hotel.checkIn) {
      await upsertItineraryItem(tripId, trip, documentId, `hotel_${index}_checkin`, {
        date: hotel.checkIn,
        time: '',
        title: `🏨 צ׳ק-אין ${hotel.name || 'מלון'}`,
        location: hotel.address || hotel.city,
        city: hotel.city,
        type: 'hotel',
        notes: hotel.bookingRef ? `הזמנה: ${hotel.bookingRef}` : ''
      })
      counts.itinerary += 1
    }
    if (hotel.checkOut) {
      await upsertItineraryItem(tripId, trip, documentId, `hotel_${index}_checkout`, {
        date: hotel.checkOut,
        time: '',
        title: `צ׳ק-אאוט ${hotel.name || 'מלון'}`,
        location: hotel.address || hotel.city,
        city: hotel.city,
        type: 'hotel-checkout',
        notes: ''
      })
      counts.itinerary += 1
    }
  }

  for (let index = 0; index < extracted.cars.length; index += 1) {
    const car = extracted.cars[index]
    const targetId = documentData.linkedCollection === 'cars' && documentData.linkedId && index === 0
      ? documentData.linkedId
      : `import_${safeId(documentId)}_car_${index}`
    await tripRef.collection('cars').doc(targetId).set({
      ...patchDefined(car, ['company', 'pickup', 'dropoff', 'pickupDate', 'pickupTime', 'dropoffDate', 'dropoffTime', 'bookingRef', 'vehicle', 'notes']),
      ...attachment,
      importedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp()
    }, { merge: true })
    counts.cars += 1

    if (car.pickup) {
      await upsertPlace(tripId, documentId, `car_${index}_pickup`, { name: car.pickup, type: 'car-rental', date: car.pickupDate })
      counts.places += 1
    }
    if (car.dropoff) {
      await upsertPlace(tripId, documentId, `car_${index}_dropoff`, { name: car.dropoff, type: 'car-rental', date: car.dropoffDate })
      counts.places += 1
    }
    if (car.pickupDate) {
      await upsertItineraryItem(tripId, trip, documentId, `car_${index}_pickup`, {
        date: car.pickupDate,
        time: car.pickupTime,
        title: `🚗 איסוף רכב${car.company ? ` · ${car.company}` : ''}`,
        location: car.pickup,
        type: 'car',
        notes: car.bookingRef ? `הזמנה: ${car.bookingRef}` : ''
      })
      counts.itinerary += 1
    }
    if (car.dropoffDate) {
      await upsertItineraryItem(tripId, trip, documentId, `car_${index}_dropoff`, {
        date: car.dropoffDate,
        time: car.dropoffTime,
        title: `החזרת רכב${car.company ? ` · ${car.company}` : ''}`,
        location: car.dropoff,
        type: 'car-return',
        notes: ''
      })
      counts.itinerary += 1
    }
  }

  for (let index = 0; index < extracted.tickets.length; index += 1) {
    const ticket = extracted.tickets[index]
    const targetId = `import_${safeId(documentId)}_ticket_${index}`
    await tripRef.collection('tickets').doc(targetId).set({
      ...patchDefined(ticket, ['title', 'venue', 'city', 'date', 'time', 'bookingRef', 'notes']),
      ...attachment,
      importedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp()
    }, { merge: true })
    counts.tickets += 1
    if (ticket.venue || ticket.title) {
      await upsertPlace(tripId, documentId, `ticket_${index}`, { name: ticket.venue || ticket.title, city: ticket.city, type: 'attraction', date: ticket.date })
      counts.places += 1
    }
    if (ticket.date) {
      await upsertItineraryItem(tripId, trip, documentId, `ticket_${index}`, {
        date: ticket.date,
        time: ticket.time,
        title: ticket.title || 'כרטיס / אטרקציה',
        location: ticket.venue || ticket.city,
        city: ticket.city,
        type: 'ticket',
        notes: ticket.bookingRef ? `הזמנה: ${ticket.bookingRef}` : ticket.notes
      })
      counts.itinerary += 1
    }
  }

  for (let index = 0; index < extracted.costs.length; index += 1) {
    const cost = extracted.costs[index]
    if (!(Number(cost.amount) > 0)) continue
    const expenseId = `import_${safeId(documentId)}_cost_${index}`
    await tripRef.collection('expenses').doc(expenseId).set({
      description: clean(cost.description || documentData.name || 'הזמנה'),
      category: clean(cost.category || documentData.category || 'כללי'),
      amount: Number(cost.amount),
      currency: clean(cost.currency || trip.budgetCurrency || 'ILS'),
      sourceDocumentId: documentId,
      source: 'document-import',
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp()
    }, { merge: true })
    counts.expenses += 1
  }

  return counts
}

async function importDocument(tripId, documentId, force = false) {
  const tripRef = db.collection('trips').doc(tripId)
  const documentRef = tripRef.collection('documents').doc(documentId)
  const [tripSnapshot, documentSnapshot] = await Promise.all([tripRef.get(), documentRef.get()])
  if (!tripSnapshot.exists || !documentSnapshot.exists) throw new Error('Trip or document not found')

  const trip = tripSnapshot.data()
  const documentData = documentSnapshot.data()
  if (!force && ['processing', 'done'].includes(documentData.processingStatus) && documentData.extractionVersion === IMPORT_VERSION) {
    return { skipped: true, summary: documentData.extractionSummary || '' }
  }
  if (!documentData.downloadURL) throw new Error('Document has no download URL')

  await documentRef.set({
    processingStatus: 'processing',
    processingError: '',
    extractionVersion: IMPORT_VERSION,
    processingStartedAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp()
  }, { merge: true })

  try {
    const extracted = await extractTravelDocument(documentData, trip)
    const counts = await saveImportedData(tripId, documentId, documentData, trip, extracted)
    await documentRef.set({
      processingStatus: 'done',
      processingError: '',
      extractionVersion: IMPORT_VERSION,
      extractionSummary: clean(extracted.summary || ''),
      extractionConfidence: Number(extracted.confidence) || 0,
      extractedCounts: counts,
      extractedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp()
    }, { merge: true })
    return { skipped: false, summary: extracted.summary || '', counts }
  } catch (error) {
    await documentRef.set({
      processingStatus: 'error',
      processingError: String(error?.message || 'Document import failed').slice(0, 500),
      extractionVersion: IMPORT_VERSION,
      updatedAt: FieldValue.serverTimestamp()
    }, { merge: true })
    throw error
  }
}

export const importTravelDocument = onDocumentCreated({
  document: 'trips/{tripId}/documents/{documentId}',
  region: 'europe-west1',
  timeoutSeconds: 120,
  memory: '1GiB',
  secrets: ['OPENAI_API_KEY']
}, async (event) => {
  const { tripId, documentId } = event.params
  await importDocument(tripId, documentId)
})

export const analyzeDocument = onRequest({
  region: 'europe-west1',
  cors: true,
  timeoutSeconds: 120,
  memory: '1GiB',
  secrets: ['OPENAI_API_KEY']
}, async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'POST only' })
    return
  }
  try {
    const authHeader = req.headers.authorization || ''
    if (!authHeader.startsWith('Bearer ')) {
      res.status(401).json({ error: 'Authentication required' })
      return
    }
    const decoded = await adminAuth.verifyIdToken(authHeader.slice(7))
    const tripId = clean(req.body?.tripId)
    const documentId = clean(req.body?.documentId)
    if (!tripId || !documentId) {
      res.status(400).json({ error: 'tripId and documentId are required' })
      return
    }
    const tripSnapshot = await db.collection('trips').doc(tripId).get()
    if (!tripSnapshot.exists || tripSnapshot.data().ownerId !== decoded.uid) {
      res.status(403).json({ error: 'Only the trip owner can analyze documents' })
      return
    }
    const result = await importDocument(tripId, documentId, req.body?.force !== false)
    res.json(result)
  } catch (error) {
    console.error('Document analysis error', error)
    res.status(500).json({ error: error?.message || 'Document analysis failed' })
  }
})

const tools = [
  {
    type: 'function',
    name: 'update_trip_fields',
    description: 'Update top-level trip details when the owner explicitly asks to change them.',
    strict: true,
    parameters: {
      type: 'object',
      properties: {
        title: { type: ['string', 'null'] },
        destination: { type: ['string', 'null'] },
        startDate: { type: ['string', 'null'] },
        endDate: { type: ['string', 'null'] },
        budgetLimit: { type: ['number', 'null'] },
        budgetCurrency: { type: ['string', 'null'] }
      },
      required: ['title', 'destination', 'startDate', 'endDate', 'budgetLimit', 'budgetCurrency'],
      additionalProperties: false
    }
  },
  {
    type: 'function',
    name: 'add_take_item',
    description: 'Add an item to the packing/take list.',
    strict: true,
    parameters: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
      additionalProperties: false
    }
  },
  {
    type: 'function',
    name: 'add_hotel',
    description: 'Add a hotel booking. Use uploaded hotel confirmations as the source of truth when available.',
    strict: true,
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string' }, city: { type: 'string' }, checkIn: { type: 'string' }, checkOut: { type: 'string' }, bookingRef: { type: 'string' }, notes: { type: 'string' }
      },
      required: ['name', 'city', 'checkIn', 'checkOut', 'bookingRef', 'notes'],
      additionalProperties: false
    }
  },
  {
    type: 'function',
    name: 'add_car',
    description: 'Add a car rental booking. Use uploaded rental confirmations as the source of truth when available.',
    strict: true,
    parameters: {
      type: 'object',
      properties: {
        company: { type: 'string' }, pickup: { type: 'string' }, dropoff: { type: 'string' }, pickupDate: { type: 'string' }, dropoffDate: { type: 'string' }, bookingRef: { type: 'string' }, notes: { type: 'string' }
      },
      required: ['company', 'pickup', 'dropoff', 'pickupDate', 'dropoffDate', 'bookingRef', 'notes'],
      additionalProperties: false
    }
  },
  {
    type: 'function',
    name: 'add_flight',
    description: 'Add a flight booking. Use uploaded e-tickets and booking confirmations as the source of truth when available.',
    strict: true,
    parameters: {
      type: 'object',
      properties: {
        airline: { type: 'string' }, flightNumber: { type: 'string' }, from: { type: 'string' }, to: { type: 'string' }, departureDate: { type: 'string' }, departureTime: { type: 'string' }, arrivalDate: { type: 'string' }, arrivalTime: { type: 'string' }, bookingRef: { type: 'string' }, notes: { type: 'string' }
      },
      required: ['airline', 'flightNumber', 'from', 'to', 'departureDate', 'departureTime', 'arrivalDate', 'arrivalTime', 'bookingRef', 'notes'],
      additionalProperties: false
    }
  },
  {
    type: 'function',
    name: 'add_expense',
    description: 'Add a trip expense.',
    strict: true,
    parameters: {
      type: 'object',
      properties: { description: { type: 'string' }, category: { type: 'string' }, amount: { type: 'number' } },
      required: ['description', 'category', 'amount'],
      additionalProperties: false
    }
  },
  {
    type: 'function',
    name: 'set_itinerary_day',
    description: 'Create or replace one day of the itinerary. Use only when the owner explicitly asks to build or change that day.',
    strict: true,
    parameters: {
      type: 'object',
      properties: {
        date: { type: 'string' }, city: { type: 'string' }, title: { type: 'string' },
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: { time: { type: 'string' }, title: { type: 'string' }, location: { type: 'string' }, type: { type: 'string' }, notes: { type: 'string' } },
            required: ['time', 'title', 'location', 'type', 'notes'],
            additionalProperties: false
          }
        }
      },
      required: ['date', 'city', 'title', 'items'],
      additionalProperties: false
    }
  }
]

async function executeTool(tripId, call) {
  const args = JSON.parse(call.arguments || '{}')
  const tripRef = db.collection('trips').doc(tripId)

  if (call.name === 'update_trip_fields') {
    const patch = { updatedAt: FieldValue.serverTimestamp() }
    for (const key of ['title', 'destination', 'startDate', 'endDate', 'budgetLimit', 'budgetCurrency']) {
      if (args[key] !== null && args[key] !== undefined) patch[key] = args[key]
    }
    await tripRef.set(patch, { merge: true })
    return { ok: true }
  }
  if (call.name === 'add_take_item') {
    await tripRef.collection('takeItems').add({ text: clean(args.text), done: false, createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() })
    return { ok: true }
  }
  if (call.name === 'add_hotel') {
    await tripRef.collection('hotels').add({ ...args, createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() })
    return { ok: true }
  }
  if (call.name === 'add_car') {
    await tripRef.collection('cars').add({ ...args, createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() })
    return { ok: true }
  }
  if (call.name === 'add_flight') {
    await tripRef.collection('flights').add({ ...args, createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() })
    return { ok: true }
  }
  if (call.name === 'add_expense') {
    await tripRef.collection('expenses').add({ description: clean(args.description), category: clean(args.category), amount: Number(args.amount) || 0, createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() })
    return { ok: true }
  }
  if (call.name === 'set_itinerary_day') {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(args.date || '')) throw new Error('Invalid itinerary date')
    await tripRef.collection('itineraryDays').doc(args.date).set({
      date: args.date,
      city: clean(args.city),
      title: clean(args.title),
      items: Array.isArray(args.items) ? args.items.map((item) => ({
        time: clean(item.time), title: clean(item.title), location: clean(item.location), type: clean(item.type), notes: clean(item.notes)
      })) : [],
      updatedAt: FieldValue.serverTimestamp()
    }, { merge: true })
    return { ok: true, date: args.date }
  }
  throw new Error(`Unsupported tool: ${call.name}`)
}

export const tripChat = onRequest({
  region: 'europe-west1',
  cors: true,
  timeoutSeconds: 120,
  memory: '1GiB',
  secrets: ['OPENAI_API_KEY']
}, async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'POST only' })
    return
  }
  try {
    const authHeader = req.headers.authorization || ''
    if (!authHeader.startsWith('Bearer ')) {
      res.status(401).json({ error: 'Authentication required' })
      return
    }
    const decoded = await adminAuth.verifyIdToken(authHeader.slice(7))
    const tripId = clean(req.body?.tripId)
    const message = clean(req.body?.message)
    if (!tripId || !message) {
      res.status(400).json({ error: 'tripId and message are required' })
      return
    }
    const tripRef = db.collection('trips').doc(tripId)
    const tripSnapshot = await tripRef.get()
    if (!tripSnapshot.exists) {
      res.status(404).json({ error: 'Trip not found' })
      return
    }
    const trip = tripSnapshot.data()
    if (trip.ownerId !== decoded.uid) {
      res.status(403).json({ error: 'Only the trip owner can use Trip AI' })
      return
    }

    const context = await buildTripContext(tripId, trip)
    const chatRoot = db.collection('tripAiChats').doc(tripId)
    const historySnapshot = await chatRoot.collection('messages').orderBy('createdAt', 'desc').limit(16).get()
    const history = historySnapshot.docs.map((item) => item.data()).reverse()
    await chatRoot.collection('messages').add({ role: 'user', text: message, uid: decoded.uid, createdAt: FieldValue.serverTimestamp() })

    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
    const documentBlocks = context.documents
      .filter((item) => item.downloadURL)
      .slice(0, 10)
      .map((item) => item.contentType.startsWith('image/')
        ? { type: 'input_image', image_url: item.downloadURL, detail: 'auto' }
        : { type: 'input_file', file_url: item.downloadURL })

    const historyText = history.map((item) => `${item.role === 'assistant' ? 'Trip AI' : 'User'}: ${item.text || ''}`).join('\n')
    const instructions = `You are Trip AI inside a travel-planning app. The authenticated user is the OWNER of this trip. Use trip data and uploaded documents as the source of truth. Uploaded booking/ticket documents have priority over manually typed booking facts. Never invent confirmation numbers, flight details, hotel bookings or dates. You may use write tools only when the owner explicitly asks to add, change, import, build or correct something. When building itinerary days, stay inside the trip start/end dates and respect known flights, hotels and car timings. Keep replies concise and practical. Reply in Hebrew unless the user writes in another language.`

    const content = [{ type: 'input_text', text: `Current trip data:\n${JSON.stringify(context, null, 2)}\n\nRecent conversation:\n${historyText || '(none)'}\n\nOwner request:\n${message}` }, ...documentBlocks]
    let response = await client.responses.create({
      model: process.env.OPENAI_MODEL || 'gpt-5.6',
      instructions,
      input: [{ role: 'user', content }],
      tools,
      tool_choice: 'auto',
      parallel_tool_calls: false
    })

    for (let round = 0; round < 4; round += 1) {
      const calls = (response.output || []).filter((item) => item.type === 'function_call')
      if (!calls.length) break
      const outputs = []
      for (const call of calls) {
        let result
        try {
          result = await executeTool(tripId, call)
          await chatRoot.collection('actions').add({ tool: call.name, arguments: call.arguments || '{}', result, createdAt: FieldValue.serverTimestamp() })
        } catch (error) {
          result = { ok: false, error: error?.message || 'Tool failed' }
        }
        outputs.push({ type: 'function_call_output', call_id: call.call_id, output: JSON.stringify(result) })
      }
      response = await client.responses.create({
        model: process.env.OPENAI_MODEL || 'gpt-5.6',
        previous_response_id: response.id,
        instructions,
        input: outputs,
        tools,
        tool_choice: 'auto',
        parallel_tool_calls: false
      })
    }

    const reply = response.output_text || 'העדכון בוצע.'
    await chatRoot.collection('messages').add({ role: 'assistant', text: reply, uid: decoded.uid, createdAt: FieldValue.serverTimestamp() })
    res.json({ reply })
  } catch (error) {
    console.error('Trip AI error', error)
    res.status(500).json({ error: 'Trip AI is temporarily unavailable' })
  }
})
