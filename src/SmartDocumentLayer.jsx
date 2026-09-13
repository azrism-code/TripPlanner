import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { onAuthStateChanged } from 'firebase/auth'
import { collection, deleteDoc, doc, onSnapshot, serverTimestamp, setDoc } from 'firebase/firestore'
import { deleteObject, getDownloadURL, ref as storageRef, uploadBytes } from 'firebase/storage'
import { auth, db, storage } from './firebase.js'

const ANALYSIS_ENDPOINT = import.meta.env.VITE_DOCUMENT_ANALYSIS_ENDPOINT || 'https://analyzedocument-jshmqs3okq-ew.a.run.app'
const MAX_FILE_SIZE = 20 * 1024 * 1024

const safeFileName = (name) => (name || 'document')
  .replace(/[\\/:*?"<>|#%]/g, '-')
  .replace(/\s+/g, ' ')
  .trim()

const timestampValue = (value) => {
  if (!value) return 0
  if (typeof value.toMillis === 'function') return value.toMillis()
  if (typeof value.seconds === 'number') return value.seconds * 1000
  return 0
}

const mapsUrl = (query) => query
  ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`
  : ''

function processingLabel(status) {
  if (status === 'done') return 'פוענח'
  if (status === 'processing') return 'AI מנתח'
  if (status === 'error') return 'שגיאה בניתוח'
  return 'ממתין לניתוח'
}

function processingClass(status) {
  if (status === 'done') return 'done'
  if (status === 'processing') return 'processing'
  if (status === 'error') return 'error'
  return 'pending'
}

function typeFromCollection(collectionName) {
  if (collectionName === 'flights') return { label: 'טיסה', icon: '✈️', menu: 'טיסות' }
  if (collectionName === 'hotels') return { label: 'מלון', icon: '🏨', menu: 'מלונות' }
  if (collectionName === 'cars') return { label: 'השכרת רכב', icon: '🚗', menu: 'השכרת רכב' }
  if (collectionName === 'tickets') return { label: 'כרטיס / אטרקציה', icon: '🎟️', menu: 'מסמכים וכרטיסים' }
  return { label: 'מסמך', icon: '📄', menu: 'מסמכים וכרטיסים' }
}

function sourceForDocument(item, flights, hotels, cars, tickets) {
  const flight = flights.find((entry) =>
    entry.sourceDocumentId === item.id ||
    entry.documentId === item.id ||
    (Array.isArray(entry.sourceDocumentIds) && entry.sourceDocumentIds.includes(item.id)) ||
    (Array.isArray(entry.attachments) && entry.attachments.some((attachment) => attachment?.documentId === item.id))
  )
  if (flight) return { collection: 'flights', item: flight }

  const hotel = hotels.find((entry) => entry.sourceDocumentId === item.id || entry.documentId === item.id)
  if (hotel) return { collection: 'hotels', item: hotel }

  const car = cars.find((entry) => entry.sourceDocumentId === item.id || entry.documentId === item.id)
  if (car) return { collection: 'cars', item: car }

  const ticket = tickets.find((entry) => entry.sourceDocumentId === item.id || entry.documentId === item.id)
  if (ticket) return { collection: 'tickets', item: ticket }

  return null
}

function derivedDocument(item, flights, hotels, cars, tickets) {
  const source = sourceForDocument(item, flights, hotels, cars, tickets)
  const sourceCollection = item.linkedCollection && item.linkedCollection !== 'documents'
    ? item.linkedCollection
    : source?.collection || ''
  const type = typeFromCollection(sourceCollection)
  const record = source?.item || {}

  let title = item.summaryTitle || ''
  let city = item.summaryCity || ''
  let location = item.summaryLocation || ''
  let startDate = item.summaryStartDate || ''
  let endDate = item.summaryEndDate || ''
  let mapQuery = item.mapQuery || ''

  if (sourceCollection === 'flights') {
    title ||= [record.airline, record.flightNumber].filter(Boolean).join(' · ') || 'טיסה'
    city ||= [record.from, record.to].filter(Boolean).join(' → ')
    location ||= city
    startDate ||= record.departureDate || ''
    endDate ||= record.arrivalDate || ''
    mapQuery ||= record.from || ''
  } else if (sourceCollection === 'hotels') {
    title ||= record.name || 'מלון'
    city ||= record.city || ''
    location ||= record.address || record.city || ''
    startDate ||= record.checkIn || ''
    endDate ||= record.checkOut || ''
    mapQuery ||= record.address || record.city || ''
  } else if (sourceCollection === 'cars') {
    title ||= record.company || 'השכרת רכב'
    city ||= record.pickup || ''
    location ||= [record.pickup, record.dropoff].filter(Boolean).join(' → ')
    startDate ||= record.pickupDate || ''
    endDate ||= record.dropoffDate || ''
    mapQuery ||= record.pickup || ''
  } else if (sourceCollection === 'tickets') {
    title ||= record.title || 'כרטיס / אטרקציה'
    city ||= record.city || ''
    location ||= record.venue || record.city || ''
    startDate ||= record.date || ''
    endDate ||= record.date || ''
    mapQuery ||= record.venue || record.city || ''
  }

  if (!sourceCollection) {
    title ||= item.extractionSummary || item.name || 'מסמך'
    city ||= item.summaryCity || ''
    location ||= item.summaryLocation || ''
  }

  const inferredType = item.recognizedTypeLabel || (item.category && !['אחר', 'זיהוי אוטומטי'].includes(item.category) ? item.category : type.label)
  const inferredIcon = item.recognizedTypeIcon || type.icon

  return {
    ...item,
    sourceCollection,
    sourceRecord: record,
    typeLabel: inferredType,
    icon: inferredIcon,
    menu: type.menu,
    title,
    city,
    location,
    startDate,
    endDate,
    mapQuery
  }
}

function detailLines(documentItem) {
  const record = documentItem.sourceRecord || {}
  const lines = []
  if (record.bookingRef) lines.push(`מספר הזמנה: ${record.bookingRef}`)
  if (record.terminal) lines.push(`טרמינל: ${record.terminal}`)
  if (record.seat) lines.push(`מושב: ${record.seat}`)
  if (record.room) lines.push(`חדר: ${record.room}`)
  if (record.vehicle) lines.push(`רכב: ${record.vehicle}`)
  if (record.pickupTime) lines.push(`שעת איסוף: ${record.pickupTime}`)
  if (record.dropoffTime) lines.push(`שעת החזרה: ${record.dropoffTime}`)
  if (record.notes) lines.push(record.notes)
  return lines
}

function extractedCountsText(counts) {
  if (!counts) return ''
  return [
    counts.flights ? `${counts.flights} טיסות` : '',
    counts.hotels ? `${counts.hotels} מלונות` : '',
    counts.cars ? `${counts.cars} השכרות רכב` : '',
    counts.tickets ? `${counts.tickets} כרטיסים` : '',
    counts.expenses ? `${counts.expenses} הוצאות` : ''
  ].filter(Boolean).join(' · ')
}

function openLegacySection(label) {
  const buttons = [...document.querySelectorAll('aside.side-menu button')]
  const target = buttons.find((button) => button.textContent?.includes(label))
  if (target) target.click()
}

function DocumentCard({ item, readOnly, onDelete, onReanalyze, analyzing }) {
  const details = detailLines(item)
  const dates = item.startDate || item.endDate
    ? [item.startDate, item.endDate].filter(Boolean).join(' → ')
    : ''
  const counts = extractedCountsText(item.extractedCounts)
  const mapLink = mapsUrl(item.mapQuery)

  return (
    <article className="tp-doc-card">
      <div className="tp-doc-card-head">
        <div className="tp-doc-title">
          <span className="tp-doc-icon">{item.icon}</span>
          <div>
            <div className="tp-chip-row">
              <span className="tp-type-chip">{item.typeLabel}</span>
              <span className={`tp-status-chip ${processingClass(item.processingStatus)}`}>{processingLabel(item.processingStatus)}</span>
            </div>
            <h3>{item.title}</h3>
          </div>
        </div>
        {!readOnly && <button className="icon-danger" type="button" onClick={() => onDelete(item)} aria-label="מחיקת מסמך">🗑️</button>}
      </div>

      {dates && <p>📅 {dates}</p>}
      {item.city && <p>📍 {item.city}</p>}
      {item.location && item.location !== item.city && <p className="tp-secondary-line">{item.location}</p>}

      <div className="tp-card-actions">
        {mapLink && <a className="tp-map-button" href={mapLink} target="_blank" rel="noreferrer">🗺️ מפה</a>}
        {item.sourceCollection && item.menu !== 'מסמכים וכרטיסים' && (
          <button className="tp-section-button" type="button" onClick={() => openLegacySection(item.menu)}>פתיחה ב־{item.menu}</button>
        )}
      </div>

      <details className="tp-details-dropdown">
        <summary>פרטים ומסמך</summary>
        <div className="tp-details-body">
          {item.name && <p><strong>קובץ:</strong> {item.name}</p>}
          {item.extractionSummary && <p>{item.extractionSummary}</p>}
          {counts && <p><strong>זוהה:</strong> {counts}</p>}
          {details.map((line, index) => <p key={`${line}-${index}`}>{line}</p>)}
          {item.processingError && <p className="document-error">שגיאת פענוח: {item.processingError}</p>}
          <div className="tp-detail-actions">
            {item.downloadURL && <a className="attachment-link" href={item.downloadURL} target="_blank" rel="noreferrer">📎 צפייה במסמך המקורי</a>}
            {!readOnly && (
              <button className="reanalyze-button" type="button" onClick={() => onReanalyze(item)} disabled={analyzing}>
                {analyzing ? 'מנתח מחדש…' : '✨ ניתוח מחדש'}
              </button>
            )}
          </div>
        </div>
      </details>
    </article>
  )
}

function DocumentsHub({ user, trip, documents, flights, hotels, cars, tickets }) {
  const readOnly = !user || !trip || trip.ownerId !== user.uid
  const [selectedFiles, setSelectedFiles] = useState([])
  const [uploading, setUploading] = useState(false)
  const [uploadStatus, setUploadStatus] = useState('')
  const [error, setError] = useState('')
  const [analyzingId, setAnalyzingId] = useState('')
  const inputRef = useRef(null)

  const enrichedDocuments = useMemo(() => documents.map((item) => derivedDocument(item, flights, hotels, cars, tickets)), [documents, flights, hotels, cars, tickets])

  async function uploadSelected() {
    if (!user || !trip || readOnly || !selectedFiles.length || uploading) return
    setUploading(true)
    setError('')
    try {
      for (let index = 0; index < selectedFiles.length; index += 1) {
        const file = selectedFiles[index]
        if (file.size > MAX_FILE_SIZE) throw new Error(`${file.name}: גודל הקובץ מוגבל ל־20MB.`)
        setUploadStatus(`מעלה ${index + 1} מתוך ${selectedFiles.length}: ${file.name}`)
        const name = safeFileName(file.name)
        const unique = `${user.uid}-${Date.now()}-${index}-${Math.random().toString(36).slice(2, 9)}-${name}`
        const path = `trips/${trip.id}/documents/${unique}`
        const objectRef = storageRef(storage, path)
        await uploadBytes(objectRef, file, {
          contentType: file.type || 'application/octet-stream',
          customMetadata: { tripId: trip.id, uploadedBy: user.uid, linkedCollection: 'documents', linkedId: '' }
        })
        const downloadURL = await getDownloadURL(objectRef)
        const documentRef = doc(collection(db, 'trips', trip.id, 'documents'))
        await setDoc(documentRef, {
          name,
          category: 'זיהוי אוטומטי',
          autoClassify: true,
          storagePath: path,
          downloadURL,
          contentType: file.type || 'application/octet-stream',
          size: file.size,
          uploadedBy: user.uid,
          linkedCollection: 'documents',
          linkedId: '',
          processingStatus: 'pending',
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp()
        })
      }
      setSelectedFiles([])
      if (inputRef.current) inputRef.current.value = ''
      setUploadStatus('הקבצים הועלו. ה־AI מזהה את התוכן ומוסיף את הפרטים לטיול…')
    } catch (uploadError) {
      setError(uploadError?.message || 'לא הצלחנו להעלות את המסמכים.')
      setUploadStatus('')
    } finally {
      setUploading(false)
    }
  }

  async function removeDocument(item) {
    if (readOnly) return
    try {
      if (item.storagePath) await deleteObject(storageRef(storage, item.storagePath)).catch(() => null)
      await deleteDoc(doc(db, 'trips', trip.id, 'documents', item.id))
    } catch (deleteError) {
      setError(deleteError?.message || 'לא הצלחנו למחוק את המסמך.')
    }
  }

  async function reanalyze(item) {
    if (readOnly || analyzingId) return
    setAnalyzingId(item.id)
    setError('')
    try {
      const token = await user.getIdToken()
      const response = await fetch(ANALYSIS_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ tripId: trip.id, documentId: item.id, force: true })
      })
      const body = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(body?.error || 'הניתוח מחדש נכשל.')
    } catch (analysisError) {
      setError(analysisError?.message || 'לא הצלחנו לנתח את המסמך מחדש.')
    } finally {
      setAnalyzingId('')
    }
  }

  return (
    <section className="tp-smart-screen-layer">
      <section className="section-hero tp-doc-hero">
        <p className="eyebrow">מסמכים וכרטיסים</p>
        <h1>מעלים. ה־AI מסדר את השאר.</h1>
        <p>אפשר לבחור קובץ אחד או כמה קבצים יחד. אין צורך להגדיר מראש אם זה מלון, טיסה, רכב או כרטיס.</p>
      </section>

      {!readOnly && (
        <section className="panel tp-auto-upload">
          <div className="tp-upload-copy">
            <span>✨</span>
            <div>
              <h3>העלאה וניתוח אוטומטי</h3>
              <p>PDF או תמונות. ה־AI יזהה את סוג המסמך, יחלץ את הפרטים, ייצור את הכרטיס המתאים ויעדכן את המסלול.</p>
            </div>
          </div>
          <label className={`tp-multi-file-picker ${uploading ? 'busy' : ''}`}>
            {selectedFiles.length ? `${selectedFiles.length} קבצים נבחרו` : 'בחירת קובץ אחד או יותר'}
            <input
              ref={inputRef}
              type="file"
              accept=".pdf,image/*"
              multiple
              disabled={uploading}
              onChange={(event) => setSelectedFiles([...event.target.files])}
            />
          </label>
          {selectedFiles.length > 0 && (
            <div className="tp-selected-files">
              {selectedFiles.map((file) => <span key={`${file.name}-${file.size}`}>{file.name}</span>)}
            </div>
          )}
          <button className="primary-button" type="button" onClick={uploadSelected} disabled={!selectedFiles.length || uploading}>
            {uploading ? 'מעלה…' : 'העלה ונתח עם AI'}
          </button>
          {uploadStatus && <div className="smart-import-status" role="status">{uploadStatus}</div>}
        </section>
      )}

      {error && <div className="error-box">{error}</div>}

      <section className="tp-documents-summary">
        <div className="tp-documents-summary-head">
          <div>
            <p className="eyebrow">המסמכים בטיול</p>
            <h2>{enrichedDocuments.length ? `${enrichedDocuments.length} מסמכים` : 'עדיין אין מסמכים'}</h2>
          </div>
          <small>הפרטים המלאים והקובץ המקורי נמצאים בתוך ה־Dropdown בכל כרטיס.</small>
        </div>

        <div className="tp-doc-grid">
          {enrichedDocuments.length ? enrichedDocuments.map((item) => (
            <DocumentCard
              key={item.id}
              item={item}
              readOnly={readOnly}
              onDelete={removeDocument}
              onReanalyze={reanalyze}
              analyzing={analyzingId === item.id}
            />
          )) : (
            <div className="empty-state record-empty">
              <div className="empty-icon">📎</div>
              <h3>אין עדיין מסמכים</h3>
              <p>בחרו קובץ אחד או כמה קבצים וה־AI יתחיל לבנות את פרטי הטיול.</p>
            </div>
          )}
        </div>
      </section>
    </section>
  )
}

function normalizeLocationText(text) {
  return (text || '').replace(/^📍\s*/, '').trim()
}

function addOrUpdateMapAction(container, query) {
  if (!container || !query) return
  let link = container.querySelector(':scope > .tp-inline-map')
  if (!link) {
    link = document.createElement('a')
    link.className = 'tp-inline-map'
    link.target = '_blank'
    link.rel = 'noreferrer'
    link.textContent = '🗺️ מפה'
    container.appendChild(link)
  }
  const nextHref = mapsUrl(query)
  if (link.href !== nextHref) link.href = nextHref
}

function addOrUpdateDetailsButton(container, label) {
  if (!container || !label || container.querySelector(':scope > .tp-itinerary-details-link')) return
  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'tp-itinerary-details-link'
  button.textContent = 'פרטים ›'
  button.addEventListener('click', () => openLegacySection(label))
  container.appendChild(button)
}

function enhanceItineraryCards() {
  const typeMap = {
    flight: { text: 'טיסה', menu: 'טיסות' },
    'טיסה': { text: 'טיסה', menu: 'טיסות' },
    'airport-arrival': { text: 'שדה תעופה', menu: 'טיסות' },
    'שדה תעופה': { text: 'שדה תעופה', menu: 'טיסות' },
    hotel: { text: 'מלון', menu: 'מלונות' },
    'מלון': { text: 'מלון', menu: 'מלונות' },
    'hotel-checkout': { text: 'מלון', menu: 'מלונות' },
    car: { text: 'השכרת רכב', menu: 'השכרת רכב' },
    'השכרת רכב': { text: 'השכרת רכב', menu: 'השכרת רכב' },
    'car-return': { text: 'השכרת רכב', menu: 'השכרת רכב' },
    ticket: { text: 'כרטיס / אטרקציה', menu: 'מסמכים וכרטיסים' },
    'כרטיס / אטרקציה': { text: 'כרטיס / אטרקציה', menu: 'מסמכים וכרטיסים' }
  }

  document.querySelectorAll('.timeline-item').forEach((row) => {
    const typeNode = row.querySelector('.timeline-type')
    const rawType = (typeNode?.textContent || '').trim().toLowerCase()
    const config = typeMap[rawType]
    if (config && typeNode && typeNode.textContent !== config.text) typeNode.textContent = config.text
    const card = row.querySelector('.timeline-card')
    if (!card) return
    card.querySelectorAll('.record-notes').forEach((node) => node.classList.add('tp-itinerary-extra'))
    const locationNode = [...card.querySelectorAll('p')].find((node) => node.textContent?.trim().startsWith('📍'))
    if (locationNode) {
      let query = normalizeLocationText(locationNode.textContent)
      if (query.includes('→')) query = query.split('→')[0].trim()
      addOrUpdateMapAction(card, query)
    }
    if (config && !['flight', 'טיסה'].includes(rawType)) addOrUpdateDetailsButton(card, config.menu)
  })
}

function enhanceLegacySummaryCards() {
  const title = document.querySelector('main.dashboard .section-hero h1')?.textContent?.trim() || ''
  const kind = title === 'מלונות' ? 'hotel' : title === 'השכרת רכב' ? 'car' : title === 'טיסות' ? 'flight' : ''
  if (!kind) return

  const labels = { hotel: 'מלון', car: 'השכרת רכב', flight: 'טיסה' }
  document.querySelectorAll('main.dashboard .record-grid .record-card').forEach((card) => {
    if (card.classList.contains('document-card')) return
    card.classList.add('tp-summary-card')

    let meta = card.querySelector(':scope > .tp-summary-meta')
    if (!meta) {
      meta = document.createElement('div')
      meta.className = 'tp-summary-meta'
      const head = card.querySelector(':scope > .record-head')
      if (head) head.after(meta)
      else card.prepend(meta)
    }
    const hasAttachment = Boolean(card.querySelector(':scope > .attachment-link'))
    const metaHtml = `<span class="tp-type-chip">${labels[kind]}</span>${hasAttachment ? '<span class="tp-status-chip done">מסמך מצורף</span>' : ''}`
    if (meta.innerHTML !== metaHtml) meta.innerHTML = metaHtml

    const paragraphs = [...card.querySelectorAll(':scope > p')]
    const detailNodes = paragraphs.filter((node) => {
      const text = node.textContent || ''
      if (node.classList.contains('record-notes')) return true
      if (kind === 'hotel') return text.includes('כתובת:') || text.includes('חדר:') || text.includes('הזמנה:')
      if (kind === 'car') return text.includes('רכב:') || text.includes('הזמנה:')
      return text.includes('טרמינל:') || text.includes('מושב:') || text.includes('הזמנה:')
    })
    detailNodes.forEach((node) => node.classList.add('tp-extra-field'))

    const attachment = card.querySelector(':scope > .attachment-link')
    if (attachment) attachment.classList.add('tp-extra-field')

    let details = card.querySelector(':scope > .tp-inline-details')
    if (!details && (detailNodes.length || attachment)) {
      details = document.createElement('details')
      details.className = 'tp-inline-details'
      details.innerHTML = '<summary>פרטים ומסמך</summary><div class="tp-inline-details-body"></div>'
      card.appendChild(details)
    }
    if (details) {
      const body = details.querySelector('.tp-inline-details-body')
      const detailText = detailNodes.map((node) => node.textContent?.trim()).filter(Boolean)
      const key = `${detailText.join('|')}|${attachment?.href || ''}`
      if (body?.dataset.key !== key) {
        body.dataset.key = key
        body.replaceChildren()
        detailText.forEach((text) => {
          const p = document.createElement('p')
          p.textContent = text
          body.appendChild(p)
        })
        if (attachment?.href) {
          const link = document.createElement('a')
          link.className = 'attachment-link'
          link.href = attachment.href
          link.target = '_blank'
          link.rel = 'noreferrer'
          link.textContent = '📎 צפייה במסמך המקורי'
          body.appendChild(link)
        }
      }
    }

    let mapQuery = ''
    if (kind === 'hotel') {
      const address = paragraphs.find((node) => node.textContent?.includes('כתובת:'))?.textContent || ''
      const city = paragraphs.find((node) => node.textContent?.trim().startsWith('📍'))?.textContent || ''
      mapQuery = address.split('כתובת:')[1]?.trim() || normalizeLocationText(city)
    } else if (kind === 'car') {
      const route = paragraphs.find((node) => node.textContent?.trim().startsWith('📍'))?.textContent || ''
      mapQuery = normalizeLocationText(route).split('→')[0]?.trim() || ''
    } else {
      const route = card.querySelector('.flight-route')
      mapQuery = route?.querySelector('strong')?.textContent?.trim() || ''
    }
    addOrUpdateMapAction(card, mapQuery)
  })
}

function setVisibleVersion() {
  document.querySelectorAll('.app-title small, .auth-card h1 small').forEach((node) => {
    if (node.textContent !== 'v0.8.0') node.textContent = 'v0.8.0'
  })
}

export default function SmartDocumentLayer() {
  const [user, setUser] = useState(auth.currentUser)
  const [tripId, setTripId] = useState('')
  const [trip, setTrip] = useState(null)
  const [documents, setDocuments] = useState([])
  const [flights, setFlights] = useState([])
  const [hotels, setHotels] = useState([])
  const [cars, setCars] = useState([])
  const [tickets, setTickets] = useState([])
  const [documentsScreen, setDocumentsScreen] = useState(false)
  const [dashboard, setDashboard] = useState(null)

  useEffect(() => onAuthStateChanged(auth, (nextUser) => setUser(nextUser)), [])

  useEffect(() => {
    if (!user) {
      setTripId('')
      return undefined
    }
    return onSnapshot(doc(db, 'users', user.uid), (snapshot) => {
      setTripId(snapshot.data()?.lastTripId || '')
    })
  }, [user])

  useEffect(() => {
    if (!tripId) {
      setTrip(null)
      setDocuments([])
      setFlights([])
      setHotels([])
      setCars([])
      setTickets([])
      return undefined
    }

    const tripRef = doc(db, 'trips', tripId)
    const subscriptions = [
      onSnapshot(tripRef, (snapshot) => setTrip(snapshot.exists() ? { id: snapshot.id, ...snapshot.data() } : null)),
      onSnapshot(collection(tripRef, 'documents'), (snapshot) => setDocuments(snapshot.docs.map((item) => ({ id: item.id, ...item.data() })).sort((a, b) => timestampValue(b.createdAt) - timestampValue(a.createdAt)))),
      onSnapshot(collection(tripRef, 'flights'), (snapshot) => setFlights(snapshot.docs.map((item) => ({ id: item.id, ...item.data() })))),
      onSnapshot(collection(tripRef, 'hotels'), (snapshot) => setHotels(snapshot.docs.map((item) => ({ id: item.id, ...item.data() })))),
      onSnapshot(collection(tripRef, 'cars'), (snapshot) => setCars(snapshot.docs.map((item) => ({ id: item.id, ...item.data() })))),
      onSnapshot(collection(tripRef, 'tickets'), (snapshot) => setTickets(snapshot.docs.map((item) => ({ id: item.id, ...item.data() }))))
    ]
    return () => subscriptions.forEach((unsubscribe) => unsubscribe())
  }, [tripId])

  useEffect(() => {
    const inspect = () => {
      const nextDashboard = document.querySelector('main.dashboard')
      if (nextDashboard !== dashboard) setDashboard(nextDashboard)
      const title = nextDashboard?.querySelector('.section-hero h1')?.textContent?.trim() || ''
      const isDocuments = title === 'כרטיסים, הזמנות ותוכניות'
      setDocumentsScreen((current) => current === isDocuments ? current : isDocuments)
      if (nextDashboard) nextDashboard.classList.toggle('tp-smart-documents', isDocuments)
      setVisibleVersion()
      enhanceLegacySummaryCards()
      enhanceItineraryCards()
    }

    inspect()
    const timer = window.setInterval(inspect, 500)
    return () => {
      window.clearInterval(timer)
      document.querySelector('main.dashboard')?.classList.remove('tp-smart-documents')
    }
  }, [dashboard])

  if (!documentsScreen || !dashboard || !trip) return null
  return createPortal(
    <DocumentsHub
      user={user}
      trip={trip}
      documents={documents}
      flights={flights}
      hotels={hotels}
      cars={cars}
      tickets={tickets}
    />,
    dashboard
  )
}
