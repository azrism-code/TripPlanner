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

function timestampValue(value) {
  if (!value) return 0
  if (typeof value.toMillis === 'function') return value.toMillis()
  if (typeof value.seconds === 'number') return value.seconds * 1000
  return 0
}

function authErrorMessage(error) {
  switch (error?.code) {
    case 'auth/operation-not-allowed':
      return 'Email and password sign-in is not enabled yet.'
    case 'auth/email-already-in-use':
      return 'An account already exists for this email. Try signing in instead.'
    case 'auth/invalid-credential':
      return 'The email or password is incorrect.'
    case 'auth/weak-password':
      return 'Use a password with at least 6 characters.'
    default:
      return error?.message || 'Sign-in failed.'
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
      setError(err?.message || 'Google sign-in failed.')
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
        <h1>TripPlanner</h1>
        <p className="muted">Your trips, available everywhere — even offline.</p>

        <button className="google-button" onClick={googleSignIn} disabled={busy}>
          <span className="google-g">G</span>
          Continue with Google
        </button>

        <div className="divider"><span>or</span></div>

        <form onSubmit={emailSignIn} className="auth-form">
          <label>
            Email
            <input
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              autoComplete="email"
              required
            />
          </label>
          <label>
            Password
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
            {busy ? 'Please wait…' : mode === 'register' ? 'Create account' : 'Sign in'}
          </button>
        </form>

        <button
          className="link-button"
          onClick={() => setMode(mode === 'login' ? 'register' : 'login')}
          disabled={busy}
        >
          {mode === 'login' ? 'New to TripPlanner? Create an account' : 'Already have an account? Sign in'}
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
      (err) => setError(err?.message || 'Could not load trips.')
    )
  }, [user.uid])

  const firstName = useMemo(() => {
    const name = profile?.displayName || user.displayName || ''
    return name.split(' ')[0] || 'Traveler'
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
      setError(err?.message || 'Could not create the trip.')
    } finally {
      setCreating(false)
    }
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <div>
          <div className="app-title">TripPlanner</div>
          <div className={`connection-status ${online ? 'online' : 'offline'}`}>
            {online ? 'Online' : 'Offline — changes will sync later'}
          </div>
        </div>
        <div className="account-area">
          {profile?.role === 'admin' && <span className="admin-badge">Admin</span>}
          <button className="avatar-button" title={user.email || 'Account'}>
            {user.photoURL ? <img src={user.photoURL} alt="" /> : (firstName[0] || 'U').toUpperCase()}
          </button>
          <button className="secondary-button" onClick={() => signOut(auth)}>Sign out</button>
        </div>
      </header>

      <main className="dashboard">
        <section className="hero">
          <p className="eyebrow">MY TRIPS</p>
          <h1>Hello, {firstName}</h1>
          <p>Plan a new trip or continue working on one you already started.</p>
        </section>

        <section className="panel create-panel">
          <div className="section-heading">
            <div>
              <p className="eyebrow">NEW</p>
              <h2>Create a trip</h2>
            </div>
          </div>
          <form className="trip-form" onSubmit={createTrip}>
            <label>
              Trip name
              <input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Japan 2027" required />
            </label>
            <label>
              Destination
              <input value={destination} onChange={(event) => setDestination(event.target.value)} placeholder="Tokyo, Japan" />
            </label>
            <label>
              Start date
              <input type="date" value={startDate} onChange={(event) => setStartDate(event.target.value)} />
            </label>
            <label>
              End date
              <input type="date" value={endDate} onChange={(event) => setEndDate(event.target.value)} />
            </label>
            <button className="primary-button create-button" type="submit" disabled={creating}>
              {creating ? 'Creating…' : '+ Create trip'}
            </button>
          </form>
          {error && <div className="error-box">{error}</div>}
        </section>

        <section>
          <div className="section-heading">
            <div>
              <p className="eyebrow">YOUR LIBRARY</p>
              <h2>{trips.length ? `${trips.length} ${trips.length === 1 ? 'trip' : 'trips'}` : 'No trips yet'}</h2>
            </div>
          </div>
          {trips.length > 0 ? (
            <div className="trip-grid">{trips.map((trip) => <TripCard key={trip.id} trip={trip} />)}</div>
          ) : (
            <div className="empty-state">
              <div className="empty-icon">🧭</div>
              <h3>Your first trip starts here</h3>
              <p>Create a trip above. It will belong only to your account.</p>
            </div>
          )}
        </section>

        {profile?.role === 'admin' && (
          <section className="panel admin-panel">
            <p className="eyebrow">ADMIN</p>
            <h2>Admin access is enabled</h2>
            <p>User management and global trip oversight will be added in the next build stage.</p>
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
        <p>Loading TripPlanner…</p>
      </main>
    )
  }

  return user ? <Dashboard user={user} profile={profile} /> : <LoginScreen />
}
