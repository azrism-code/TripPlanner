import { useEffect, useMemo, useState } from 'react'
import {
  createUserWithEmailAndPassword,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signInWithPopup,
  signInWithRedirect,
  signOut
} from 'firebase/auth'
import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  onSnapshot,
  query,
  serverTimestamp,
  setDoc,
  where
} from 'firebase/firestore'
import {
  deleteObject,
  getDownloadURL,
  listAll,
  ref as storageRef,
  uploadBytes
} from 'firebase/storage'
import { auth, db, googleProvider, storage } from './firebase.js'

const APP_VERSION = 'v0.6.3'
const MODULE_COLLECTIONS = [
  'takeItems',
  'hotels',
  'cars',
  'flights',
  'expenses',
  'documents',
  'chatMessages',
  'itineraryDays'
]
const CURRENCIES = ['ILS', 'USD', 'EUR', 'JPY', 'GBP']
const DOCUMENT_CATEGORIES = ['טיסה', 'מלון', 'כרטיס / אטרקציה', 'השכרת רכב', 'תוכנית / מסלול', 'ביטוח', 'אחר']
const AI_ENDPOINT = import.meta.env.VITE_TRIP_AI_ENDPOINT || 'https://tripchat-jshmqs3okq-ew.a.run.app'
const DOCUMENT_ANALYSIS_ENDPOINT = import.meta.env.VITE_DOCUMENT_ANALYSIS_ENDPOINT || 'https://analyzedocument-jshmqs3okq-ew.a.run.app'

function normalizeEmail(value) {
  return (value || '').trim().toLowerCase()
}

function timestampValue(value) {
  if (!value) return 0
  if (typeof value.toMillis === 'function') return value.toMillis()
  if (typeof value.seconds === 'number') return value.seconds * 1000
  return 0
}

function formatMoney(value, currency = 'ILS') {
  const numeric = Number(value) || 0
  try {
    return new Intl.NumberFormat('he-IL', {
      style: 'currency',
      currency,
      maximumFractionDigits: currency === 'JPY' ? 0 : 2
    }).format(numeric)
  } catch {
    return `${numeric.toLocaleString('he-IL')} ${currency}`
  }
}

function formatBytes(bytes) {
  const value = Number(bytes) || 0
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
  return `${(value / (1024 * 1024)).toFixed(1)} MB`
}

