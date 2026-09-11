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

const APP_VERSION = 'v0.4.0'
const MODULE_COLLECTIONS = ['takeItems', 'hotels', 'cars', 'expenses', 'documents', 'chatMessages']
const CURRENCIES = ['ILS', 'USD', 'EUR', 'JPY', 'GBP']
const DOCUMENT_CATEGORIES = ['טיסה', 'מלון', 'כרטיס / אטרקציה', 'השכרת רכב', 'תוכנית / מסלול', 'ביטוח', 'אחר']
const AI_ENDPOINT = import.meta.env.VITE_TRIP_AI_ENDPOINT || ''

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
    await setDoc(profileRef, {
      ...common,
      role: 'user',
      createdAt: serverTimestamp()
    })
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
      if (mode === 'register') {
        await createUserWithEmailAndPassword(auth, email.trim(), password)
      } else {
        await signInWithEmailAndPassword(auth, email.trim(), password)
      }
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
        <p className="muted">כל הטיול שלכם במקום אחד — תכנון, הזמנות, מסמכים ועזרה חכמה.</p>

        <button className="google-button" onClick={googleSignIn} disabled={busy}>
          <span className="google-g">G</span>
          המשך עם Google
        </button>

        <div className="divider"><span>או</span></div>

        <form onSubmit={emailSignIn} className="auth-form">
          <label>
            אימייל
            <input type="email" value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="email" required />
          </label>
          <label>
            סיסמה
            <input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete={mode === 'register' ? 'new-password' : 'current-password'}
              minLength={6}
              required
            />
          </label>
          {error && <div className="error-box">{error}</div>}
          <button className="primary-button" type="submit" disabled={busy}>
            {busy ? 'רק רגע…' : mode === 'register' ? 'יצירת חשבון' : 'כניסה'}
          </button>
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

