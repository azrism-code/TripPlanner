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
  doc,
  getDoc,
  onSnapshot,
  query,
  serverTimestamp,
  setDoc,
  where
} from 'firebase/firestore'
import { auth, db, googleProvider } from './firebase.js'

const APP_VERSION = 'v0.2.0'

function normalizeEmail(value) {
  return (value || '').trim().toLowerCase()
}

function timestampValue(value) {
  if (!value) return 0
  if (typeof value.toMillis === 'function') return value.toMillis()
  if (typeof value.seconds === 'number') return value.seconds * 1000
  return 0
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
  const ref = doc(db, 'users', user.uid)
  const snapshot = await getDoc(ref)
  const common = {
    displayName: user.displayName || '',
    email: normalizeEmail(user.email),
    photoURL: user.photoURL || '',
    lastLoginAt: serverTimestamp()
  }

  if (!snapshot.exists()) {
    await setDoc(ref, {
      ...common,
      role: 'user',
      createdAt: serverTimestamp()
    })
  } else {
    await setDoc(ref, common, { merge: true })
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
        <p className="muted">כל הטיולים שלכם במקום אחד — גם בלי חיבור לרשת.</p>

        <button className="google-button" onClick={googleSignIn} disabled={busy}>
          <span className="google-g">G</span>
          המשך עם Google
        </button>

        <div className="divider"><span>או</span></div>

        <form onSubmit={emailSignIn} className="auth-form">
          <label>
            אימייל
            <input
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              autoComplete="email"
              required
            />
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

        <button
          className="link-button"
          onClick={() => setMode(mode === 'login' ? 'register' : 'login')}
          disabled={busy}
        >
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

  const [title, setTitle] = useState('')
  const [destination, setDestination] = useState('')
  const [startDate, setStartDate] = useState('')
  const [endDate, setEndDate] = useState('')
  const [creating, setCreating] = useState(false)

  const [shareEmail, setShareEmail] = useState('')
  const [sharing, setSharing] = useState(false)

  const [online, setOnline] = useState(navigator.onLine)
  const [error, setError] = useState('')
  const [shareError, setShareError] = useState('')

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
    return onSnapshot(
      tripsQuery,
      (snapshot) => {
        setOwnedTrips(snapshot.docs.map((item) => ({ id: item.id, ...item.data() })))
        setOwnedReady(true)
      },
      (err) => {
        setError(err?.message || 'לא הצלחנו לטעון את הטיולים.')
        setOwnedReady(true)
      }
    )
  }, [user.uid])

  useEffect(() => {
    if (!userEmail) {
      setSharedTrips([])
      setSharedReady(true)
      return undefined
    }

    const sharedQuery = query(
      collection(db, 'trips'),
      where('sharedWithEmails', 'array-contains', userEmail)
    )

    return onSnapshot(
      sharedQuery,
      (snapshot) => {
        setSharedTrips(snapshot.docs.map((item) => ({ id: item.id, ...item.data() })))
        setSharedReady(true)
      },
      (err) => {
        setError(err?.message || 'לא הצלחנו לטעון טיולים ששותפו איתך.')
        setSharedReady(true)
      }
    )
  }, [userEmail])

  const trips = useMemo(() => {
    const merged = new Map()
    ownedTrips.forEach((trip) => merged.set(trip.id, trip))
    sharedTrips.forEach((trip) => {
      if (!merged.has(trip.id)) merged.set(trip.id, trip)
    })

    return [...merged.values()].sort(
      (a, b) => timestampValue(b.updatedAt) - timestampValue(a.updatedAt)
    )
  }, [ownedTrips, sharedTrips])

  const activeTrip = useMemo(
    () => trips.find((trip) => trip.id === activeTripId) || null,
    [trips, activeTripId]
  )

  const firstName = useMemo(() => {
    const name = profile?.displayName || user.displayName || ''
    return name.split(' ')[0] || 'מטיילים'
  }, [profile, user.displayName])

  useEffect(() => {
    if (!ownedReady || !sharedReady || initialTripResolved) return

    if (trips.length === 0) {
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
    if (!initialTripResolved || !ownedReady || !sharedReady || !activeTripId) return
    if (trips.some((trip) => trip.id === activeTripId)) return

    if (trips.length > 0) {
      setActiveTripId(trips[0].id)
      setScreen('guide')
    } else {
      setActiveTripId(null)
      setScreen('new')
    }
  }, [trips, activeTripId, initialTripResolved, ownedReady, sharedReady])

  async function rememberTrip(tripId) {
    try {
      await setDoc(doc(db, 'users', user.uid), {
        lastTripId: tripId,
        lastTripViewedAt: serverTimestamp()
      }, { merge: true })
    } catch (err) {
      console.error('Could not remember last trip', err)
    }
  }

  function openTrip(trip) {
    setActiveTripId(trip.id)
    setScreen('guide')
    setMenuOpen(false)
    setShareOpen(false)
    setError('')
    rememberTrip(trip.id)
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
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp()
      })

      await rememberTrip(tripRef.id)
      setActiveTripId(tripRef.id)
      setScreen('guide')
      setMenuOpen(false)
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
    setMenuOpen(false)
    setError('')
  }

  function showNewTrip() {
    setScreen('new')
    setShareOpen(false)
    setMenuOpen(false)
    setError('')
  }

  function showGuide() {
    if (!activeTrip) return
    setScreen('guide')
    setShareOpen(false)
    setMenuOpen(false)
    rememberTrip(activeTrip.id)
  }

  function showShare() {
    if (!activeTrip || activeTrip.ownerId !== user.uid) return
    setShareOpen(true)
    setScreen('guide')
    setMenuOpen(false)
    setShareError('')
  }

  async function addShare(event) {
    event.preventDefault()
    if (!activeTrip || activeTrip.ownerId !== user.uid) return

    const emailToAdd = normalizeEmail(shareEmail)
    if (!emailToAdd) return

    if (emailToAdd === userEmail) {
      setShareError('אין צורך לשתף את הטיול עם עצמך.')
      return
    }

    const currentShares = Array.isArray(activeTrip.sharedWithEmails)
      ? activeTrip.sharedWithEmails.map(normalizeEmail).filter(Boolean)
      : []

    if (currentShares.includes(emailToAdd)) {
      setShareError('המשתמש הזה כבר מקבל גישה לטיול.')
      return
    }

    setSharing(true)
    setShareError('')

    try {
      await setDoc(doc(db, 'trips', activeTrip.id), {
        sharedWithEmails: [...currentShares, emailToAdd],
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
    if (!activeTrip || activeTrip.ownerId !== user.uid) return

    const currentShares = Array.isArray(activeTrip.sharedWithEmails)
      ? activeTrip.sharedWithEmails.map(normalizeEmail).filter(Boolean)
      : []

    setSharing(true)
    setShareError('')

    try {
      await setDoc(doc(db, 'trips', activeTrip.id), {
        sharedWithEmails: currentShares.filter((email) => email !== emailToRemove),
        updatedAt: serverTimestamp()
      }, { merge: true })
    } catch (err) {
      setShareError(err?.message || 'לא הצלחנו להסיר את השיתוף.')
    } finally {
      setSharing(false)
    }
  }

  const activeTripIsReadOnly = activeTrip && activeTrip.ownerId !== user.uid
  const activeTripShares = activeTrip && Array.isArray(activeTrip.sharedWithEmails)
    ? activeTrip.sharedWithEmails.map(normalizeEmail).filter(Boolean)
    : []

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="topbar-brand">
          <button
            className="menu-button"
            type="button"
            aria-label="פתיחת תפריט"
            onClick={() => setMenuOpen(true)}
          >
            ☰
          </button>
          <div>
            <div className="app-title">TripPlanner <small>{APP_VERSION}</small></div>
            <div className={`connection-status ${online ? 'online' : 'offline'}`}>
              {online ? 'מחובר' : 'לא מחובר — השינויים יסונכרנו בהמשך'}
            </div>
          </div>
        </div>

        <div className="account-area">
          {profile?.role === 'admin' && <span className="admin-badge">Admin</span>}
          <button className="avatar-button" title={user.email || 'Account'} type="button">
            {user.photoURL ? <img src={user.photoURL} alt="" /> : (firstName[0] || 'U').toUpperCase()}
          </button>
        </div>
      </header>

      {menuOpen && <button className="menu-overlay" aria-label="סגירת תפריט" onClick={() => setMenuOpen(false)} />}

      <aside className={`side-menu ${menuOpen ? 'open' : ''}`} aria-hidden={!menuOpen}>
        <div className="menu-head">
          <div>
            <strong>TripPlanner</strong>
            <small>{user.email}</small>
          </div>
          <button className="menu-close" type="button" onClick={() => setMenuOpen(false)}>✕</button>
        </div>

        {activeTrip && (
          <button className={screen === 'guide' && !shareOpen ? 'active' : ''} type="button" onClick={showGuide}>
            🧭 הטיול הנוכחי
            <small>{activeTrip.title}</small>
          </button>
        )}

        <button className={screen === 'trips' ? 'active' : ''} type="button" onClick={showTrips}>
          🗂️ כל הטיולים
          <small>מעבר לטיול אחר</small>
        </button>

        <button className={screen === 'new' ? 'active' : ''} type="button" onClick={showNewTrip}>
          ＋ טיול חדש
          <small>יצירת טיול נוסף</small>
        </button>

        {activeTrip && !activeTripIsReadOnly && (
          <button className={shareOpen ? 'active' : ''} type="button" onClick={showShare}>
            👨‍👩‍👧‍👦 שיתוף הטיול
            <small>גישה למשפחה — צפייה בלבד</small>
          </button>
        )}

        {activeTripIsReadOnly && (
          <div className="menu-readonly">👁️ הטיול הנוכחי שותף איתך בצפייה בלבד</div>
        )}

        <div className="menu-spacer" />
        <button className="logout-menu-button" type="button" onClick={() => signOut(auth)}>
          יציאה
        </button>
      </aside>

      <main className="dashboard">
        {!ownedReady || !sharedReady || !initialTripResolved ? (
          <section className="panel centered-panel">
            <div className="empty-icon">🧭</div>
            <p>טוענים את הטיולים…</p>
          </section>
        ) : screen === 'guide' ? (
          activeTrip ? (
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
                  <div className="trip-date-banner">
                    📅 {[activeTrip.startDate, activeTrip.endDate].filter(Boolean).join(' → ')}
                  </div>
                )}
              </section>

              {activeTripIsReadOnly && (
                <div className="readonly-notice">
                  הטיול שותף איתך על ידי מנהל הטיול. אפשר לצפות בכל המידע, ללא אפשרות לשנות אותו.
                </div>
              )}

              <section className="panel guide-panel">
                <div className="section-heading">
                  <div>
                    <p className="eyebrow">המדריך שלי</p>
                    <h2>מדריך הטיול</h2>
                  </div>
                </div>
                <div className="guide-grid">
                  <div className="guide-card">
                    <span>📅</span>
                    <strong>מסלול יומי</strong>
                    <p>התכנון היומי של הטיול יופיע כאן.</p>
                  </div>
                  <div className="guide-card">
                    <span>📍</span>
                    <strong>מקומות</strong>
                    <p>המקומות והאטרקציות של הטיול.</p>
                  </div>
                  <div className="guide-card">
                    <span>🎟️</span>
                    <strong>הזמנות</strong>
                    <p>מלונות, טיסות והזמנות במקום אחד.</p>
                  </div>
                </div>
              </section>

              {shareOpen && !activeTripIsReadOnly && (
                <section className="panel share-panel">
                  <div className="section-heading">
                    <div>
                      <p className="eyebrow">משפחה</p>
                      <h2>שיתוף הטיול</h2>
                    </div>
                    <button className="text-button" type="button" onClick={() => setShareOpen(false)}>סגירה</button>
                  </div>

                  <p className="muted">
                    הוסיפו את כתובת האימייל שבה בן המשפחה משתמש ב־TripPlanner. הוא יקבל גישת צפייה בלבד.
                  </p>

                  <form className="share-form" onSubmit={addShare}>
                    <label>
                      אימייל של בן המשפחה
                      <input
                        type="email"
                        value={shareEmail}
                        onChange={(event) => setShareEmail(event.target.value)}
                        placeholder="family@example.com"
                        required
                      />
                    </label>
                    <button className="primary-button" type="submit" disabled={sharing}>
                      {sharing ? 'מעדכנים…' : 'שיתוף'}
                    </button>
                  </form>

                  {shareError && <div className="error-box">{shareError}</div>}

                  <div className="shared-users">
                    <h3>משתמשים עם גישה</h3>
                    {activeTripShares.length > 0 ? activeTripShares.map((email) => (
                      <div className="shared-user-row" key={email}>
                        <div>
                          <strong>{email}</strong>
                          <span>צפייה בלבד</span>
                        </div>
                        <button
                          className="remove-share"
                          type="button"
                          onClick={() => removeShare(email)}
                          disabled={sharing}
                        >
                          הסרה
                        </button>
                      </div>
                    )) : (
                      <p className="muted">הטיול עדיין לא שותף עם משתמשים נוספים.</p>
                    )}
                  </div>
                </section>
              )}
            </>
          ) : (
            <section className="panel centered-panel">
              <p>פותחים את הטיול…</p>
            </section>
          )
        ) : screen === 'trips' ? (
          <>
            <section className="hero compact-hero">
              <p className="eyebrow">הטיולים שלי</p>
              <h1>כל הטיולים</h1>
              <p>בחרו טיול כדי לפתוח את המדריך שלו.</p>
            </section>

            {error && <div className="error-box page-error">{error}</div>}

            {trips.length > 0 ? (
              <div className="trip-grid">
                {trips.map((trip) => (
                  <TripCard
                    key={trip.id}
                    trip={trip}
                    currentUserId={user.uid}
                    onOpen={openTrip}
                  />
                ))}
              </div>
            ) : (
              <div className="empty-state">
                <div className="empty-icon">🧭</div>
                <h3>הטיול הראשון מתחיל כאן</h3>
                <p>עדיין אין טיולים. פתחו את התפריט ובחרו ״טיול חדש״.</p>
              </div>
            )}
          </>
        ) : (
          <>
            <section className="hero compact-hero">
              <p className="eyebrow">טיול חדש</p>
              <h1>לאן נוסעים?</h1>
              <p>צרו טיול חדש ומיד תעברו למדריך שלו.</p>
            </section>

            <section className="panel create-panel">
              <form className="trip-form" onSubmit={createTrip}>
                <label>
                  שם הטיול
                  <input
                    value={title}
                    onChange={(event) => setTitle(event.target.value)}
                    placeholder="טיול קיץ"
                    required
                  />
                </label>
                <label>
                  יעד
                  <input
                    value={destination}
                    onChange={(event) => setDestination(event.target.value)}
                    placeholder="יפן"
                  />
                </label>
                <label>
                  תאריך התחלה
                  <input
                    type="date"
                    value={startDate}
                    onChange={(event) => handleStartDateChange(event.target.value)}
                  />
                </label>
                <label>
                  תאריך סיום
                  <input
                    type="date"
                    value={endDate}
                    min={startDate || undefined}
                    onChange={(event) => setEndDate(event.target.value)}
                  />
                </label>
                <button className="primary-button create-button" type="submit" disabled={creating}>
                  {creating ? 'יוצרים את הטיול…' : 'יצירת טיול +'}
                </button>
              </form>
              {error && <div className="error-box form-error">{error}</div>}
            </section>
          </>
        )}

        {profile?.role === 'admin' && screen === 'trips' && (
          <section className="panel admin-panel">
            <p className="eyebrow">ניהול</p>
            <h2>גישת מנהל פעילה</h2>
            <p>ניהול משתמשים וצפייה מערכתית יתווספו בהמשך.</p>
          </section>
        )}
      </main>
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

      unsubscribeProfile = onSnapshot(
        doc(db, 'users', nextUser.uid),
        (snapshot) => {
          setProfile(snapshot.exists() ? snapshot.data() : null)
          setLoading(false)
        },
        () => setLoading(false)
      )
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