function safeFileName(name) {
  return (name || 'document')
    .replace(/[\\/:*?"<>|#%]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
}

function buildTripDays(startDate, endDate) {
  if (!startDate || !endDate || endDate < startDate) return []
  const start = new Date(`${startDate}T12:00:00`)
  const end = new Date(`${endDate}T12:00:00`)
  const days = []
  const cursor = new Date(start)
  let index = 1
  while (cursor <= end && index <= 90) {
    const date = cursor.toISOString().slice(0, 10)
    days.push({
      index,
      date,
      weekday: new Intl.DateTimeFormat('he-IL', { weekday: 'short' }).format(cursor),
      displayDate: new Intl.DateTimeFormat('he-IL', { day: '2-digit', month: '2-digit' }).format(cursor)
    })
    cursor.setDate(cursor.getDate() + 1)
    index += 1
  }
  return days
}

function authErrorMessage(error) {
  switch (error?.code) {
    case 'auth/operation-not-allowed':
      return 'התחברות באמצעות אימייל וסיסמה עדיין אינה פעילה.'
    case 'auth/email-already-in-use':
      return 'כבר קיים חשבון עם כתובת האימייל הזאת. נסו להתחבר במקום להירשם.'
    case 'auth/invalid-credential':
      return 'האימייל או הסיסמה אינם נכונים.'
    case 'auth/weak-password':
      return 'יש לבחור סיסמה באורך 6 תווים לפחות.'
    default:
      return error?.message || 'ההתחברות נכשלה.'
  }
}

async function ensureUserProfile(user) {
  const profileRef = doc(db, 'users', user.uid)
  const snapshot = await getDoc(profileRef)
  const common = {
    displayName: user.displayName || '',
    email: normalizeEmail(user.email),
    photoURL: user.photoURL || '',
    lastLoginAt: serverTimestamp()
  }
  if (!snapshot.exists()) {
    await setDoc(profileRef, { ...common, role: 'user', createdAt: serverTimestamp() })
  } else {
    await setDoc(profileRef, common, { merge: true })
  }
}

function LoginScreen() {
  const [mode, setMode] = useState('login')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function googleSignIn() {
    setBusy(true)
    setError('')
    try {
      await signInWithPopup(auth, googleProvider)
    } catch (err) {
      if (err?.code === 'auth/popup-blocked' || err?.code === 'auth/cancelled-popup-request') {
        await signInWithRedirect(auth, googleProvider)
        return
      }
      setError(err?.message || 'ההתחברות עם Google נכשלה.')
      setBusy(false)
    }
  }

  async function emailSignIn(event) {
    event.preventDefault()
    setBusy(true)
    setError('')
    try {
      if (mode === 'register') await createUserWithEmailAndPassword(auth, email.trim(), password)
      else await signInWithEmailAndPassword(auth, email.trim(), password)
    } catch (err) {
      setError(authErrorMessage(err))
      setBusy(false)
    }
  }

  return (
    <main className="auth-page">
      <section className="auth-card">
        <div className="brand-mark">TP</div>
        <h1>TripPlanner <small>{APP_VERSION}</small></h1>
        <p className="muted">כל הטיול שלכם במקום אחד — מסלול, הזמנות, מסמכים ועזרה חכמה.</p>
        <button className="google-button" onClick={googleSignIn} disabled={busy}>
          <span className="google-g">G</span> המשך עם Google
        </button>
        <div className="divider"><span>או</span></div>
        <form onSubmit={emailSignIn} className="auth-form">
          <label>אימייל<input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" required /></label>
          <label>סיסמה<input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete={mode === 'register' ? 'new-password' : 'current-password'} minLength={6} required /></label>
          {error && <div className="error-box">{error}</div>}
          <button className="primary-button" type="submit" disabled={busy}>{busy ? 'רק רגע…' : mode === 'register' ? 'יצירת חשבון' : 'כניסה'}</button>
        </form>
        <button className="link-button" onClick={() => setMode(mode === 'login' ? 'register' : 'login')} disabled={busy}>
          {mode === 'login' ? 'חדשים ב־TripPlanner? יצירת חשבון' : 'כבר יש לכם חשבון? כניסה'}
        </button>
      </section>
    </main>
  )
}

function TripCard({ trip, currentUserId, onOpen }) {
  const dates = [trip.startDate, trip.endDate].filter(Boolean).join(' → ')
  const readOnly = trip.ownerId !== currentUserId
  return (
    <button className="trip-card" type="button" onClick={() => onOpen(trip)}>
      <div className="trip-cover">✈️</div>
      <div className="trip-content">
        <div className="trip-title-row">
          <h3>{trip.title}</h3>
          {readOnly && <span className="shared-badge">שותף איתי</span>}
        </div>
        {trip.destination && <p>{trip.destination}</p>}
        {dates && <p className="trip-dates">{dates}</p>}
        <span className="open-trip">פתיחת הטיול ←</span>
      </div>
    </button>
  )
}

function SectionHeader({ eyebrow, title, subtitle }) {
  return (
    <section className="section-hero">
      <p className="eyebrow">{eyebrow}</p>
      <h1>{title}</h1>
      {subtitle && <p>{subtitle}</p>}
    </section>
  )
}

function AttachmentLink({ item }) {
  if (!item?.attachmentUrl) return null
  return (
    <a className="attachment-link" href={item.attachmentUrl} target="_blank" rel="noreferrer">
      📎 {item.attachmentName || 'פתיחת האישור'}
    </a>
  )
}

function TripPlanner({ user, profile }) {
  const [ownedTrips, setOwnedTrips] = useState([])
  const [sharedTrips, setSharedTrips] = useState([])
  const [ownedReady, setOwnedReady] = useState(false)
  const [sharedReady, setSharedReady] = useState(false)
  const [activeTripId, setActiveTripId] = useState(null)
  const [initialTripResolved, setInitialTripResolved] = useState(false)
  const [screen, setScreen] = useState('itinerary')
  const [menuOpen, setMenuOpen] = useState(false)
  const [shareOpen, setShareOpen] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [activeDayDate, setActiveDayDate] = useState('')

  const [title, setTitle] = useState('')
  const [destination, setDestination] = useState('')
  const [startDate, setStartDate] = useState('')
  const [endDate, setEndDate] = useState('')
  const [creating, setCreating] = useState(false)

  const [shareEmail, setShareEmail] = useState('')
  const [sharing, setSharing] = useState(false)
  const [deletingTrip, setDeletingTrip] = useState(false)

  const [takeItems, setTakeItems] = useState([])
  const [hotels, setHotels] = useState([])
  const [cars, setCars] = useState([])
  const [flights, setFlights] = useState([])
  const [expenses, setExpenses] = useState([])
  const [documents, setDocuments] = useState([])
  const [chatMessages, setChatMessages] = useState([])
  const [itineraryDays, setItineraryDays] = useState([])

  const [takeText, setTakeText] = useState('')
  const [hotelForm, setHotelForm] = useState({ name: '', city: '', checkIn: '', checkOut: '', bookingRef: '', notes: '' })
  const [carForm, setCarForm] = useState({ company: '', pickup: '', dropoff: '', pickupDate: '', dropoffDate: '', bookingRef: '', notes: '' })
  const [flightForm, setFlightForm] = useState({
    airline: '', flightNumber: '', from: '', to: '', departureDate: '', departureTime: '',
    arrivalDate: '', arrivalTime: '', bookingRef: '', notes: ''
  })
  const [hotelFile, setHotelFile] = useState(null)
  const [carFile, setCarFile] = useState(null)
  const [flightFile, setFlightFile] = useState(null)

  const [expenseForm, setExpenseForm] = useState({ description: '', category: 'כללי', amount: '' })
  const [budgetLimit, setBudgetLimit] = useState('')
  const [budgetCurrency, setBudgetCurrency] = useState('ILS')
  const [savingBudget, setSavingBudget] = useState(false)

  const [documentFile, setDocumentFile] = useState(null)
  const [documentCategory, setDocumentCategory] = useState('אחר')
  const [uploadingDocument, setUploadingDocument] = useState(false)
  const [analyzingDocumentId, setAnalyzingDocumentId] = useState('')
  const [smartImportFiles, setSmartImportFiles] = useState({ flights: null, hotels: null, cars: null })
  const [smartImportStatus, setSmartImportStatus] = useState({})
  const [bookingBusy, setBookingBusy] = useState(false)

  const [chatInput, setChatInput] = useState('')
  const [chatBusy, setChatBusy] = useState(false)
  const [chatError, setChatError] = useState('')

  const [online, setOnline] = useState(navigator.onLine)
  const [error, setError] = useState('')
  const [shareError, setShareError] = useState('')
  const [moduleError, setModuleError] = useState('')

  const userEmail = normalizeEmail(user.email)

  useEffect(() => {
    const onlineHandler = () => setOnline(true)
    const offlineHandler = () => setOnline(false)
    window.addEventListener('online', onlineHandler)
    window.addEventListener('offline', offlineHandler)
    return () => {
      window.removeEventListener('online', onlineHandler)
      window.removeEventListener('offline', offlineHandler)
    }
  }, [])

  useEffect(() => {
    const ownedQuery = query(collection(db, 'trips'), where('ownerId', '==', user.uid))
    return onSnapshot(ownedQuery, (snapshot) => {
      setOwnedTrips(snapshot.docs.map((item) => ({ id: item.id, ...item.data() })))
      setOwnedReady(true)
    }, (err) => {
      setError(err?.message || 'לא הצלחנו לטעון את הטיולים.')
      setOwnedReady(true)
    })
  }, [user.uid])

  useEffect(() => {
    if (!userEmail) {
      setSharedTrips([])
      setSharedReady(true)
      return undefined
    }
    const sharedQuery = query(collection(db, 'trips'), where('sharedWithEmails', 'array-contains', userEmail))
    return onSnapshot(sharedQuery, (snapshot) => {
      setSharedTrips(snapshot.docs.map((item) => ({ id: item.id, ...item.data() })))
      setSharedReady(true)
    }, (err) => {
      setError(err?.message || 'לא הצלחנו לטעון טיולים ששותפו איתך.')
      setSharedReady(true)
    })
  }, [userEmail])

  const trips = useMemo(() => {
    const merged = new Map()
    ownedTrips.forEach((trip) => merged.set(trip.id, trip))
    sharedTrips.forEach((trip) => {
      if (!merged.has(trip.id)) merged.set(trip.id, trip)
    })
    return [...merged.values()].sort((a, b) => timestampValue(b.updatedAt) - timestampValue(a.updatedAt))
  }, [ownedTrips, sharedTrips])

  const activeTrip = useMemo(() => trips.find((trip) => trip.id === activeTripId) || null, [trips, activeTripId])
  const activeTripIsReadOnly = Boolean(activeTrip && activeTrip.ownerId !== user.uid)
  const activeTripShares = activeTrip && Array.isArray(activeTrip.sharedWithEmails)
    ? activeTrip.sharedWithEmails.map(normalizeEmail).filter(Boolean)
    : []
  const tripDays = useMemo(() => buildTripDays(activeTrip?.startDate, activeTrip?.endDate), [activeTrip?.startDate, activeTrip?.endDate])
  const itineraryByDate = useMemo(() => {
    const map = new Map()
    itineraryDays.forEach((day) => map.set(day.date || day.id, day))
    return map
  }, [itineraryDays])
  const activeDay = tripDays.find((day) => day.date === activeDayDate) || tripDays[0] || null
  const activeDayPlan = activeDay ? itineraryByDate.get(activeDay.date) : null

  useEffect(() => {
    if (!ownedReady || !sharedReady || initialTripResolved) return
    if (!trips.length) {
      setScreen('new')
      setInitialTripResolved(true)
      return
    }
    const rememberedTrip = trips.find((trip) => trip.id === profile?.lastTripId)
    const tripToOpen = rememberedTrip || trips[0]
    setActiveTripId(tripToOpen.id)
    setScreen('itinerary')
    setInitialTripResolved(true)
  }, [ownedReady, sharedReady, initialTripResolved, trips, profile?.lastTripId])

  useEffect(() => {
    if (!initialTripResolved || !ownedReady || !sharedReady) return
    if (activeTripId && trips.some((trip) => trip.id === activeTripId)) return
    if (trips.length) {
      setActiveTripId(trips[0].id)
      setScreen('itinerary')
    } else {
      setActiveTripId(null)
      setScreen('new')
    }
  }, [trips, activeTripId, initialTripResolved, ownedReady, sharedReady])

  useEffect(() => {
    if (!tripDays.length) {
      setActiveDayDate('')
      return
    }
    if (!tripDays.some((day) => day.date === activeDayDate)) setActiveDayDate(tripDays[0].date)
  }, [activeTripId, activeTrip?.startDate, activeTrip?.endDate, tripDays, activeDayDate])

  useEffect(() => {
    if (!activeTripId) {
      setTakeItems([])
      setHotels([])
      setCars([])
      setFlights([])
      setExpenses([])
      setDocuments([])
      setChatMessages([])
      setItineraryDays([])
      return undefined
    }

    setModuleError('')
    const tripRef = doc(db, 'trips', activeTripId)
    const subscribe = (name, setter, sorter, fallback) => onSnapshot(collection(tripRef, name), (snapshot) => {
      const rows = snapshot.docs.map((item) => ({ id: item.id, ...item.data() }))
      if (sorter) rows.sort(sorter)
      setter(rows)
    }, (err) => setModuleError(err?.message || fallback))

    const unsubs = [
      subscribe('takeItems', setTakeItems, (a, b) => timestampValue(a.createdAt) - timestampValue(b.createdAt), 'לא הצלחנו לטעון את רשימת לקחת.'),
      subscribe('hotels', setHotels, (a, b) => (a.checkIn || '').localeCompare(b.checkIn || ''), 'לא הצלחנו לטעון מלונות.'),
      subscribe('cars', setCars, (a, b) => (a.pickupDate || '').localeCompare(b.pickupDate || ''), 'לא הצלחנו לטעון השכרות רכב.'),
      subscribe('flights', setFlights, (a, b) => `${a.departureDate || ''}${a.departureTime || ''}`.localeCompare(`${b.departureDate || ''}${b.departureTime || ''}`), 'לא הצלחנו לטעון טיסות.'),
      subscribe('expenses', setExpenses, (a, b) => timestampValue(b.createdAt) - timestampValue(a.createdAt), 'לא הצלחנו לטעון הוצאות.'),
      subscribe('documents', setDocuments, (a, b) => timestampValue(b.createdAt) - timestampValue(a.createdAt), 'לא הצלחנו לטעון מסמכים.'),
      subscribe('itineraryDays', setItineraryDays, (a, b) => (a.date || a.id).localeCompare(b.date || b.id), 'לא הצלחנו לטעון את המסלול.')
    ]

    if (!activeTripIsReadOnly) {
      unsubs.push(subscribe('chatMessages', setChatMessages, (a, b) => timestampValue(a.createdAt) - timestampValue(b.createdAt), 'לא הצלחנו לטעון את השיחה.'))
    } else {
      setChatMessages([])
    }

    return () => unsubs.forEach((unsubscribe) => unsubscribe())
  }, [activeTripId, activeTripIsReadOnly])

  useEffect(() => {
    if (!activeTrip) return
    setBudgetLimit(activeTrip.budgetLimit ? String(activeTrip.budgetLimit) : '')
    setBudgetCurrency(activeTrip.budgetCurrency || 'ILS')
  }, [activeTrip?.id, activeTrip?.budgetLimit, activeTrip?.budgetCurrency])

  async function rememberTrip(tripId) {
    try {
      await setDoc(doc(db, 'users', user.uid), { lastTripId: tripId, lastTripViewedAt: serverTimestamp() }, { merge: true })
    } catch (err) {
      console.error('Could not remember last trip', err)
    }
  }

  function openTrip(trip) {
    setActiveTripId(trip.id)
    setScreen('itinerary')
    setMenuOpen(false)
    setShareOpen(false)
    setDeleteOpen(false)
    setError('')
    rememberTrip(trip.id)
  }

  function openSection(nextScreen) {
    if (!activeTrip) return
    if (nextScreen === 'chat' && activeTripIsReadOnly) return
    setScreen(nextScreen)
    setMenuOpen(false)
    setShareOpen(false)
    setDeleteOpen(false)
    setModuleError('')
    rememberTrip(activeTrip.id)
  }

  function openDay(day) {
    setActiveDayDate(day.date)
    setScreen('itinerary')
    setMenuOpen(false)
    rememberTrip(activeTrip.id)
  }

  async function createTrip(event) {
    event.preventDefault()
    if (!title.trim()) return
    if (startDate && endDate && endDate < startDate) {
      setError('תאריך הסיום לא יכול להיות לפני תאריך ההתחלה.')
      return
    }
    setCreating(true)
    setError('')
    try {
      const tripRef = await addDoc(collection(db, 'trips'), {
        ownerId: user.uid,
        title: title.trim(),
        destination: destination.trim(),
        startDate,
        endDate,
        sharedWithEmails: [],
        budgetLimit: 0,
        budgetCurrency: 'ILS',
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp()
      })
      await rememberTrip(tripRef.id)
      setActiveTripId(tripRef.id)
      setScreen('itinerary')
      setTitle('')
      setDestination('')
      setStartDate('')
      setEndDate('')
    } catch (err) {
      setError(err?.message || 'לא הצלחנו ליצור את הטיול.')
    } finally {
      setCreating(false)
    }
  }

  function handleStartDateChange(value) {
    setStartDate(value)
    if (endDate && value && endDate < value) setEndDate('')
  }

  function showTrips() {
    setScreen('trips')
    setShareOpen(false)
    setDeleteOpen(false)
    setMenuOpen(false)
    setError('')
  }

  function showNewTrip() {
    setScreen('new')
    setShareOpen(false)
    setDeleteOpen(false)
    setMenuOpen(false)
    setError('')
  }

  function showShare() {
    if (!activeTrip || activeTripIsReadOnly) return
    setShareOpen(true)
    setMenuOpen(false)
    setShareError('')
  }

  async function addShare(event) {
    event.preventDefault()
    if (!activeTrip || activeTripIsReadOnly) return
    const emailToAdd = normalizeEmail(shareEmail)
    if (!emailToAdd) return
    if (emailToAdd === userEmail) {
      setShareError('אין צורך לשתף את הטיול עם עצמך.')
      return
    }
    if (activeTripShares.includes(emailToAdd)) {
      setShareError('המשתמש הזה כבר מקבל גישה לטיול.')
      return
    }
    setSharing(true)
    setShareError('')
    try {
      await setDoc(doc(db, 'trips', activeTrip.id), {
        sharedWithEmails: [...activeTripShares, emailToAdd],
        updatedAt: serverTimestamp()
      }, { merge: true })
      setShareEmail('')
    } catch (err) {
      setShareError(err?.message || 'לא הצלחנו לשתף את הטיול.')
    } finally {
      setSharing(false)
    }
  }

  async function removeShare(emailToRemove) {
    if (!activeTrip || activeTripIsReadOnly) return
    setSharing(true)
    try {
      await setDoc(doc(db, 'trips', activeTrip.id), {
        sharedWithEmails: activeTripShares.filter((email) => email !== emailToRemove),
        updatedAt: serverTimestamp()
      }, { merge: true })
    } catch (err) {
      setShareError(err?.message || 'לא הצלחנו להסיר את השיתוף.')
    } finally {
      setSharing(false)
    }
  }

  async function deleteCurrentTrip() {
    if (!activeTrip || activeTripIsReadOnly) return
    setDeletingTrip(true)
    setModuleError('')
    try {
      const folder = storageRef(storage, `trips/${activeTrip.id}/documents`)
      const listed = await listAll(folder).catch(() => ({ items: [] }))
      await Promise.all(listed.items.map((item) => deleteObject(item).catch(() => null)))
      for (const subcollectionName of MODULE_COLLECTIONS) {
        const snapshot = await getDocs(collection(db, 'trips', activeTrip.id, subcollectionName))
        await Promise.all(snapshot.docs.map((item) => deleteDoc(item.ref)))
      }
      await deleteDoc(doc(db, 'trips', activeTrip.id))
      await setDoc(doc(db, 'users', user.uid), { lastTripId: null, lastTripViewedAt: serverTimestamp() }, { merge: true })
      setDeleteOpen(false)
      setActiveTripId(null)
      setScreen('trips')
    } catch (err) {
      setModuleError(err?.message || 'לא הצלחנו למחוק את הטיול.')
      setDeleteOpen(false)
    } finally {
      setDeletingTrip(false)
    }
  }

  async function addTakeItem(event) {
    event.preventDefault()
    if (!activeTrip || activeTripIsReadOnly || !takeText.trim()) return
    try {
      await addDoc(collection(db, 'trips', activeTrip.id, 'takeItems'), {
        text: takeText.trim(), done: false, createdAt: serverTimestamp(), updatedAt: serverTimestamp()
      })
      setTakeText('')
    } catch (err) {
      setModuleError(err?.message || 'לא הצלחנו להוסיף פריט.')
    }
  }

  async function toggleTakeItem(item) {
    if (!activeTrip || activeTripIsReadOnly) return
    await setDoc(doc(db, 'trips', activeTrip.id, 'takeItems', item.id), { done: !item.done, updatedAt: serverTimestamp() }, { merge: true })
  }

  async function removeModuleItem(collectionName, item) {
    if (!activeTrip || activeTripIsReadOnly) return
    try {
      if (item?.attachmentStoragePath) await deleteObject(storageRef(storage, item.attachmentStoragePath)).catch(() => null)
      if (item?.documentId) await deleteDoc(doc(db, 'trips', activeTrip.id, 'documents', item.documentId)).catch(() => null)
      await deleteDoc(doc(db, 'trips', activeTrip.id, collectionName, item.id))
    } catch (err) {
      setModuleError(err?.message || 'לא הצלחנו למחוק את הפריט.')
    }
  }

  async function uploadLinkedFile(file, category, linkedCollection, linkedId) {
    if (!file) return {}
    if (file.size > 20 * 1024 * 1024) throw new Error('גודל הקובץ מוגבל ל־20MB.')
    const name = safeFileName(file.name)
    const unique = `${user.uid}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}-${name}`
    const path = `trips/${activeTrip.id}/documents/${unique}`
    const objectRef = storageRef(storage, path)
    await Promise.race([
      uploadBytes(objectRef, file, {
        contentType: file.type || 'application/octet-stream',
        customMetadata: { tripId: activeTrip.id, uploadedBy: user.uid, linkedCollection, linkedId }
      }),
      new Promise((_, reject) => window.setTimeout(() => reject(new Error('העלאת הקובץ לא הסתיימה. יש לוודא ש־Firebase Storage הופעל בפרויקט.')), 20000))
    ])
    const downloadURL = await getDownloadURL(objectRef)
    const documentRef = doc(collection(db, 'trips', activeTrip.id, 'documents'))
    await setDoc(documentRef, {
      name,
      category,
      storagePath: path,
      downloadURL,
      contentType: file.type || 'application/octet-stream',
      size: file.size,
      uploadedBy: user.uid,
      linkedCollection,
      linkedId,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    })
    return {
      documentId: documentRef.id,
      attachmentName: name,
      attachmentUrl: downloadURL,
      attachmentStoragePath: path
    }
  }

  async function addHotel(event) {
    event.preventDefault()
    if (!activeTrip || activeTripIsReadOnly || !hotelForm.name.trim()) return
    if (hotelForm.checkIn && hotelForm.checkOut && hotelForm.checkOut < hotelForm.checkIn) {
      setModuleError('תאריך היציאה מהמלון לא יכול להיות לפני תאריך הכניסה.')
      return
    }
    setBookingBusy(true)
    try {
      const itemRef = doc(collection(db, 'trips', activeTrip.id, 'hotels'))
      const attachment = await uploadLinkedFile(hotelFile, 'מלון', 'hotels', itemRef.id)
      await setDoc(itemRef, {
        ...hotelForm,
        name: hotelForm.name.trim(),
        city: hotelForm.city.trim(),
        bookingRef: hotelForm.bookingRef.trim(),
        notes: hotelForm.notes.trim(),
        ...attachment,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp()
      })
      setHotelForm({ name: '', city: '', checkIn: '', checkOut: '', bookingRef: '', notes: '' })
      setHotelFile(null)
      const input = document.getElementById('hotel-attachment')
      if (input) input.value = ''
      setModuleError('')
    } catch (err) {
      setModuleError(err?.message || 'לא הצלחנו להוסיף מלון.')
    } finally {
      setBookingBusy(false)
    }
  }

  async function addCar(event) {
    event.preventDefault()
    if (!activeTrip || activeTripIsReadOnly || !carForm.company.trim()) return
    if (carForm.pickupDate && carForm.dropoffDate && carForm.dropoffDate < carForm.pickupDate) {
      setModuleError('תאריך ההחזרה לא יכול להיות לפני תאריך האיסוף.')
      return
    }
    setBookingBusy(true)
    try {
      const itemRef = doc(collection(db, 'trips', activeTrip.id, 'cars'))
      const attachment = await uploadLinkedFile(carFile, 'השכרת רכב', 'cars', itemRef.id)
      await setDoc(itemRef, {
        ...carForm,
        company: carForm.company.trim(),
        pickup: carForm.pickup.trim(),
        dropoff: carForm.dropoff.trim(),
        bookingRef: carForm.bookingRef.trim(),
        notes: carForm.notes.trim(),
        ...attachment,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp()
      })
      setCarForm({ company: '', pickup: '', dropoff: '', pickupDate: '', dropoffDate: '', bookingRef: '', notes: '' })
      setCarFile(null)
      const input = document.getElementById('car-attachment')
      if (input) input.value = ''
      setModuleError('')
    } catch (err) {
      setModuleError(err?.message || 'לא הצלחנו להוסיף השכרת רכב.')
    } finally {
      setBookingBusy(false)
    }
  }

  async function addFlight(event) {
    event.preventDefault()
    if (!activeTrip || activeTripIsReadOnly || !flightForm.airline.trim()) return
    setBookingBusy(true)
    try {
      const itemRef = doc(collection(db, 'trips', activeTrip.id, 'flights'))
      const attachment = await uploadLinkedFile(flightFile, 'טיסה', 'flights', itemRef.id)
      await setDoc(itemRef, {
        ...flightForm,
        airline: flightForm.airline.trim(),
        flightNumber: flightForm.flightNumber.trim(),
        from: flightForm.from.trim(),
        to: flightForm.to.trim(),
        bookingRef: flightForm.bookingRef.trim(),
        notes: flightForm.notes.trim(),
        ...attachment,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp()
      })
      setFlightForm({
        airline: '', flightNumber: '', from: '', to: '', departureDate: '', departureTime: '',
        arrivalDate: '', arrivalTime: '', bookingRef: '', notes: ''
      })
      setFlightFile(null)
      const input = document.getElementById('flight-attachment')
      if (input) input.value = ''
      setModuleError('')
    } catch (err) {
      setModuleError(err?.message || 'לא הצלחנו להוסיף טיסה.')
    } finally {
      setBookingBusy(false)
    }
  }

  async function saveBudget(event) {
    event.preventDefault()
    if (!activeTrip || activeTripIsReadOnly) return
    setSavingBudget(true)
    try {
      await setDoc(doc(db, 'trips', activeTrip.id), {
        budgetLimit: Number(budgetLimit) || 0,
        budgetCurrency,
        updatedAt: serverTimestamp()
      }, { merge: true })
    } catch (err) {
      setModuleError(err?.message || 'לא הצלחנו לשמור את התקציב.')
    } finally {
      setSavingBudget(false)
    }
  }

  async function addExpense(event) {
    event.preventDefault()
    if (!activeTrip || activeTripIsReadOnly || !expenseForm.description.trim() || !expenseForm.amount) return
    try {
      await addDoc(collection(db, 'trips', activeTrip.id, 'expenses'), {
        description: expenseForm.description.trim(),
        category: expenseForm.category,
        amount: Number(expenseForm.amount) || 0,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp()
      })
      setExpenseForm({ description: '', category: 'כללי', amount: '' })
    } catch (err) {
      setModuleError(err?.message || 'לא הצלחנו להוסיף הוצאה.')
    }
  }

  async function uploadDocument(event) {
    event.preventDefault()
    if (!activeTrip || activeTripIsReadOnly || !documentFile) return
    setUploadingDocument(true)
    setModuleError('')
    try {
      await uploadLinkedFile(documentFile, documentCategory, 'documents', '')
      setDocumentFile(null)
      setDocumentCategory('אחר')
      const input = document.getElementById('trip-document-file')
      if (input) input.value = ''
    } catch (err) {
      setModuleError(err?.message || 'לא הצלחנו להעלות את המסמך.')
    } finally {
      setUploadingDocument(false)
    }
  }

  async function importBookingDocument(file, section, category) {
    if (!activeTrip || activeTripIsReadOnly || !file || bookingBusy) return
    setBookingBusy(true)
    setModuleError('')
    setSmartImportStatus((current) => ({ ...current, [section]: 'מעלה את הקובץ…' }))
    try {
      await uploadLinkedFile(file, category, 'documents', '')
      setSmartImportFiles((current) => ({ ...current, [section]: null }))
      setSmartImportStatus((current) => ({ ...current, [section]: 'הקובץ הועלה ונשלח לפענוח. הפרטים יופיעו כאן אוטומטית בסיום.' }))
      const input = document.getElementById(`smart-import-${section}`)
      if (input) input.value = ''
    } catch (err) {
      setSmartImportStatus((current) => ({ ...current, [section]: '' }))
      setModuleError(err?.message || 'לא הצלחנו להעלות ולפענח את המסמך.')
    } finally {
      setBookingBusy(false)
    }
  }

  async function removeDocument(item) {
    if (!activeTrip || activeTripIsReadOnly) return
    try {
      if (item.storagePath) await deleteObject(storageRef(storage, item.storagePath)).catch(() => null)
      await deleteDoc(doc(db, 'trips', activeTrip.id, 'documents', item.id))
    } catch (err) {
      setModuleError(err?.message || 'לא הצלחנו למחוק את המסמך.')
    }
  }

  async function analyzeDocumentAgain(item) {
    if (!activeTrip || activeTripIsReadOnly || analyzingDocumentId) return
    setAnalyzingDocumentId(item.id)
    setModuleError('')
    try {
      const token = await user.getIdToken()
      const response = await fetch(DOCUMENT_ANALYSIS_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ tripId: activeTrip.id, documentId: item.id })
      })
      const body = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(body?.error || 'לא הצלחנו לנתח את המסמך מחדש.')
    } catch (err) {
      setModuleError(err?.message || 'לא הצלחנו לנתח את המסמך מחדש.')
    } finally {
      setAnalyzingDocumentId('')
    }
  }

  async function sendChat(event) {
    event.preventDefault()
    if (!activeTrip || activeTripIsReadOnly || !chatInput.trim() || chatBusy) return
    if (!AI_ENDPOINT) {
      setChatError('ממשק ה־Trip AI מוכן, אך שירות ה־AI המאובטח עדיין לא הופעל בשרת.')
      return
    }
    const message = chatInput.trim()
    setChatInput('')
    setChatBusy(true)
    setChatError('')
    try {
      await addDoc(collection(db, 'trips', activeTrip.id, 'chatMessages'), { role: 'user', text: message, createdAt: serverTimestamp() })
      const token = await user.getIdToken()
      const response = await fetch(AI_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ tripId: activeTrip.id, message })
      })
      const body = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(body?.error || 'שירות ה־AI לא זמין כרגע.')
      if (body?.reply) {
        await addDoc(collection(db, 'trips', activeTrip.id, 'chatMessages'), { role: 'assistant', text: body.reply, createdAt: serverTimestamp() })
      }
    } catch (err) {
      setChatError(err?.message || 'לא הצלחנו לקבל תשובה מה־Trip AI.')
    } finally {
      setChatBusy(false)
    }
  }

  const spent = useMemo(() => expenses.reduce((sum, expense) => sum + (Number(expense.amount) || 0), 0), [expenses])
  const savedBudget = Number(activeTrip?.budgetLimit) || 0
  const currency = activeTrip?.budgetCurrency || 'ILS'
  const remaining = savedBudget - spent
  const packedCount = takeItems.filter((item) => item.done).length

  function renderSmartImport(section, category, label) {
    if (activeTripIsReadOnly) return null
    const file = smartImportFiles[section]
    return (
      <section className="panel smart-import-panel">
        <div className="smart-import-copy">
          <span>✨</span>
          <div><h3>הוספה חכמה ממסמך</h3><p>העלו PDF או תמונה של {label}. ה־AI יפענח, ימלא וישמור את כל הפרטים שמופיעים במסמך.</p></div>
        </div>
        <div className="smart-import-actions">
          <label className={`smart-file-picker ${bookingBusy ? 'busy' : ''}`}>{bookingBusy ? 'מעלה ומפענח…' : 'בחירת PDF או תמונה'}
            <input id={`smart-import-${section}`} type="file" accept=".pdf,image/*" disabled={bookingBusy} onChange={(event) => {
              const selectedFile = event.target.files?.[0] || null
              setSmartImportFiles((current) => ({ ...current, [section]: selectedFile }))
              if (selectedFile) importBookingDocument(selectedFile, section, category)
            }} />
          </label>
          {file && <small>{file.name}</small>}
          {smartImportStatus[section] && <div className="smart-import-status" role="status">{smartImportStatus[section]}</div>}
        </div>
      </section>
    )
  }

  function renderItinerary() {
    if (!tripDays.length) {
      return (
        <>
          <SectionHeader eyebrow="מסלול" title="מסלול הטיול" subtitle="אחרי שתגדירו תאריך התחלה וסיום, כל ימי הטיול יופיעו כאן אוטומטית." />
          <section className="panel empty-state">
            <div className="empty-icon">🗓️</div>
            <h3>עדיין אין טווח תאריכים מלא</h3>
            <p>הגדירו תאריכי התחלה וסיום בטיול כדי לפרוס את הימים.</p>
          </section>
        </>
      )
    }

    return (
      <>
        <section className="itinerary-day-head">
          <div>
            <p className="eyebrow">יום {activeDay.index} מתוך {tripDays.length}</p>
            <h1>{activeDayPlan?.title || `יום ${activeDay.index}`}</h1>
            <p>{activeDay.weekday} · {activeDay.displayDate}{activeDayPlan?.city ? ` · ${activeDayPlan.city}` : ''}</p>
          </div>
          {!activeTripIsReadOnly && (
            <button className="ai-day-button" type="button" onClick={() => openSection('chat')}>
              ✨ מלא את היום עם Trip AI
            </button>
          )}
        </section>

        {activeDayPlan?.items?.length ? (
          <section className="day-timeline">
            {activeDayPlan.items.map((item, index) => (
              <article className="timeline-item" key={`${item.time || 'item'}-${index}`}>
                <div className="timeline-time">{item.time || '—'}</div>
                <div className="timeline-dot" />
                <div className="timeline-card">
                  <div className="timeline-type">{item.type || 'פעילות'}</div>
                  <h3>{item.title}</h3>
                  {item.location && <p>📍 {item.location}</p>}
                  {item.notes && <p className="record-notes">{item.notes}</p>}
                </div>
              </article>
            ))}
          </section>
        ) : (
          <section className="panel empty-day">
            <div className="empty-icon">📅</div>
            <h3>יום {activeDay.index} עדיין ריק</h3>
            <p>אפשר לעבור בין כל הימים כבר עכשיו. בהמשך תוכלו למלא אותו ידנית או לבקש מ־Trip AI לבנות אותו לפי הטיסות, המלונות, הרכב והמסמכים שהעליתם.</p>
            {!activeTripIsReadOnly && <button className="primary-button" type="button" onClick={() => openSection('chat')}>✨ תכנן את היום עם AI</button>}
          </section>
        )}
      </>
    )
  }

  function renderOverview() {
    return (
      <>
        <section className="trip-hero">
          <div className="trip-hero-title">
            <div>
              <p className="eyebrow">{activeTripIsReadOnly ? 'שותף איתי' : 'הטיול שלי'}</p>
              <h1>{activeTrip.title}</h1>
              {activeTrip.destination && <p className="trip-destination">📍 {activeTrip.destination}</p>}
            </div>
            {activeTripIsReadOnly && <span className="readonly-badge">צפייה בלבד</span>}
          </div>
          {(activeTrip.startDate || activeTrip.endDate) && <div className="trip-date-banner">📅 {[activeTrip.startDate, activeTrip.endDate].filter(Boolean).join(' → ')}</div>}
        </section>

        <section className="dashboard-cards">
          <button className="feature-card" type="button" onClick={() => openSection('flights')}><span className="feature-icon">✈️</span><div><strong>טיסות</strong><small>{flights.length ? `${flights.length} טיסות` : 'אין עדיין טיסות'}</small></div><b>←</b></button>
          <button className="feature-card" type="button" onClick={() => openSection('hotels')}><span className="feature-icon">🏨</span><div><strong>מלונות</strong><small>{hotels.length ? `${hotels.length} הזמנות` : 'אין עדיין מלונות'}</small></div><b>←</b></button>
          <button className="feature-card" type="button" onClick={() => openSection('cars')}><span className="feature-icon">🚗</span><div><strong>השכרת רכב</strong><small>{cars.length ? `${cars.length} הזמנות` : 'אין עדיין רכב'}</small></div><b>←</b></button>
          <button className="feature-card" type="button" onClick={() => openSection('take')}><span className="feature-icon">🧳</span><div><strong>רשימת לקחת</strong><small>{packedCount}/{takeItems.length} מוכנים</small></div><b>←</b></button>
          <button className="feature-card" type="button" onClick={() => openSection('budget')}><span className="feature-icon">💰</span><div><strong>תקציב</strong><small>{formatMoney(spent, currency)} הוצאות</small></div><b>←</b></button>
          <button className="feature-card" type="button" onClick={() => openSection('documents')}><span className="feature-icon">📎</span><div><strong>מסמכים</strong><small>{documents.length ? `${documents.length} קבצים` : 'העלאת כרטיסים והזמנות'}</small></div><b>←</b></button>
          {!activeTripIsReadOnly && <button className="feature-card ai-card" type="button" onClick={() => openSection('chat')}><span className="feature-icon">✨</span><div><strong>Trip AI</strong><small>לתכנן ולעדכן את הטיול בשיחה</small></div><b>←</b></button>}
        </section>
      </>
    )
  }

  function renderTake() {
    return (
      <>
        <SectionHeader eyebrow="הכנות לטיול" title="רשימת לקחת" subtitle={`${packedCount} מתוך ${takeItems.length} פריטים מוכנים`} />
        {!activeTripIsReadOnly && (
          <form className="quick-add panel" onSubmit={addTakeItem}>
            <input value={takeText} onChange={(e) => setTakeText(e.target.value)} placeholder="למשל: דרכונים, מטען, תרופות…" required />
            <button className="primary-button" type="submit">הוספה +</button>
          </form>
        )}
        <section className="panel list-panel">
          {takeItems.length ? takeItems.map((item) => (
            <div className={`checklist-row ${item.done ? 'done' : ''}`} key={item.id}>
              <button className="check-toggle" type="button" onClick={() => toggleTakeItem(item)} disabled={activeTripIsReadOnly}>{item.done ? '✓' : ''}</button>
              <span>{item.text}</span>
              {!activeTripIsReadOnly && <button className="icon-danger" type="button" onClick={() => removeModuleItem('takeItems', item)}>🗑️</button>}
            </div>
          )) : <div className="empty-state compact-empty"><div className="empty-icon">🧳</div><h3>הרשימה עדיין ריקה</h3></div>}
        </section>
      </>
    )
  }

  function renderHotels() {
    return (
      <>
        <SectionHeader eyebrow="הזמנות" title="מלונות" subtitle="פרטי הלינה והאישורים, כמו באפליקציית Japan." />
        {renderSmartImport('hotels', 'מלון', 'אישור המלון')}
        {!activeTripIsReadOnly && (
          <details className="panel manual-entry">
            <summary>הוספה או תיקון ידני</summary>
            <section className="form-panel manual-form-panel">
            <form className="module-form" onSubmit={addHotel}>
              <label>שם המלון<input value={hotelForm.name} onChange={(e) => setHotelForm({ ...hotelForm, name: e.target.value })} required /></label>
              <label>עיר<input value={hotelForm.city} onChange={(e) => setHotelForm({ ...hotelForm, city: e.target.value })} /></label>
              <label>כניסה<input type="date" value={hotelForm.checkIn} onChange={(e) => setHotelForm({ ...hotelForm, checkIn: e.target.value })} /></label>
              <label>יציאה<input type="date" min={hotelForm.checkIn || undefined} value={hotelForm.checkOut} onChange={(e) => setHotelForm({ ...hotelForm, checkOut: e.target.value })} /></label>
              <label>מספר הזמנה<input value={hotelForm.bookingRef} onChange={(e) => setHotelForm({ ...hotelForm, bookingRef: e.target.value })} /></label>
              <label className="wide-field">הערות<textarea rows="2" value={hotelForm.notes} onChange={(e) => setHotelForm({ ...hotelForm, notes: e.target.value })} /></label>
              <label className="wide-field file-label">PDF / תמונה של ההזמנה<input id="hotel-attachment" type="file" accept=".pdf,image/*" onChange={(e) => setHotelFile(e.target.files?.[0] || null)} /></label>
              <button className="primary-button module-submit" type="submit" disabled={bookingBusy}>{bookingBusy ? 'שומרים…' : 'הוספת מלון +'}</button>
            </form>
            </section>
          </details>
        )}
        <div className="record-grid">
          {hotels.length ? hotels.map((hotel) => (
            <article className="record-card" key={hotel.id}>
              <div className="record-head"><div><span>🏨</span><h3>{hotel.name}</h3></div>{!activeTripIsReadOnly && <button className="icon-danger" type="button" onClick={() => removeModuleItem('hotels', hotel)}>🗑️</button>}</div>
              {hotel.city && <p>📍 {hotel.city}</p>}
              {hotel.address && <p>🏨 כתובת: {hotel.address}</p>}
              {(hotel.checkIn || hotel.checkOut) && <p>📅 {[hotel.checkIn, hotel.checkOut].filter(Boolean).join(' → ')}</p>}
              {hotel.room && <p>🛏️ חדר: {hotel.room}</p>}
              {hotel.bookingRef && <p>🎟️ הזמנה: <strong>{hotel.bookingRef}</strong></p>}
              {hotel.notes && <p className="record-notes">{hotel.notes}</p>}
              <AttachmentLink item={hotel} />
            </article>
          )) : <div className="empty-state record-empty"><div className="empty-icon">🏨</div><h3>אין עדיין מלונות</h3></div>}
        </div>
      </>
    )
  }

  function renderCars() {
    return (
      <>
        <SectionHeader eyebrow="תחבורה" title="השכרת רכב" subtitle="פרטי האיסוף, ההחזרה והאישור המצורף." />
        {renderSmartImport('cars', 'השכרת רכב', 'אישור השכרת הרכב')}
        {!activeTripIsReadOnly && (
          <details className="panel manual-entry">
            <summary>הוספה או תיקון ידני</summary>
            <section className="form-panel manual-form-panel">
            <form className="module-form" onSubmit={addCar}>
              <label>חברת השכרה<input value={carForm.company} onChange={(e) => setCarForm({ ...carForm, company: e.target.value })} required /></label>
              <label>מקום איסוף<input value={carForm.pickup} onChange={(e) => setCarForm({ ...carForm, pickup: e.target.value })} /></label>
              <label>מקום החזרה<input value={carForm.dropoff} onChange={(e) => setCarForm({ ...carForm, dropoff: e.target.value })} /></label>
              <label>תאריך איסוף<input type="date" value={carForm.pickupDate} onChange={(e) => setCarForm({ ...carForm, pickupDate: e.target.value })} /></label>
              <label>תאריך החזרה<input type="date" min={carForm.pickupDate || undefined} value={carForm.dropoffDate} onChange={(e) => setCarForm({ ...carForm, dropoffDate: e.target.value })} /></label>
              <label>מספר הזמנה<input value={carForm.bookingRef} onChange={(e) => setCarForm({ ...carForm, bookingRef: e.target.value })} /></label>
              <label className="wide-field">הערות<textarea rows="2" value={carForm.notes} onChange={(e) => setCarForm({ ...carForm, notes: e.target.value })} /></label>
              <label className="wide-field file-label">PDF / תמונה של ההזמנה<input id="car-attachment" type="file" accept=".pdf,image/*" onChange={(e) => setCarFile(e.target.files?.[0] || null)} /></label>
              <button className="primary-button module-submit" type="submit" disabled={bookingBusy}>{bookingBusy ? 'שומרים…' : 'הוספת רכב +'}</button>
            </form>
            </section>
          </details>
        )}
        <div className="record-grid">
          {cars.length ? cars.map((car) => (
            <article className="record-card" key={car.id}>
              <div className="record-head"><div><span>🚗</span><h3>{car.company}</h3></div>{!activeTripIsReadOnly && <button className="icon-danger" type="button" onClick={() => removeModuleItem('cars', car)}>🗑️</button>}</div>
              {(car.pickup || car.dropoff) && <p>📍 {[car.pickup, car.dropoff].filter(Boolean).join(' → ')}</p>}
              {(car.pickupDate || car.pickupTime) && <p>🚗 איסוף: {[car.pickupDate, car.pickupTime].filter(Boolean).join(' · ')}</p>}
              {(car.dropoffDate || car.dropoffTime) && <p>🏁 החזרה: {[car.dropoffDate, car.dropoffTime].filter(Boolean).join(' · ')}</p>}
              {car.vehicle && <p>🚙 רכב: {car.vehicle}</p>}
              {car.bookingRef && <p>🎟️ הזמנה: <strong>{car.bookingRef}</strong></p>}
              {car.notes && <p className="record-notes">{car.notes}</p>}
              <AttachmentLink item={car} />
            </article>
          )) : <div className="empty-state record-empty"><div className="empty-icon">🚗</div><h3>אין עדיין השכרת רכב</h3></div>}
        </div>
      </>
    )
  }

  function renderFlights() {
    return (
      <>
        <SectionHeader eyebrow="הזמנות" title="טיסות" subtitle="כרטיסים, זמני טיסה ומספרי הזמנה במקום אחד." />
        {renderSmartImport('flights', 'טיסה', 'כרטיס הטיסה או אישור ההזמנה')}
        {!activeTripIsReadOnly && (
          <details className="panel manual-entry">
            <summary>הוספה או תיקון ידני</summary>
            <section className="form-panel manual-form-panel">
            <form className="module-form flight-form" onSubmit={addFlight}>
              <label>חברת תעופה<input value={flightForm.airline} onChange={(e) => setFlightForm({ ...flightForm, airline: e.target.value })} required /></label>
              <label>מספר טיסה<input value={flightForm.flightNumber} onChange={(e) => setFlightForm({ ...flightForm, flightNumber: e.target.value })} placeholder="EY 593" /></label>
              <label>מ־<input value={flightForm.from} onChange={(e) => setFlightForm({ ...flightForm, from: e.target.value })} placeholder="TLV" /></label>
              <label>אל<input value={flightForm.to} onChange={(e) => setFlightForm({ ...flightForm, to: e.target.value })} placeholder="NRT" /></label>
              <label>תאריך יציאה<input type="date" value={flightForm.departureDate} onChange={(e) => setFlightForm({ ...flightForm, departureDate: e.target.value })} /></label>
              <label>שעת יציאה<input type="time" value={flightForm.departureTime} onChange={(e) => setFlightForm({ ...flightForm, departureTime: e.target.value })} /></label>
              <label>תאריך הגעה<input type="date" value={flightForm.arrivalDate} onChange={(e) => setFlightForm({ ...flightForm, arrivalDate: e.target.value })} /></label>
              <label>שעת הגעה<input type="time" value={flightForm.arrivalTime} onChange={(e) => setFlightForm({ ...flightForm, arrivalTime: e.target.value })} /></label>
              <label>מספר הזמנה<input value={flightForm.bookingRef} onChange={(e) => setFlightForm({ ...flightForm, bookingRef: e.target.value })} /></label>
              <label className="wide-field">הערות<textarea rows="2" value={flightForm.notes} onChange={(e) => setFlightForm({ ...flightForm, notes: e.target.value })} /></label>
              <label className="wide-field file-label">PDF / תמונה של הכרטיס<input id="flight-attachment" type="file" accept=".pdf,image/*" onChange={(e) => setFlightFile(e.target.files?.[0] || null)} /></label>
              <button className="primary-button module-submit" type="submit" disabled={bookingBusy}>{bookingBusy ? 'שומרים…' : 'הוספת טיסה +'}</button>
            </form>
            </section>
          </details>
        )}
        <div className="record-grid">
          {flights.length ? flights.map((flight) => (
            <article className="record-card flight-card" key={flight.id}>
              <div className="record-head"><div><span>✈️</span><h3>{flight.airline}{flight.flightNumber ? ` · ${flight.flightNumber}` : ''}</h3></div>{!activeTripIsReadOnly && <button className="icon-danger" type="button" onClick={() => removeModuleItem('flights', flight)}>🗑️</button>}</div>
              {(flight.from || flight.to) && <p className="flight-route"><strong>{flight.from || '—'}</strong> → <strong>{flight.to || '—'}</strong></p>}
              {(flight.departureDate || flight.departureTime) && <p>🛫 יציאה: {[flight.departureDate, flight.departureTime].filter(Boolean).join(' · ')}</p>}
              {(flight.arrivalDate || flight.arrivalTime) && <p>🛬 הגעה: {[flight.arrivalDate, flight.arrivalTime].filter(Boolean).join(' · ')}</p>}
              {flight.terminal && <p>🏢 טרמינל: {flight.terminal}</p>}
              {flight.seat && <p>💺 מושב: {flight.seat}</p>}
              {flight.bookingRef && <p>🎟️ הזמנה: <strong>{flight.bookingRef}</strong></p>}
              {flight.notes && <p className="record-notes">{flight.notes}</p>}
              <AttachmentLink item={flight} />
            </article>
          )) : <div className="empty-state record-empty"><div className="empty-icon">✈️</div><h3>אין עדיין טיסות</h3><p>אפשר להוסיף פרטים ידנית ולצרף את הכרטיס.</p></div>}
        </div>
      </>
    )
  }

  function renderBudget() {
    return (
      <>
        <SectionHeader eyebrow="כספים" title="תקציב והוצאות" subtitle="מעקב אחר התקציב של הטיול." />
        <section className="budget-summary">
          <div><small>תקציב</small><strong>{formatMoney(savedBudget, currency)}</strong></div>
          <div><small>הוצאות</small><strong>{formatMoney(spent, currency)}</strong></div>
          <div className={remaining < 0 ? 'negative' : ''}><small>נותר</small><strong>{formatMoney(remaining, currency)}</strong></div>
        </section>
        {!activeTripIsReadOnly && (
          <section className="panel form-panel">
            <form className="budget-settings" onSubmit={saveBudget}>
              <label>תקציב כולל<input type="number" min="0" step="0.01" value={budgetLimit} onChange={(e) => setBudgetLimit(e.target.value)} /></label>
              <label>מטבע<select value={budgetCurrency} onChange={(e) => setBudgetCurrency(e.target.value)}>{CURRENCIES.map((item) => <option key={item}>{item}</option>)}</select></label>
              <button className="secondary-button" type="submit" disabled={savingBudget}>{savingBudget ? 'שומרים…' : 'שמירת תקציב'}</button>
            </form>
            <div className="form-divider" />
            <form className="expense-form" onSubmit={addExpense}>
              <label>תיאור<input value={expenseForm.description} onChange={(e) => setExpenseForm({ ...expenseForm, description: e.target.value })} required /></label>
              <label>קטגוריה<select value={expenseForm.category} onChange={(e) => setExpenseForm({ ...expenseForm, category: e.target.value })}><option>כללי</option><option>אוכל</option><option>תחבורה</option><option>מלון</option><option>טיסה</option><option>אטרקציות</option><option>קניות</option></select></label>
              <label>סכום<input type="number" min="0" step="0.01" value={expenseForm.amount} onChange={(e) => setExpenseForm({ ...expenseForm, amount: e.target.value })} required /></label>
              <button className="primary-button" type="submit">הוספת הוצאה +</button>
            </form>
          </section>
        )}
        <section className="panel expense-list">
          {expenses.length ? expenses.map((expense) => (
            <div className="expense-row" key={expense.id}>
              <div><strong>{expense.description}</strong><span>{expense.category || 'כללי'}</span></div>
              <b>{formatMoney(expense.amount, currency)}</b>
              {!activeTripIsReadOnly && <button className="icon-danger" type="button" onClick={() => removeModuleItem('expenses', expense)}>🗑️</button>}
            </div>
          )) : <div className="empty-state compact-empty"><div className="empty-icon">💰</div><h3>אין עדיין הוצאות</h3></div>}
        </section>
      </>
    )
  }

  function renderDocuments() {
    return (
      <>
        <SectionHeader eyebrow="מסמכים" title="כרטיסים, הזמנות ותוכניות" subtitle="המסמכים הכלליים של הטיול וגם האישורים שצורפו לטיסות, מלונות ורכב." />
        {!activeTripIsReadOnly && (
          <section className="panel form-panel">
            <form className="document-upload-form" onSubmit={uploadDocument}>
              <label>סוג מסמך<select value={documentCategory} onChange={(e) => setDocumentCategory(e.target.value)}>{DOCUMENT_CATEGORIES.map((item) => <option key={item}>{item}</option>)}</select></label>
              <label className="wide-field">קובץ<input id="trip-document-file" type="file" accept=".pdf,image/*" onChange={(e) => setDocumentFile(e.target.files?.[0] || null)} required /></label>
              <button className="primary-button" type="submit" disabled={uploadingDocument}>{uploadingDocument ? 'מעלים…' : 'העלאת מסמך +'}</button>
            </form>
          </section>
        )}
        <div className="record-grid">
          {documents.length ? documents.map((item) => (
            <article className="record-card document-card" key={item.id}>
              <div className="record-head">
                <div><span>{item.contentType?.startsWith('image/') ? '🖼️' : '📄'}</span><h3>{item.name}</h3></div>
                {!activeTripIsReadOnly && <button className="icon-danger" type="button" onClick={() => removeDocument(item)}>🗑️</button>}
              </div>
              <p>{item.category || 'אחר'} · {formatBytes(item.size)}</p>
              {item.processingStatus && <p className={`document-status ${item.processingStatus}`}>מצב פענוח: {item.processingStatus === 'done' ? 'הושלם' : item.processingStatus === 'processing' ? 'בעיבוד…' : item.processingStatus === 'error' ? 'נכשל' : 'ממתין'}</p>}
              {item.extractionSummary && <p className="document-summary">{item.extractionSummary}</p>}
              {item.extractedCounts && <p className="document-results">נמצאו: {[
                item.extractedCounts.flights ? `${item.extractedCounts.flights} טיסות` : '',
                item.extractedCounts.hotels ? `${item.extractedCounts.hotels} מלונות` : '',
                item.extractedCounts.cars ? `${item.extractedCounts.cars} השכרות רכב` : '',
                item.extractedCounts.tickets ? `${item.extractedCounts.tickets} כרטיסים` : '',
                item.extractedCounts.expenses ? `${item.extractedCounts.expenses} הוצאות` : ''
              ].filter(Boolean).join(' · ') || 'לא נמצאו פרטי הזמנה'}</p>}
              {item.processingError && <p className="document-error">שגיאת פענוח: {item.processingError}</p>}
              {item.linkedCollection && item.linkedCollection !== 'documents' && <span className="linked-badge">מחובר ל־{item.linkedCollection}</span>}
              {item.downloadURL && <a className="attachment-link" href={item.downloadURL} target="_blank" rel="noreferrer">פתיחת המסמך</a>}
              {!activeTripIsReadOnly && (
                <button className="reanalyze-button" type="button" onClick={() => analyzeDocumentAgain(item)} disabled={Boolean(analyzingDocumentId)}>
                  {analyzingDocumentId === item.id ? 'מנתח מחדש…' : '✨ ניתוח מחדש'}
                </button>
              )}
            </article>
          )) : <div className="empty-state record-empty"><div className="empty-icon">📎</div><h3>אין עדיין מסמכים</h3></div>}
        </div>
      </>
    )
  }

  function renderChat() {
    return (
      <>
        <SectionHeader eyebrow="Trip AI" title="המתכנן החכם של הטיול" subtitle="אפשר לבקש המלצות, לבנות ימים ולשנות את הטיול דרך שיחה." />
        <section className="panel chat-panel">
          <div className="chat-messages">
            {chatMessages.length ? chatMessages.map((message) => (
              <div className={`chat-bubble ${message.role === 'assistant' ? 'assistant' : 'user'}`} key={message.id}>
                <strong>{message.role === 'assistant' ? 'Trip AI' : 'אתה'}</strong>
                <p>{message.text}</p>
              </div>
            )) : <div className="empty-chat"><span>✨</span><h3>אפשר להתחיל לתכנן</h3><p>לדוגמה: ״בנה לי את יום 3 לפי המלון והטיסות שהעליתי״.</p></div>}
          </div>
          {chatError && <div className="error-box">{chatError}</div>}
          <form className="chat-compose" onSubmit={sendChat}>
            <textarea rows="3" value={chatInput} onChange={(e) => setChatInput(e.target.value)} placeholder="מה תרצה לשנות או לתכנן?" />
            <button className="primary-button" type="submit" disabled={chatBusy}>{chatBusy ? 'חושב…' : 'שליחה'}</button>
          </form>
        </section>
      </>
    )
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="topbar-brand">
          <button className="menu-button" type="button" aria-label="פתיחת תפריט" onClick={() => setMenuOpen(true)}>☰</button>
          <div>
            <div className="app-title">TripPlanner <small>{APP_VERSION}</small></div>
            {activeTrip && <div className="active-trip-title">{activeTrip.title}</div>}
            <div className={`connection-status ${online ? 'online' : 'offline'}`}>{online ? 'מחובר' : 'לא מחובר — השינויים יסונכרנו בהמשך'}</div>
          </div>
        </div>
        <button className="account-button" title={user.email || 'Account'} type="button" onClick={() => setMenuOpen(true)}>
          {user.photoURL ? <img src={user.photoURL} alt="" /> : <span>👤</span>}
        </button>
      </header>

      {activeTrip && screen !== 'trips' && screen !== 'new' && (
        <div className="route-topbar">
          <button className={`route-main-button ${screen === 'itinerary' ? 'active' : ''}`} type="button" onClick={() => openSection('itinerary')}>
            🗓️ <span>מסלול</span>
          </button>
          {tripDays.length ? (
            <div className="days-strip">
              {tripDays.map((day) => (
                <button className={`day-pill ${screen === 'itinerary' && activeDay?.date === day.date ? 'active' : ''}`} type="button" key={day.date} onClick={() => openDay(day)}>
                  <small>יום {day.index}</small>
                  <strong>{day.weekday}</strong>
                  <span>{day.displayDate}</span>
                  {itineraryByDate.get(day.date)?.items?.length ? <i>•</i> : null}
                </button>
              ))}
            </div>
          ) : <div className="days-placeholder">הגדירו תאריך התחלה וסיום כדי להציג את ימי הטיול</div>}
        </div>
      )}

      {menuOpen && <button className="menu-overlay" aria-label="סגירת תפריט" onClick={() => setMenuOpen(false)} />}
      <aside className={`side-menu ${menuOpen ? 'open' : ''}`} aria-hidden={!menuOpen}>
        <div className="menu-head">
          <div><strong>{activeTrip?.title || 'TripPlanner'}</strong><small>{user.email}</small></div>
          <button className="menu-close" type="button" onClick={() => setMenuOpen(false)}>✕</button>
        </div>

        {activeTrip && (
          <>
            <button className={screen === 'itinerary' ? 'active' : ''} type="button" onClick={() => openSection('itinerary')}>🗓️ מסלול הטיול<small>ימים, שעות ומקומות</small></button>
            <button className={screen === 'overview' ? 'active' : ''} type="button" onClick={() => openSection('overview')}>🧭 סקירת הטיול</button>
            <button className={screen === 'flights' ? 'active' : ''} type="button" onClick={() => openSection('flights')}>✈️ טיסות</button>
            <button className={screen === 'hotels' ? 'active' : ''} type="button" onClick={() => openSection('hotels')}>🏨 מלונות</button>
            <button className={screen === 'cars' ? 'active' : ''} type="button" onClick={() => openSection('cars')}>🚗 השכרת רכב</button>
            <button className={screen === 'take' ? 'active' : ''} type="button" onClick={() => openSection('take')}>🧳 רשימת לקחת</button>
            <button className={screen === 'budget' ? 'active' : ''} type="button" onClick={() => openSection('budget')}>💰 תקציב והוצאות</button>
            <button className={screen === 'documents' ? 'active' : ''} type="button" onClick={() => openSection('documents')}>📎 מסמכים וכרטיסים</button>
            {!activeTripIsReadOnly && <button className={screen === 'chat' ? 'active' : ''} type="button" onClick={() => openSection('chat')}>✨ Trip AI<small>תכנון ועריכת הטיול בשיחה</small></button>}
          </>
        )}

        <div className="menu-divider" />
        <button className={screen === 'trips' ? 'active' : ''} type="button" onClick={showTrips}>🗂️ כל הטיולים</button>
        <button className={screen === 'new' ? 'active' : ''} type="button" onClick={showNewTrip}>＋ טיול חדש</button>

        {activeTrip && !activeTripIsReadOnly && (
          <>
            <button type="button" onClick={showShare}>👨‍👩‍👧‍👦 שיתוף הטיול<small>צפייה בלבד לבני משפחה</small></button>
            <button className="danger-menu-button" type="button" onClick={() => { setDeleteOpen(true); setMenuOpen(false) }}>🗑️ מחיקת הטיול</button>
          </>
        )}
        {activeTripIsReadOnly && <div className="menu-readonly">👁️ הטיול משותף איתך בצפייה בלבד</div>}
        <div className="menu-spacer" />
        <button className="logout-menu-button" type="button" onClick={() => signOut(auth)}>יציאה</button>
      </aside>

      <main className={`dashboard ${activeTrip ? 'with-bottom-nav route-space' : ''}`}>
        {!ownedReady || !sharedReady || !initialTripResolved ? (
          <section className="panel centered-panel"><div className="empty-icon">🧭</div><p>טוענים את הטיולים…</p></section>
        ) : screen === 'trips' ? (
          <>
            <SectionHeader eyebrow="הטיולים שלי" title="כל הטיולים" subtitle="בחרו טיול כדי לפתוח אותו." />
            {trips.length ? <div className="trip-grid">{trips.map((trip) => <TripCard key={trip.id} trip={trip} currentUserId={user.uid} onOpen={openTrip} />)}</div> : <div className="empty-state"><div className="empty-icon">🧭</div><h3>הטיול הראשון מתחיל כאן</h3></div>}
          </>
        ) : screen === 'new' ? (
          <>
            <SectionHeader eyebrow="טיול חדש" title="לאן נוסעים?" subtitle="אחרי יצירת הטיול ייפתח מיד יום 1." />
            <section className="panel create-panel">
              <form className="trip-form" onSubmit={createTrip}>
                <label>שם הטיול<input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="טיול קיץ" required /></label>
                <label>יעד<input value={destination} onChange={(e) => setDestination(e.target.value)} placeholder="יפן" /></label>
                <label>תאריך התחלה<input type="date" value={startDate} onChange={(e) => handleStartDateChange(e.target.value)} /></label>
                <label>תאריך סיום<input type="date" min={startDate || undefined} value={endDate} onChange={(e) => setEndDate(e.target.value)} /></label>
                <button className="primary-button create-button" type="submit" disabled={creating}>{creating ? 'יוצרים…' : 'יצירת טיול +'}</button>
              </form>
              {error && <div className="error-box form-error">{error}</div>}
            </section>
          </>
        ) : activeTrip ? (
          <>
            {moduleError && <div className="error-box page-error">{moduleError}</div>}
            {activeTripIsReadOnly && <div className="readonly-notice">הטיול שותף איתך לצפייה בלבד. אפשר לעבור בין הימים ולפתוח מסמכים, אך רק בעל הטיול יכול לשנות אותו.</div>}
            {screen === 'itinerary' && renderItinerary()}
            {screen === 'overview' && renderOverview()}
            {screen === 'flights' && renderFlights()}
            {screen === 'hotels' && renderHotels()}
            {screen === 'cars' && renderCars()}
            {screen === 'take' && renderTake()}
            {screen === 'budget' && renderBudget()}
            {screen === 'documents' && renderDocuments()}
            {screen === 'chat' && !activeTripIsReadOnly && renderChat()}
          </>
        ) : <section className="panel centered-panel"><p>פותחים את הטיול…</p></section>}
      </main>

      {activeTrip && screen !== 'trips' && screen !== 'new' && (
        <nav className="bottom-nav" aria-label="ניווט ראשי">
          <button className={screen === 'take' ? 'active' : ''} type="button" onClick={() => openSection('take')}>🧳<span>לקחת</span></button>
          <button className={screen === 'hotels' ? 'active' : ''} type="button" onClick={() => openSection('hotels')}>🏨<span>מלונות</span></button>
          <button className={screen === 'flights' ? 'active' : ''} type="button" onClick={() => openSection('flights')}>✈️<span>טיסות</span></button>
          <button type="button" onClick={() => setMenuOpen(true)}>⋮<span>עוד</span></button>
        </nav>
      )}

      {shareOpen && activeTrip && !activeTripIsReadOnly && (
        <div className="modal-backdrop" role="presentation" onMouseDown={(e) => { if (e.target === e.currentTarget) setShareOpen(false) }}>
          <section className="modal-card" role="dialog" aria-modal="true">
            <div className="modal-head"><div><p className="eyebrow">משפחה</p><h2>שיתוף הטיול</h2></div><button className="modal-close" type="button" onClick={() => setShareOpen(false)}>✕</button></div>
            <p className="muted">המשתמש שיקבל את הטיול יוכל לצפות בלבד.</p>
            <form className="share-form" onSubmit={addShare}>
              <label>אימייל<input type="email" value={shareEmail} onChange={(e) => setShareEmail(e.target.value)} required /></label>
              <button className="primary-button" type="submit" disabled={sharing}>{sharing ? 'מעדכנים…' : 'שיתוף'}</button>
            </form>
            {shareError && <div className="error-box modal-error">{shareError}</div>}
            <div className="shared-users">
              <h3>משתמשים עם גישה</h3>
              {activeTripShares.length ? activeTripShares.map((email) => (
                <div className="shared-user-row" key={email}><div><strong>{email}</strong><span>צפייה בלבד</span></div><button className="remove-share" type="button" onClick={() => removeShare(email)} disabled={sharing}>הסרה</button></div>
              )) : <p className="muted">הטיול עדיין לא שותף.</p>}
            </div>
          </section>
        </div>
      )}

      {deleteOpen && activeTrip && !activeTripIsReadOnly && (
        <div className="modal-backdrop" role="presentation">
          <section className="modal-card delete-modal" role="dialog" aria-modal="true">
            <div className="danger-icon">🗑️</div>
            <h2>למחוק את ״{activeTrip.title}״?</h2>
            <p>המחיקה תסיר את הטיול ואת כל המידע שבו. אי אפשר לבטל פעולה זו.</p>
            <div className="modal-actions">
              <button className="secondary-button" type="button" onClick={() => setDeleteOpen(false)} disabled={deletingTrip}>ביטול</button>
              <button className="danger-button" type="button" onClick={deleteCurrentTrip} disabled={deletingTrip}>{deletingTrip ? 'מוחקים…' : 'כן, למחוק'}</button>
            </div>
          </section>
        </div>
      )}
    </div>
  )
}

export default function App() {
  const [user, setUser] = useState(null)
  const [profile, setProfile] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let unsubscribeProfile = null
    const unsubscribeAuth = onAuthStateChanged(auth, async (nextUser) => {
      if (unsubscribeProfile) {
        unsubscribeProfile()
        unsubscribeProfile = null
      }
      setUser(nextUser)
      setProfile(null)
      if (!nextUser) {
        setLoading(false)
        return
      }
      try {
        await ensureUserProfile(nextUser)
      } catch (err) {
        console.error('Could not initialize user profile', err)
      }
      unsubscribeProfile = onSnapshot(doc(db, 'users', nextUser.uid), (snapshot) => {
        setProfile(snapshot.exists() ? snapshot.data() : null)
        setLoading(false)
      }, () => setLoading(false))
    })

    return () => {
      unsubscribeAuth()
      if (unsubscribeProfile) unsubscribeProfile()
    }
  }, [])

  if (loading) {
    return (
      <main className="loading-page">
        <div className="brand-mark">TP</div>
        <p>TripPlanner {APP_VERSION} נטען…</p>
      </main>
    )
  }

  return user ? <TripPlanner user={user} profile={profile} /> : <LoginScreen />
}