function TripPlanner({ user, profile }) {
  const [ownedTrips, setOwnedTrips] = useState([])
  const [sharedTrips, setSharedTrips] = useState([])
  const [ownedReady, setOwnedReady] = useState(false)
  const [sharedReady, setSharedReady] = useState(false)
  const [activeTripId, setActiveTripId] = useState(null)
  const [initialTripResolved, setInitialTripResolved] = useState(false)
  const [screen, setScreen] = useState('guide')
  const [menuOpen, setMenuOpen] = useState(false)
  const [shareOpen, setShareOpen] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)

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
  const [expenses, setExpenses] = useState([])
  const [documents, setDocuments] = useState([])
  const [chatMessages, setChatMessages] = useState([])

  const [takeText, setTakeText] = useState('')
  const [hotelForm, setHotelForm] = useState({ name: '', city: '', checkIn: '', checkOut: '', bookingRef: '', notes: '' })
  const [carForm, setCarForm] = useState({ company: '', pickup: '', dropoff: '', pickupDate: '', dropoffDate: '', bookingRef: '', notes: '' })
  const [expenseForm, setExpenseForm] = useState({ description: '', category: 'כללי', amount: '' })
  const [budgetLimit, setBudgetLimit] = useState('')
  const [budgetCurrency, setBudgetCurrency] = useState('ILS')
  const [savingBudget, setSavingBudget] = useState(false)

  const [documentFile, setDocumentFile] = useState(null)
  const [documentCategory, setDocumentCategory] = useState('אחר')
  const [uploadingDocument, setUploadingDocument] = useState(false)

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
    const tripsQuery = query(collection(db, 'trips'), where('ownerId', '==', user.uid))
    return onSnapshot(tripsQuery, (snapshot) => {
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
    setScreen('guide')
    setInitialTripResolved(true)
  }, [ownedReady, sharedReady, initialTripResolved, trips, profile?.lastTripId])

  useEffect(() => {
    if (!initialTripResolved || !ownedReady || !sharedReady) return
    if (activeTripId && trips.some((trip) => trip.id === activeTripId)) return
    if (trips.length) {
      setActiveTripId(trips[0].id)
      setScreen('guide')
    } else {
      setActiveTripId(null)
      setScreen('new')
    }
  }, [trips, activeTripId, initialTripResolved, ownedReady, sharedReady])

  useEffect(() => {
    if (!activeTripId) {
      setTakeItems([])
      setHotels([])
      setCars([])
      setExpenses([])
      setDocuments([])
      setChatMessages([])
      return undefined
    }

    setModuleError('')
    const tripRef = doc(db, 'trips', activeTripId)
    const unsubs = [
      onSnapshot(collection(tripRef, 'takeItems'), (snapshot) => {
        const rows = snapshot.docs.map((item) => ({ id: item.id, ...item.data() }))
        rows.sort((a, b) => timestampValue(a.createdAt) - timestampValue(b.createdAt))
        setTakeItems(rows)
      }, (err) => setModuleError(err?.message || 'לא הצלחנו לטעון את רשימת לקחת.')),
      onSnapshot(collection(tripRef, 'hotels'), (snapshot) => {
        const rows = snapshot.docs.map((item) => ({ id: item.id, ...item.data() }))
        rows.sort((a, b) => (a.checkIn || '').localeCompare(b.checkIn || ''))
        setHotels(rows)
      }, (err) => setModuleError(err?.message || 'לא הצלחנו לטעון מלונות.')),
      onSnapshot(collection(tripRef, 'cars'), (snapshot) => {
        const rows = snapshot.docs.map((item) => ({ id: item.id, ...item.data() }))
        rows.sort((a, b) => (a.pickupDate || '').localeCompare(b.pickupDate || ''))
        setCars(rows)
      }, (err) => setModuleError(err?.message || 'לא הצלחנו לטעון השכרות רכב.')),
      onSnapshot(collection(tripRef, 'expenses'), (snapshot) => {
        const rows = snapshot.docs.map((item) => ({ id: item.id, ...item.data() }))
        rows.sort((a, b) => timestampValue(b.createdAt) - timestampValue(a.createdAt))
        setExpenses(rows)
      }, (err) => setModuleError(err?.message || 'לא הצלחנו לטעון הוצאות.')),
      onSnapshot(collection(tripRef, 'documents'), (snapshot) => {
        const rows = snapshot.docs.map((item) => ({ id: item.id, ...item.data() }))
        rows.sort((a, b) => timestampValue(b.createdAt) - timestampValue(a.createdAt))
        setDocuments(rows)
      }, (err) => setModuleError(err?.message || 'לא הצלחנו לטעון מסמכים.'))
    ]

    if (!activeTripIsReadOnly) {
      unsubs.push(onSnapshot(collection(tripRef, 'chatMessages'), (snapshot) => {
        const rows = snapshot.docs.map((item) => ({ id: item.id, ...item.data() }))
        rows.sort((a, b) => timestampValue(a.createdAt) - timestampValue(b.createdAt))
        setChatMessages(rows)
      }, (err) => setChatError(err?.message || 'לא הצלחנו לטעון את השיחה.')))
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
    setScreen('guide')
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
      setScreen('guide')
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
    setShareError('')
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
    try {
      await setDoc(doc(db, 'trips', activeTrip.id, 'takeItems', item.id), { done: !item.done, updatedAt: serverTimestamp() }, { merge: true })
    } catch (err) {
      setModuleError(err?.message || 'לא הצלחנו לעדכן את הפריט.')
    }
  }

  async function removeModuleItem(collectionName, itemId, fallbackMessage) {
    if (!activeTrip || activeTripIsReadOnly) return
    try {
      await deleteDoc(doc(db, 'trips', activeTrip.id, collectionName, itemId))
    } catch (err) {
      setModuleError(err?.message || fallbackMessage)
    }
  }

  async function addHotel(event) {
    event.preventDefault()
    if (!activeTrip || activeTripIsReadOnly || !hotelForm.name.trim()) return
    if (hotelForm.checkIn && hotelForm.checkOut && hotelForm.checkOut < hotelForm.checkIn) {
      setModuleError('תאריך היציאה מהמלון לא יכול להיות לפני תאריך הכניסה.')
      return
    }
    try {
      await addDoc(collection(db, 'trips', activeTrip.id, 'hotels'), {
        ...hotelForm,
        name: hotelForm.name.trim(), city: hotelForm.city.trim(), bookingRef: hotelForm.bookingRef.trim(), notes: hotelForm.notes.trim(),
        createdAt: serverTimestamp(), updatedAt: serverTimestamp()
      })
      setHotelForm({ name: '', city: '', checkIn: '', checkOut: '', bookingRef: '', notes: '' })
      setModuleError('')
    } catch (err) {
      setModuleError(err?.message || 'לא הצלחנו להוסיף מלון.')
    }
  }

  async function addCar(event) {
    event.preventDefault()
    if (!activeTrip || activeTripIsReadOnly || !carForm.company.trim()) return
    if (carForm.pickupDate && carForm.dropoffDate && carForm.dropoffDate < carForm.pickupDate) {
      setModuleError('תאריך ההחזרה לא יכול להיות לפני תאריך האיסוף.')
      return
    }
    try {
      await addDoc(collection(db, 'trips', activeTrip.id, 'cars'), {
        ...carForm,
        company: carForm.company.trim(), pickup: carForm.pickup.trim(), dropoff: carForm.dropoff.trim(), bookingRef: carForm.bookingRef.trim(), notes: carForm.notes.trim(),
        createdAt: serverTimestamp(), updatedAt: serverTimestamp()
      })
      setCarForm({ company: '', pickup: '', dropoff: '', pickupDate: '', dropoffDate: '', bookingRef: '', notes: '' })
      setModuleError('')
    } catch (err) {
      setModuleError(err?.message || 'לא הצלחנו להוסיף השכרת רכב.')
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
      setModuleError('')
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
        description: expenseForm.description.trim(), category: expenseForm.category, amount: Number(expenseForm.amount) || 0,
        createdAt: serverTimestamp(), updatedAt: serverTimestamp()
      })
      setExpenseForm({ description: '', category: 'כללי', amount: '' })
      setModuleError('')
    } catch (err) {
      setModuleError(err?.message || 'לא הצלחנו להוסיף הוצאה.')
    }
  }

  async function uploadDocument(event) {
    event.preventDefault()
    if (!activeTrip || activeTripIsReadOnly || !documentFile) return
    if (documentFile.size > 20 * 1024 * 1024) {
      setModuleError('גודל הקובץ מוגבל ל־20MB.')
      return
    }

    setUploadingDocument(true)
    setModuleError('')
    let uploadedRef = null
    try {
      const fileName = safeFileName(documentFile.name)
      const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 9)}-${fileName}`
      const path = `trips/${activeTrip.id}/documents/${unique}`
      uploadedRef = storageRef(storage, path)
      await uploadBytes(uploadedRef, documentFile, {
        contentType: documentFile.type || 'application/octet-stream',
        customMetadata: { tripId: activeTrip.id, uploadedBy: user.uid }
      })
      const downloadURL = await getDownloadURL(uploadedRef)
      await addDoc(collection(db, 'trips', activeTrip.id, 'documents'), {
        name: fileName,
        category: documentCategory,
        storagePath: path,
        downloadURL,
        contentType: documentFile.type || 'application/octet-stream',
        size: documentFile.size,
        uploadedBy: user.uid,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp()
      })
      setDocumentFile(null)
      setDocumentCategory('אחר')
      const input = document.getElementById('trip-document-file')
      if (input) input.value = ''
    } catch (err) {
      if (uploadedRef) await deleteObject(uploadedRef).catch(() => null)
      setModuleError(err?.message || 'לא הצלחנו להעלות את המסמך.')
    } finally {
      setUploadingDocument(false)
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

  async function sendChat(event) {
    event.preventDefault()
    if (!activeTrip || activeTripIsReadOnly || !chatInput.trim() || chatBusy) return
    if (!AI_ENDPOINT) {
      setChatError('ממשק ה־Trip AI כבר מוכן, אך שירות ה־AI המאובטח עדיין לא הופעל בשרת.')
      return
    }

    const message = chatInput.trim()
    setChatInput('')
    setChatBusy(true)
    setChatError('')

    try {
      await addDoc(collection(db, 'trips', activeTrip.id, 'chatMessages'), {
        role: 'user', text: message, createdAt: serverTimestamp()
      })

      const token = await user.getIdToken()
      const response = await fetch(AI_ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify({ tripId: activeTrip.id, message })
      })
      const body = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(body?.error || 'שירות ה־AI לא זמין כרגע.')

      if (body?.reply) {
        await addDoc(collection(db, 'trips', activeTrip.id, 'chatMessages'), {
          role: 'assistant', text: body.reply, createdAt: serverTimestamp()
        })
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

  function renderGuide() {
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
          {(activeTrip.startDate || activeTrip.endDate) && (
            <div className="trip-date-banner">📅 {[activeTrip.startDate, activeTrip.endDate].filter(Boolean).join(' → ')}</div>
          )}
        </section>

        {activeTripIsReadOnly && (
          <div className="readonly-notice">הטיול שותף איתך לצפייה בלבד. אפשר להשתמש בכל המידע והמסמכים, אך רק מנהל הטיול יכול לשנות אותו.</div>
        )}

        <section className="dashboard-cards">
          <button className="feature-card" type="button" onClick={() => openSection('take')}>
            <span className="feature-icon">🧳</span><div><strong>רשימת לקחת</strong><small>{packedCount}/{takeItems.length} מוכנים</small></div><b>←</b>
          </button>
          <button className="feature-card" type="button" onClick={() => openSection('hotels')}>
            <span className="feature-icon">🏨</span><div><strong>מלונות</strong><small>{hotels.length ? `${hotels.length} הזמנות` : 'עדיין אין מלונות'}</small></div><b>←</b>
          </button>
          <button className="feature-card" type="button" onClick={() => openSection('cars')}>
            <span className="feature-icon">🚗</span><div><strong>השכרת רכב</strong><small>{cars.length ? `${cars.length} הזמנות` : 'עדיין אין רכבים'}</small></div><b>←</b>
          </button>
          <button className="feature-card" type="button" onClick={() => openSection('budget')}>
            <span className="feature-icon">💰</span><div><strong>תקציב והוצאות</strong><small>{formatMoney(spent, currency)} הוצאות</small></div><b>←</b>
          </button>
          <button className="feature-card" type="button" onClick={() => openSection('documents')}>
            <span className="feature-icon">📎</span><div><strong>כרטיסים ומסמכים</strong><small>{documents.length ? `${documents.length} קבצים` : 'אפשר להעלות הזמנות וכרטיסים'}</small></div><b>←</b>
          </button>
          {!activeTripIsReadOnly && (
            <button className="feature-card ai-card" type="button" onClick={() => openSection('chat')}>
              <span className="feature-icon">✨</span><div><strong>Trip AI</strong><small>לתכנן, להמליץ ולעדכן דרך שיחה</small></div><b>←</b>
            </button>
          )}
        </section>

        <section className="panel itinerary-panel">
          <div className="section-heading"><div><p className="eyebrow">המדריך</p><h2>מסלול הטיול</h2></div></div>
          <div className="coming-soon-row"><span>📅</span><div><strong>מסלול יומי חכם</strong><p>השלב הבא הוא ימים, שעות, מקומות וטיפים. ה־Trip AI יוכל לבנות ולערוך את המסלול לפי ההזמנות והמסמכים שהעליתם.</p></div></div>
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
            <input value={takeText} onChange={(event) => setTakeText(event.target.value)} placeholder="למשל: דרכונים, מטען, תרופות…" required />
            <button className="primary-button" type="submit">הוספה +</button>
          </form>
        )}
        <section className="panel list-panel">
          {takeItems.length ? takeItems.map((item) => (
            <div className={`checklist-row ${item.done ? 'done' : ''}`} key={item.id}>
              <button className="check-toggle" type="button" onClick={() => toggleTakeItem(item)} disabled={activeTripIsReadOnly}>{item.done ? '✓' : ''}</button>
              <span>{item.text}</span>
              {!activeTripIsReadOnly && <button className="icon-danger" type="button" onClick={() => removeModuleItem('takeItems', item.id, 'לא הצלחנו למחוק את הפריט.')}>🗑️</button>}
            </div>
          )) : <div className="empty-state compact-empty"><div className="empty-icon">🧳</div><h3>הרשימה עדיין ריקה</h3><p>הוסיפו את הדברים שלא תרצו לשכוח.</p></div>}
        </section>
      </>
    )
  }

  function renderHotels() {
    return (
      <>
        <SectionHeader eyebrow="הזמנות" title="מלונות" subtitle="כל מקומות הלינה של הטיול במקום אחד" />
        {!activeTripIsReadOnly && (
          <section className="panel form-panel">
            <form className="module-form" onSubmit={addHotel}>
              <label>שם המלון<input value={hotelForm.name} onChange={(e) => setHotelForm({ ...hotelForm, name: e.target.value })} required /></label>
              <label>עיר<input value={hotelForm.city} onChange={(e) => setHotelForm({ ...hotelForm, city: e.target.value })} /></label>
              <label>כניסה<input type="date" value={hotelForm.checkIn} onChange={(e) => setHotelForm({ ...hotelForm, checkIn: e.target.value, checkOut: hotelForm.checkOut && hotelForm.checkOut < e.target.value ? '' : hotelForm.checkOut })} /></label>
              <label>יציאה<input type="date" min={hotelForm.checkIn || undefined} value={hotelForm.checkOut} onChange={(e) => setHotelForm({ ...hotelForm, checkOut: e.target.value })} /></label>
              <label>מספר הזמנה<input value={hotelForm.bookingRef} onChange={(e) => setHotelForm({ ...hotelForm, bookingRef: e.target.value })} /></label>
              <label className="wide-field">הערות<textarea value={hotelForm.notes} onChange={(e) => setHotelForm({ ...hotelForm, notes: e.target.value })} rows="2" /></label>
              <button className="primary-button module-submit" type="submit">הוספת מלון +</button>
            </form>
          </section>
        )}
        <div className="record-grid">
          {hotels.length ? hotels.map((hotel) => (
            <article className="record-card" key={hotel.id}>
              <div className="record-head"><div><span>🏨</span><h3>{hotel.name}</h3></div>{!activeTripIsReadOnly && <button className="icon-danger" type="button" onClick={() => removeModuleItem('hotels', hotel.id, 'לא הצלחנו למחוק את המלון.')}>🗑️</button>}</div>
              {hotel.city && <p>📍 {hotel.city}</p>}
              {(hotel.checkIn || hotel.checkOut) && <p>📅 {[hotel.checkIn, hotel.checkOut].filter(Boolean).join(' → ')}</p>}
              {hotel.bookingRef && <p>🎟️ הזמנה: <strong>{hotel.bookingRef}</strong></p>}
              {hotel.notes && <p className="record-notes">{hotel.notes}</p>}
            </article>
          )) : <div className="empty-state record-empty"><div className="empty-icon">🏨</div><h3>אין עדיין מלונות</h3><p>הוסיפו את ההזמנות של הטיול.</p></div>}
        </div>
      </>
    )
  }

  function renderCars() {
    return (
      <>
        <SectionHeader eyebrow="תחבורה" title="השכרת רכב" subtitle="פרטי האיסוף, ההחזרה ומספרי ההזמנה" />
        {!activeTripIsReadOnly && (
          <section className="panel form-panel">
            <form className="module-form" onSubmit={addCar}>
              <label>חברת השכרה<input value={carForm.company} onChange={(e) => setCarForm({ ...carForm, company: e.target.value })} required /></label>
              <label>מקום איסוף<input value={carForm.pickup} onChange={(e) => setCarForm({ ...carForm, pickup: e.target.value })} /></label>
              <label>מקום החזרה<input value={carForm.dropoff} onChange={(e) => setCarForm({ ...carForm, dropoff: e.target.value })} /></label>
              <label>תאריך איסוף<input type="date" value={carForm.pickupDate} onChange={(e) => setCarForm({ ...carForm, pickupDate: e.target.value, dropoffDate: carForm.dropoffDate && carForm.dropoffDate < e.target.value ? '' : carForm.dropoffDate })} /></label>
              <label>תאריך החזרה<input type="date" min={carForm.pickupDate || undefined} value={carForm.dropoffDate} onChange={(e) => setCarForm({ ...carForm, dropoffDate: e.target.value })} /></label>
              <label>מספר הזמנה<input value={carForm.bookingRef} onChange={(e) => setCarForm({ ...carForm, bookingRef: e.target.value })} /></label>
              <label className="wide-field">הערות<textarea value={carForm.notes} onChange={(e) => setCarForm({ ...carForm, notes: e.target.value })} rows="2" /></label>
              <button className="primary-button module-submit" type="submit">הוספת רכב +</button>
            </form>
          </section>
        )}
        <div className="record-grid">
          {cars.length ? cars.map((car) => (
            <article className="record-card" key={car.id}>
              <div className="record-head"><div><span>🚗</span><h3>{car.company}</h3></div>{!activeTripIsReadOnly && <button className="icon-danger" type="button" onClick={() => removeModuleItem('cars', car.id, 'לא הצלחנו למחוק את ההשכרה.')}>🗑️</button>}</div>
              {(car.pickup || car.dropoff) && <p>📍 {[car.pickup, car.dropoff].filter(Boolean).join(' → ')}</p>}
              {(car.pickupDate || car.dropoffDate) && <p>📅 {[car.pickupDate, car.dropoffDate].filter(Boolean).join(' → ')}</p>}
              {car.bookingRef && <p>🎟️ הזמנה: <strong>{car.bookingRef}</strong></p>}
              {car.notes && <p className="record-notes">{car.notes}</p>}
            </article>
          )) : <div className="empty-state record-empty"><div className="empty-icon">🚗</div><h3>אין עדיין השכרת רכב</h3><p>אם צריך רכב בטיול, הפרטים יופיעו כאן.</p></div>}
        </div>
      </>
    )
  }

  function renderBudget() {
    return (
      <>
        <SectionHeader eyebrow="כספים" title="תקציב והוצאות" subtitle="מעקב פשוט אחר התקציב של הטיול" />
        <section className="budget-summary">
          <div><small>תקציב</small><strong>{formatMoney(savedBudget, currency)}</strong></div>
          <div><small>הוצאות</small><strong>{formatMoney(spent, currency)}</strong></div>
          <div className={remaining < 0 ? 'negative' : ''}><small>נותר</small><strong>{formatMoney(remaining, currency)}</strong></div>
        </section>
        {!activeTripIsReadOnly && (
          <section className="panel form-panel">
            <form className="budget-settings" onSubmit={saveBudget}>
              <label>תקציב כולל<input type="number" min="0" step="0.01" value={budgetLimit} onChange={(e) => setBudgetLimit(e.target.value)} /></label>
              <label>מטבע<select value={budgetCurrency} onChange={(e) => setBudgetCurrency(e.target.value)}>{CURRENCIES.map((item) => <option key={item} value={item}>{item}</option>)}</select></label>
              <button className="secondary-button" type="submit" disabled={savingBudget}>{savingBudget ? 'שומרים…' : 'שמירת תקציב'}</button>
            </form>
            <div className="form-divider" />
            <form className="expense-form" onSubmit={addExpense}>
              <label>תיאור<input value={expenseForm.description} onChange={(e) => setExpenseForm({ ...expenseForm, description: e.target.value })} placeholder="ארוחת ערב, רכבת, כרטיס…" required /></label>
              <label>קטגוריה<select value={expenseForm.category} onChange={(e) => setExpenseForm({ ...expenseForm, category: e.target.value })}><option>כללי</option><option>אוכל</option><option>תחבורה</option><option>מלון</option><option>אטרקציות</option><option>קניות</option></select></label>
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
              {!activeTripIsReadOnly && <button className="icon-danger" type="button" onClick={() => removeModuleItem('expenses', expense.id, 'לא הצלחנו למחוק את ההוצאה.')}>🗑️</button>}
            </div>
          )) : <div className="empty-state compact-empty"><div className="empty-icon">💰</div><h3>אין עדיין הוצאות</h3><p>הוצאות שתוסיפו יוצגו כאן.</p></div>}
        </section>
      </>
    )
  }

  function renderDocuments() {
    return (
      <>
        <SectionHeader eyebrow="המסמכים שלי" title="כרטיסים, הזמנות ותוכניות" subtitle="העלו PDF, תמונות וקבצי הזמנה. בהמשך ה־Trip AI ישתמש בהם כדי לבנות ולעדכן את המסלול." />
        {!activeTripIsReadOnly && (
          <form className="panel document-upload" onSubmit={uploadDocument}>
            <label className="file-picker">
              קובץ
              <input
                id="trip-document-file"
                type="file"
                accept=".pdf,.png,.jpg,.jpeg,.webp,.txt,.doc,.docx,.eml"
                onChange={(event) => setDocumentFile(event.target.files?.[0] || null)}
                required
              />
            </label>
            <label>
              סוג המסמך
              <select value={documentCategory} onChange={(event) => setDocumentCategory(event.target.value)}>
                {DOCUMENT_CATEGORIES.map((item) => <option key={item}>{item}</option>)}
              </select>
            </label>
            <button className="primary-button" type="submit" disabled={uploadingDocument || !documentFile}>
              {uploadingDocument ? 'מעלים…' : 'העלאת מסמך'}
            </button>
            <small className="upload-note">עד 20MB לקובץ. המסמך שייך לטיול הזה בלבד.</small>
          </form>
        )}

        <div className="document-list">
          {documents.length ? documents.map((item) => (
            <article className="document-card" key={item.id}>
              <div className="document-icon">📎</div>
              <div className="document-main">
                <strong>{item.name}</strong>
                <span>{item.category || 'אחר'} · {formatBytes(item.size)}</span>
              </div>
              <a className="document-open" href={item.downloadURL} target="_blank" rel="noreferrer">פתיחה</a>
              {!activeTripIsReadOnly && <button className="icon-danger" type="button" onClick={() => removeDocument(item)} aria-label="מחיקת מסמך">🗑️</button>}
            </article>
          )) : <div className="empty-state"><div className="empty-icon">📎</div><h3>אין עדיין מסמכים</h3><p>אפשר להעלות כרטיסי טיסה, אישורי מלון, כרטיסים לאטרקציות ותוכניות.</p></div>}
        </div>
      </>
    )
  }

  function renderChat() {
    if (activeTripIsReadOnly) return null
    return (
      <>
        <SectionHeader eyebrow="העוזר של הטיול" title="Trip AI" subtitle="שיחה אחת שמכירה את הטיול, ההזמנות והמסמכים — ומיועדת גם לבצע שינויים בטיול." />

        {!AI_ENDPOINT && (
          <div className="ai-setup-notice">
            <strong>✨ ממשק ה־Trip AI מוכן</strong>
            <p>החיבור למודל AI חייב לעבור דרך שרת מאובטח. הוא לא מופעל מהדפדפן כדי לא לחשוף מפתח API.</p>
          </div>
        )}

        <section className="chat-shell panel">
          <div className="chat-suggestions">
            {['בנה לי מסלול לפי ההזמנות שהעליתי', 'שפר את היום הראשון', 'הוסף את המלון שהעליתי למסלול', 'מה חסר לי לפני הטיסה?'].map((text) => (
              <button key={text} type="button" onClick={() => setChatInput(text)}>{text}</button>
            ))}
          </div>

          <div className="chat-messages">
            {chatMessages.length ? chatMessages.map((message) => (
              <div className={`chat-bubble ${message.role === 'assistant' ? 'assistant' : 'user'}`} key={message.id}>
                <small>{message.role === 'assistant' ? 'Trip AI' : 'אתה'}</small>
                <p>{message.text}</p>
              </div>
            )) : (
              <div className="chat-empty">
                <span>✨</span>
                <strong>מה תרצה לעשות בטיול?</strong>
                <p>אפשר לבקש המלצות, לבנות מסלול או לשנות פרטים — לאחר שהחיבור ל־AI יופעל.</p>
              </div>
            )}
          </div>

          {chatError && <div className="error-box">{chatError}</div>}
          <form className="chat-compose" onSubmit={sendChat}>
            <textarea value={chatInput} onChange={(event) => setChatInput(event.target.value)} rows="2" placeholder="לדוגמה: תבנה לי את יום 3 לפי המלון והכרטיסים שהעליתי…" />
            <button className="primary-button" type="submit" disabled={chatBusy || !chatInput.trim()}>{chatBusy ? 'חושב…' : 'שליחה'}</button>
          </form>
          <p className="chat-permission-note">🔒 רק מנהל הטיול יכול להשתמש ב־Trip AI. משתמשים בצפייה בלבד אינם רואים את השיחה ואינם יכולים להפעיל שינויים.</p>
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
            <div className={`connection-status ${online ? 'online' : 'offline'}`}>{online ? 'מחובר' : 'לא מחובר — השינויים יסונכרנו בהמשך'}</div>
          </div>
        </div>
        <button className="account-button" title={user.email || 'Account'} type="button" onClick={() => setMenuOpen(true)}>
          {user.photoURL ? <img src={user.photoURL} alt="" /> : <span>👤</span>}
        </button>
      </header>

      {menuOpen && <button className="menu-overlay" aria-label="סגירת תפריט" onClick={() => setMenuOpen(false)} />}

      <aside className={`side-menu ${menuOpen ? 'open' : ''}`} aria-hidden={!menuOpen}>
        <div className="menu-head">
          <div><strong>{activeTrip?.title || 'TripPlanner'}</strong><small>{user.email}</small></div>
          <button className="menu-close" type="button" onClick={() => setMenuOpen(false)}>✕</button>
        </div>

        {activeTrip && (
          <>
            <button className={screen === 'guide' ? 'active' : ''} type="button" onClick={() => openSection('guide')}>🧭 מסלול ומדריך</button>
            <button className={screen === 'take' ? 'active' : ''} type="button" onClick={() => openSection('take')}>🧳 רשימת לקחת</button>
            <button className={screen === 'hotels' ? 'active' : ''} type="button" onClick={() => openSection('hotels')}>🏨 מלונות</button>
            <button className={screen === 'cars' ? 'active' : ''} type="button" onClick={() => openSection('cars')}>🚗 השכרת רכב</button>
            <button className={screen === 'budget' ? 'active' : ''} type="button" onClick={() => openSection('budget')}>💰 תקציב והוצאות</button>
            <button className={screen === 'documents' ? 'active' : ''} type="button" onClick={() => openSection('documents')}>📎 מסמכים וכרטיסים</button>
            {!activeTripIsReadOnly && <button className={screen === 'chat' ? 'active' : ''} type="button" onClick={() => openSection('chat')}>✨ Trip AI<small>תכנון ועריכה דרך שיחה</small></button>}
          </>
        )}

        <div className="menu-divider" />
        <button className={screen === 'trips' ? 'active' : ''} type="button" onClick={showTrips}>🗂️ כל הטיולים<small>מעבר לטיול אחר</small></button>
        <button className={screen === 'new' ? 'active' : ''} type="button" onClick={showNewTrip}>＋ טיול חדש<small>יצירת טיול נוסף</small></button>

        {activeTrip && !activeTripIsReadOnly && (
          <>
            <button type="button" onClick={showShare}>👨‍👩‍👧‍👦 שיתוף הטיול<small>גישה למשפחה — צפייה בלבד</small></button>
            <button className="danger-menu-button" type="button" onClick={() => { setDeleteOpen(true); setMenuOpen(false) }}>🗑️ מחיקת הטיול</button>
          </>
        )}

        {activeTripIsReadOnly && <div className="menu-readonly">👁️ הטיול הנוכחי שותף איתך בצפייה בלבד</div>}

        <div className="menu-spacer" />
        <button className="logout-menu-button" type="button" onClick={() => signOut(auth)}>יציאה</button>
      </aside>

      <main className={`dashboard ${activeTrip ? 'with-bottom-nav' : ''}`}>
        {!ownedReady || !sharedReady || !initialTripResolved ? (
          <section className="panel centered-panel"><div className="empty-icon">🧭</div><p>טוענים את הטיולים…</p></section>
        ) : screen === 'trips' ? (
          <>
            <SectionHeader eyebrow="הטיולים שלי" title="כל הטיולים" subtitle="בחרו טיול כדי לפתוח אותו." />
            {error && <div className="error-box page-error">{error}</div>}
            {trips.length ? <div className="trip-grid">{trips.map((trip) => <TripCard key={trip.id} trip={trip} currentUserId={user.uid} onOpen={openTrip} />)}</div> : <div className="empty-state"><div className="empty-icon">🧭</div><h3>הטיול הראשון מתחיל כאן</h3><p>פתחו את התפריט ובחרו ״טיול חדש״.</p></div>}
          </>
        ) : screen === 'new' ? (
          <>
            <SectionHeader eyebrow="טיול חדש" title="לאן נוסעים?" subtitle="צרו טיול חדש ומיד תעברו אליו." />
            <section className="panel create-panel">
              <form className="trip-form" onSubmit={createTrip}>
                <label>שם הטיול<input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="טיול קיץ" required /></label>
                <label>יעד<input value={destination} onChange={(event) => setDestination(event.target.value)} placeholder="יפן" /></label>
                <label>תאריך התחלה<input type="date" value={startDate} onChange={(event) => handleStartDateChange(event.target.value)} /></label>
                <label>תאריך סיום<input type="date" value={endDate} min={startDate || undefined} onChange={(event) => setEndDate(event.target.value)} /></label>
                <button className="primary-button create-button" type="submit" disabled={creating}>{creating ? 'יוצרים את הטיול…' : 'יצירת טיול +'}</button>
              </form>
              {error && <div className="error-box form-error">{error}</div>}
            </section>
          </>
        ) : activeTrip ? (
          <>
            {moduleError && <div className="error-box page-error">{moduleError}</div>}
            {screen === 'guide' && renderGuide()}
            {screen === 'take' && renderTake()}
            {screen === 'hotels' && renderHotels()}
            {screen === 'cars' && renderCars()}
            {screen === 'budget' && renderBudget()}
            {screen === 'documents' && renderDocuments()}
            {screen === 'chat' && renderChat()}
          </>
        ) : <section className="panel centered-panel"><p>פותחים את הטיול…</p></section>}
      </main>

      {activeTrip && screen !== 'trips' && screen !== 'new' && (
        <nav className="bottom-nav" aria-label="ניווט ראשי">
          <button className={screen === 'guide' ? 'active' : ''} type="button" onClick={() => openSection('guide')}>🧭<span>מדריך</span></button>
          <button className={screen === 'take' ? 'active' : ''} type="button" onClick={() => openSection('take')}>🧳<span>לקחת</span></button>
          <button className={screen === 'documents' ? 'active' : ''} type="button" onClick={() => openSection('documents')}>📎<span>מסמכים</span></button>
          <button type="button" onClick={() => setMenuOpen(true)}>⋮<span>עוד</span></button>
        </nav>
      )}

      {shareOpen && activeTrip && !activeTripIsReadOnly && (
        <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setShareOpen(false) }}>
          <section className="modal-card" role="dialog" aria-modal="true" aria-label="שיתוף הטיול">
            <div className="modal-head"><div><p className="eyebrow">משפחה</p><h2>שיתוף הטיול</h2></div><button className="modal-close" type="button" onClick={() => setShareOpen(false)}>✕</button></div>
            <p className="muted">הוסיפו את כתובת האימייל שבה בן המשפחה משתמש ב־TripPlanner. הוא יקבל גישת צפייה בלבד.</p>
            <form className="share-form" onSubmit={addShare}>
              <label>אימייל של בן המשפחה<input type="email" value={shareEmail} onChange={(event) => setShareEmail(event.target.value)} placeholder="family@example.com" required /></label>
              <button className="primary-button" type="submit" disabled={sharing}>{sharing ? 'מעדכנים…' : 'שיתוף'}</button>
            </form>
            {shareError && <div className="error-box modal-error">{shareError}</div>}
            <div className="shared-users">
              <h3>משתמשים עם גישה</h3>
              {activeTripShares.length ? activeTripShares.map((email) => (
                <div className="shared-user-row" key={email}><div><strong>{email}</strong><span>צפייה בלבד</span></div><button className="remove-share" type="button" onClick={() => removeShare(email)} disabled={sharing}>הסרה</button></div>
              )) : <p className="muted">הטיול עדיין לא שותף עם משתמשים נוספים.</p>}
            </div>
          </section>
        </div>
      )}

      {deleteOpen && activeTrip && !activeTripIsReadOnly && (
        <div className="modal-backdrop" role="presentation">
          <section className="modal-card delete-modal" role="dialog" aria-modal="true" aria-label="מחיקת טיול">
            <div className="danger-icon">🗑️</div>
            <h2>למחוק את ״{activeTrip.title}״?</h2>
            <p>המחיקה תסיר את הטיול, המסמכים והמידע שנשמר בו. אי אפשר לבטל פעולה זו.</p>
            <div className="modal-actions"><button className="secondary-button" type="button" onClick={() => setDeleteOpen(false)} disabled={deletingTrip}>ביטול</button><button className="danger-button" type="button" onClick={deleteCurrentTrip} disabled={deletingTrip}>{deletingTrip ? 'מוחקים…' : 'כן, למחוק'}</button></div>
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
    return <main className="loading-page"><div className="brand-mark">TP</div><p>TripPlanner {APP_VERSION} נטען…</p></main>
  }

  return user ? <TripPlanner user={user} profile={profile} /> : <LoginScreen />
}
