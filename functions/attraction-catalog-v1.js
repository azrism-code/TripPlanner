import { onRequest } from 'firebase-functions/v2/https'
import { getApps, initializeApp } from 'firebase-admin/app'
import { getAuth } from 'firebase-admin/auth'
import { getFirestore, FieldValue } from 'firebase-admin/firestore'

if (!getApps().length) initializeApp()

const db = getFirestore()
const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000

function send(res, status, body) {
  res.status(status).json(body)
}

function setCors(req, res) {
  const origin = req.get('origin')
  if (origin) res.set('Access-Control-Allow-Origin', origin)
  res.set('Vary', 'Origin')
  res.set('Access-Control-Allow-Headers', 'Authorization, Content-Type')
  res.set('Access-Control-Allow-Methods', 'GET, OPTIONS')
}

function cacheKey(city) {
  return city.trim().toLowerCase().normalize('NFKD').replace(/[^a-z0-9\u0590-\u05ff]+/g, '-').replace(/^-|-$/g, '').slice(0, 120)
}

function categoryFor(text) {
  const value = text.toLowerCase()
  if (/museum|מוזיאון|gallery|גלריה/.test(value)) return 'museum'
  if (/temple|shrine|church|cathedral|synagogue|mosque|מקדש|כנסי|קתדרלה|בית כנסת|מסגד/.test(value)) return 'religion'
  if (/park|garden|forest|פארק|גן|יער/.test(value)) return 'park'
  if (/market|mall|shopping|שוק|קניון|קניות/.test(value)) return 'shopping'
  if (/tower|view|observatory|תצפית|מגדל/.test(value)) return 'viewpoint'
  if (/castle|palace|fort|monument|טירה|ארמון|מבצר|אנדרטה/.test(value)) return 'landmark'
  if (/zoo|aquarium|theme park|גן חיות|אקווריום|פארק שעשועים/.test(value)) return 'attraction'
  return 'landmark'
}

function durationFor(category) {
  return ({ museum: 90, park: 75, attraction: 120, shopping: 90, viewpoint: 45, religion: 40, landmark: 60 })[category] || 60
}

async function geocodeCity(city) {
  const url = new URL('https://nominatim.openstreetmap.org/search')
  url.searchParams.set('q', city)
  url.searchParams.set('format', 'jsonv2')
  url.searchParams.set('limit', '1')
  url.searchParams.set('featuretype', 'city')
  url.searchParams.set('accept-language', 'he,en')
  const response = await fetch(url, { headers: { 'User-Agent': 'TripPlanner/0.8 (travel-planning-app)' } })
  if (!response.ok) throw new Error(`Geocoding failed (${response.status})`)
  const rows = await response.json()
  if (!rows.length) return null
  return { name: rows[0].display_name, lat: Number(rows[0].lat), lon: Number(rows[0].lon) }
}

async function fetchWikipediaAttractions(center, limit) {
  const url = new URL('https://he.wikipedia.org/w/api.php')
  url.searchParams.set('action', 'query')
  url.searchParams.set('format', 'json')
  url.searchParams.set('origin', '*')
  url.searchParams.set('generator', 'geosearch')
  url.searchParams.set('ggsprimary', 'all')
  url.searchParams.set('ggsnamespace', '0')
  url.searchParams.set('ggsradius', '10000')
  url.searchParams.set('ggslimit', String(Math.min(100, Math.max(limit * 3, 60))))
  url.searchParams.set('ggscoord', `${center.lat}|${center.lon}`)
  url.searchParams.set('prop', 'extracts|pageimages|coordinates|info')
  url.searchParams.set('exintro', '1')
  url.searchParams.set('explaintext', '1')
  url.searchParams.set('piprop', 'thumbnail|original')
  url.searchParams.set('pithumbsize', '900')
  url.searchParams.set('inprop', 'url')

  const response = await fetch(url, { headers: { 'User-Agent': 'TripPlanner/0.8 (travel-planning-app)' } })
  if (!response.ok) throw new Error(`Wikipedia search failed (${response.status})`)
  const payload = await response.json()
  const pages = Object.values(payload?.query?.pages || {})

  return pages
    .filter((page) => page.title && page.coordinates?.[0] && page.extract?.length > 40)
    .map((page) => {
      const category = categoryFor(`${page.title} ${page.extract}`)
      const coordinate = page.coordinates[0]
      return {
        id: `wikipedia-he-${page.pageid}`,
        name: page.title,
        nameHe: page.title,
        shortDesc: page.extract.slice(0, 420),
        longDesc: page.extract,
        lat: coordinate.lat,
        lon: coordinate.lon,
        imageUrl: page.thumbnail?.source || page.original?.source || '',
        categories: [category],
        visitDurationMin: durationFor(category),
        source: 'Wikipedia',
        sourceUrl: page.fullurl || `https://he.wikipedia.org/?curid=${page.pageid}`
      }
    })
    .slice(0, limit)
}

export const attractionCatalog = onRequest({ region: 'europe-west1', timeoutSeconds: 60, memory: '256MiB' }, async (req, res) => {
  setCors(req, res)
  if (req.method === 'OPTIONS') return res.status(204).send('')
  if (req.method !== 'GET') return send(res, 405, { error: 'method_not_allowed' })

  try {
    const token = req.get('authorization')?.replace(/^Bearer\s+/i, '')
    if (!token) return send(res, 401, { error: 'unauthorized' })
    await getAuth().verifyIdToken(token)

    const city = String(req.query.city || '').trim()
    const limit = Math.min(60, Math.max(10, Number(req.query.limit) || 40))
    if (city.length < 2 || city.length > 120) return send(res, 400, { error: 'invalid_city' })

    const key = cacheKey(city)
    const cacheRef = db.collection('attractionCatalogs').doc(key)
    const cached = await cacheRef.get()
    const cachedAt = cached.data()?.updatedAt?.toMillis?.() || 0
    if (cached.exists && Date.now() - cachedAt < CACHE_TTL_MS && cached.data()?.attractions?.length) {
      return send(res, 200, { ...cached.data(), cached: true, updatedAt: cached.data().updatedAt?.toDate?.().toISOString() })
    }

    const center = await geocodeCity(city)
    if (!center) return send(res, 404, { error: 'city_not_found' })
    const attractions = await fetchWikipediaAttractions(center, limit)
    const catalog = { query: city, city: center.name, center, attractions, source: 'OpenStreetMap + Wikipedia' }
    await cacheRef.set({ ...catalog, updatedAt: FieldValue.serverTimestamp() })
    return send(res, 200, { ...catalog, cached: false, updatedAt: new Date().toISOString() })
  } catch (error) {
    console.error('attractionCatalog failed', error)
    return send(res, 500, { error: 'catalog_failed', message: error?.message || 'Unknown error' })
  }
})
