import { onRequest } from 'firebase-functions/v2/https'
import { initializeApp, getApps } from 'firebase-admin/app'
import { getAuth } from 'firebase-admin/auth'
import { getFirestore, FieldValue } from 'firebase-admin/firestore'
import OpenAI from 'openai'

if (!getApps().length) initializeApp()

const db = getFirestore()
const adminAuth = getAuth()

const clean = (value) => typeof value === 'string' ? value.trim() : value

async function readCollection(tripId, name, limit = 80) {
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
    readCollection(tripId, 'documents', 30),
    readCollection(tripId, 'places')
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
    flights,
    hotels,
    cars,
    itineraryDays,
    places,
    expenses,
    takeItems,
    documents: documents.map((item) => ({
      id: item.id,
      name: item.name || '',
      category: item.category || '',
      processingStatus: item.processingStatus || '',
      extractionSummary: item.extractionSummary || '',
      extractionConfidence: item.extractionConfidence || 0,
      extractedCounts: item.extractedCounts || null,
      linkedCollection: item.linkedCollection || '',
      linkedId: item.linkedId || ''
    }))
  }
}

const tools = [
  {
    type: 'function',
    name: 'update_trip_fields',
    description: 'Update top-level trip details only when the owner explicitly asks.',
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
    description: 'Add an item to the packing list.',
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
    description: 'Add a hotel booking when explicitly requested.',
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
    description: 'Add a car-rental booking when explicitly requested.',
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
    description: 'Add a flight booking when explicitly requested. Prefer facts already extracted from uploaded documents.',
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
    description: 'Add a trip expense when explicitly requested.',
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
    description: 'Create or replace one itinerary day only when explicitly requested.',
    strict: true,
    parameters: {
      type: 'object',
      properties: {
        date: { type: 'string' }, city: { type: 'string' }, title: { type: 'string' },
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              time: { type: 'string' }, title: { type: 'string' }, location: { type: 'string' }, type: { type: 'string' }, notes: { type: 'string' }
            },
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

async function firstResponse(client, request) {
  const configured = process.env.OPENAI_MODEL?.trim()
  const models = [...new Set([configured, 'gpt-5.6', 'gpt-5.4-mini'].filter(Boolean))]
  let lastError
  for (const model of models) {
    try {
      const response = await client.responses.create({ ...request, model })
      return { response, model }
    } catch (error) {
      lastError = error
      console.error('Trip AI model attempt failed', {
        model,
        status: error?.status || null,
        code: error?.code || null,
        type: error?.type || null,
        message: String(error?.message || '').slice(0, 500)
      })
    }
  }
  throw lastError || new Error('No model available')
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

    const historyText = history.map((item) => `${item.role === 'assistant' ? 'Trip AI' : 'User'}: ${item.text || ''}`).join('\n')
    const instructions = 'You are Trip AI inside a travel-planning app. The authenticated user is the OWNER of this trip. Use the structured trip data and facts already extracted from uploaded documents as the source of truth. Uploaded booking/ticket facts have priority over manually typed facts. Never invent booking references, flight details, hotel bookings, prices or dates. Use write tools only when the owner explicitly asks to add, change, import, build or correct something. Keep itinerary entries concise, with full booking detail in the relevant booking section. Stay inside the trip dates and respect known flight, hotel and car timing. Reply concisely in Hebrew unless the user writes in another language.'
    const prompt = `Current trip data:\n${JSON.stringify(context, null, 2)}\n\nRecent conversation:\n${historyText || '(none)'}\n\nOwner request:\n${message}`

    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
    let { response, model } = await firstResponse(client, {
      instructions,
      input: [{ role: 'user', content: [{ type: 'input_text', text: prompt }] }],
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
        model,
        previous_response_id: response.id,
        instructions,
        input: outputs,
        tools,
        tool_choice: 'auto',
        parallel_tool_calls: false
      })
    }

    const reply = response.output_text || 'העדכון בוצע.'
    await chatRoot.collection('messages').add({ role: 'assistant', text: reply, uid: decoded.uid, model, createdAt: FieldValue.serverTimestamp() })
    res.json({ reply, model })
  } catch (error) {
    console.error('Trip AI error', {
      status: error?.status || null,
      code: error?.code || null,
      type: error?.type || null,
      message: String(error?.message || '').slice(0, 800)
    })
    res.status(500).json({ error: 'Trip AI is temporarily unavailable', errorCode: error?.code || error?.type || 'TRIP_AI_RUNTIME_ERROR' })
  }
})
