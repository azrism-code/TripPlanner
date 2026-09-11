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

const APP_VERSION = 'v0.1.0'

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
    email: user.email || '',
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

function TripCard({ trip }) {
  const dates = [trip.startDate, trip.endDate].filter(Boolean).join(' → ')
  return (
    <article className="trip-card">
      <div className="trip-cover">✈️</div>
      <div className="trip-content">
        <h3>{trip.title}</h3>
        {trip.destination && <p>{trip.destination}</p>}
        {dates && <p className="trip-dates">{dates}</p>}
      </div>
    </article>
  )
}

function Dashboard({ user, profile }) {
  const [trips, setTrips] = useState([])
  const [title, setTitle] = useState('')
  const [destination, setDestination] = useState('')
  const [startDate, setStartDate] = useState('')
  const [endDate, setEndDate] = useState('')
  const [creating, setCreating] = useState(false)
  const [online, setOnline] = useState(navigator.onLine)
  const [error, setError] = useState('')

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
        const rows = snapshot.docs.map((item) => ({ id: item.id, ...item.data() }))
        rows.sort((a, b) => timestampValue(b.updatedAt) - timestampValue(a.updatedAt))
        setTrips(rows)
      },
      (err) => setError(err?.message || 'לא הצלחנו לטעון את הטיולים.')
    )
  }, [user.uid])

  const firstName = useMemo(() => {
    const name = profile?.displayName || user.displayName || ''
    return name.split(' ')[0] || 'מטיילים'
  }, [profile, user.displayName])

  async function createTrip(event) {
    event.preventDefault()
    if (!title.trim()) return
    setCreating(true)
    setError('')
    try {
      await addDoc(collection(db, 'trips'), {
        ownerId: user.uid,
        title: title.trim(),
        destination: destination.trim(),
        startDate,
        endDate,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp()
      })
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

  return (
    <div className="app-shell">
      <header className="topbar">
        <div>
          <div className="app-title">TripPlanner <small>{APP_VERSION}</small></div>
          <div className={`connection-status ${online ? 'online' : 'offline'}`}>
            {online ? 'מחובר' : 'לא מחובר — השינויים יסונכרנו בהמשך'}
          </div>
        </div>
        <div className="account-area">
          {profile?.role === 'admin' && <span className="admin-badge">Admin</span>}
          <button className="avatar-button" title={user.email || 'Account'}>
            {user.photoURL ? <img src={user.photoURL} alt="" /> : (firstName[0] || 'U').toUpperCase()}
          </button>
          <button className="secondary-button" onClick={() => signOut(auth)}>יציאה</button>
        </div>
      </header>

      <main className="dashboard" id="trips">
        <section className="hero">
          <p className="eyebrow">הטיולים שלי</p>
          <h1>היי, {firstName}</h1>
          <p>מתכננים טיול חדש או ממשיכים בדיוק מהמקום שבו עצרתם.</p>
        </section>

        <section className="panel create-panel" id="new-trip">
          <div className="section-heading">
            <div>
              <p className="eyebrow">טיול חדש</p>
              <h2>לאן נוסעים?</h2>
            </div>
          </div>
          <form className="trip-form" onSubmit={createTrip}>
            <label>
              שם הטיול
              <input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="טיול קיץ" required />
            </label>
            <label>
              יעד
              <input value={destination} onChange={(event) => setDestination(event.target.value)} placeholder="תל אביב" />
            </label>
            <label>
              תאריך התחלה
              <input type="date" value={startDate} onChange={(event) => setStartDate(event.target.value)} />
            </label>
            <label>
              תאריך סיום
              <input type="date" value={endDate} onChange={(event) => setEndDate(event.target.value)} />
            </label>
            <button className="primary-button create-button" type="submit" disabled={creating}>
              {creating ? 'יוצרים את הטיול…' : 'יצירת טיול +'}
            </button>
          </form>
          {error && <div className="error-box">{error}</div>}
        </section>

        <section>
          <div className="section-heading">
            <div>
              <p className="eyebrow">הטיולים שלכם</p>
              <h2>{trips.length ? `${trips.length} ${trips.length === 1 ? 'טיול' : 'טיולים'}` : 'עדיין אין טיולים'}</h2>
            </div>
          </div>
          {trips.length > 0 ? (
            <div className="trip-grid">{trips.map((trip) => <TripCard key={trip.id} trip={trip} />)}</div>
          ) : (
            <div className="empty-state">
              <div className="empty-icon">🧭</div>
              <h3>הטיול הראשון מתחיל כאן</h3>
              <p>צרו טיול חדש. רק אתם תוכלו לראות ולערוך אותו.</p>
            </div>
          )}
        </section>

        {profile?.role === 'admin' && (
          <section className="panel admin-panel">
            <p className="eyebrow">ניהול</p>
            <h2>גישת מנהל פעילה</h2>
            <p>ניהול משתמשים וצפייה בכל הטיולים יתווספו בשלב הבא.</p>
          </section>
        )}
      </main>
      <nav className="bottom-nav" aria-label="ניווט ראשי">
        <a href="#trips"><span>🧭</span>הטיולים שלי</a>
        <a className="bottom-nav-primary" href="#new-trip"><span>＋</span>טיול חדש</a>
      </nav>
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

  return user ? <Dashboard user={user} profile={profile} /> : <LoginScreen />
}
