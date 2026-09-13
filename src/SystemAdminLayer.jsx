import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { onAuthStateChanged } from 'firebase/auth'
import { doc, onSnapshot } from 'firebase/firestore'
import { auth, db } from './firebase.js'

const ADMIN_ENDPOINT = import.meta.env.VITE_FAMILY_ADMIN_ENDPOINT || 'https://europe-west1-tripplanner-94835.cloudfunctions.net/familyAdminApi'

async function callAdminApi(user, body) {
  const token = await user.getIdToken()
  const response = await fetch(ADMIN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body)
  })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) {
    const error = new Error(payload?.error || 'הפעולה נכשלה.')
    error.code = payload?.code || ''
    throw error
  }
  return payload
}

function inviteUrl(inviteId) {
  const url = new URL(window.location.origin)
  url.searchParams.set('invite', inviteId)
  return url.toString()
}

function invitationMessage(invite) {
  const name = invite.displayName ? ` ${invite.displayName}` : ''
  return `היי${name},\nהזמנתי אותך ל-TripPlanner כמנהל/ת של ${invite.familyName}.\nפתח/י את הקישור והתחבר/י עם ${invite.email}. לאחר הכניסה ההרשאה תופעל אוטומטית.\n\n${inviteUrl(invite.id)}`
}

async function copyText(text) {
  if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(text)
  const area = document.createElement('textarea')
  area.value = text
  area.style.position = 'fixed'
  area.style.opacity = '0'
  document.body.appendChild(area)
  area.select()
  document.execCommand('copy')
  area.remove()
}

function statusLabel(status) {
  if (status === 'accepted') return 'פעיל'
  if (status === 'revoked') return 'בוטל'
  return 'ממתין'
}

function SystemAdminLayer() {
  const [user, setUser] = useState(auth.currentUser)
  const [profile, setProfile] = useState(null)
  const [sideMenu, setSideMenu] = useState(null)
  const [open, setOpen] = useState(false)
  const [overview, setOverview] = useState({ families: [], invites: [] })
  const [loading, setLoading] = useState(false)
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [latestInvite, setLatestInvite] = useState(null)
  const [form, setForm] = useState({ familyName: '', displayName: '', email: '' })

  const isAdmin = profile?.role === 'admin'

  useEffect(() => onAuthStateChanged(auth, setUser), [])

  useEffect(() => {
    if (!user) {
      setProfile(null)
      return undefined
    }
    return onSnapshot(doc(db, 'users', user.uid), (snapshot) => setProfile(snapshot.exists() ? snapshot.data() : null))
  }, [user])

  useEffect(() => {
    let frame = 0
    let stopped = false
    const refresh = () => setSideMenu(document.querySelector('aside.side-menu'))
    const observer = new MutationObserver(() => {
      if (frame || stopped) return
      frame = requestAnimationFrame(() => {
        frame = 0
        refresh()
      })
    })
    refresh()
    observer.observe(document.body, { childList: true, subtree: true })
    return () => {
      stopped = true
      observer.disconnect()
      if (frame) cancelAnimationFrame(frame)
    }
  }, [])

  async function loadOverview() {
    if (!user || !isAdmin) return
    setLoading(true)
    setError('')
    try {
      const data = await callAdminApi(user, { action: 'overview' })
      setOverview(data)
    } catch (err) {
      setError(err?.message || 'לא הצלחנו לטעון את ניהול המשפחות.')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (open && isAdmin) loadOverview()
  }, [open, isAdmin])

  async function createInvite(event) {
    event.preventDefault()
    if (!user || !isAdmin || creating) return
    setCreating(true)
    setError('')
    setNotice('')
    setLatestInvite(null)
    try {
      const result = await callAdminApi(user, { action: 'createFamilyAdminInvite', ...form })
      if (result.directAssigned) {
        setNotice('המשתמש כבר קיים ב-TripPlanner ולכן צורף מיד כמנהל המשפחה. אין צורך באישור או בקישור הזמנה.')
      } else {
        setLatestInvite(result.invite)
        setNotice(result.reused ? 'כבר קיימת הזמנה פעילה למשתמש הזה. הצגתי את הקישור הקיים.' : 'המשתמש עדיין לא קיים במערכת. נוצר קישור הזמנה שאפשר להעתיק או לשתף.')
      }
      setForm((current) => ({ ...current, displayName: '', email: '' }))
      await loadOverview()
    } catch (err) {
      setError(err?.message || 'הוספת מנהל המשפחה נכשלה.')
    } finally {
      setCreating(false)
    }
  }

  async function copyInvite(invite, mode = 'url') {
    const text = mode === 'message' ? invitationMessage(invite) : inviteUrl(invite.id)
    await copyText(text)
    setNotice(mode === 'message' ? 'ההודעה הועתקה.' : 'הקישור הועתק.')
  }

  async function nativeShare(invite) {
    const url = inviteUrl(invite.id)
    const text = invitationMessage(invite)
    if (navigator.share) {
      await navigator.share({ title: `TripPlanner - ${invite.familyName}`, text, url })
    } else {
      await copyText(text)
      setNotice('שיתוף מערכת אינו זמין כאן, לכן ההודעה הועתקה.')
    }
  }

  async function revoke(invite) {
    if (!user || invite.status !== 'pending') return
    setError('')
    try {
      await callAdminApi(user, { action: 'revokeInvite', inviteId: invite.id })
      if (latestInvite?.id === invite.id) setLatestInvite(null)
      setNotice('ההזמנה בוטלה.')
      await loadOverview()
    } catch (err) {
      setError(err?.message || 'לא הצלחנו לבטל את ההזמנה.')
    }
  }

  const inviteRows = useMemo(() => overview.invites || [], [overview])

  if (!isAdmin) return null

  return (
    <>
      {sideMenu && createPortal(
        <button className="tp-admin-menu-button" type="button" onClick={() => { setOpen(true); document.querySelector('.menu-close')?.click() }}>
          🛡️ ניהול משפחות
          <small>מנהלי משפחה והזמנות</small>
        </button>,
        sideMenu
      )}

      {open && createPortal(
        <div className="tp-admin-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setOpen(false) }}>
          <section className="tp-admin-panel" role="dialog" aria-modal="true" aria-label="ניהול משפחות">
            <header className="tp-admin-head">
              <div>
                <p className="eyebrow">SYSTEM ADMIN</p>
                <h2>ניהול משפחות</h2>
                <p>משתמש שכבר קיים ב-TripPlanner יצורף מיד כמנהל משפחה. רק משתמש חדש יקבל קישור הזמנה לאישור אחרי ההתחברות.</p>
              </div>
              <button className="modal-close" type="button" onClick={() => setOpen(false)}>✕</button>
            </header>

            <form className="tp-admin-form" onSubmit={createInvite}>
              <h3>הוסף מנהל משפחה</h3>
              <label>שם המשפחה / הקבוצה<input value={form.familyName} onChange={(e) => setForm({ ...form, familyName: e.target.value })} placeholder="לדוגמה: משפחת כהן" required /></label>
              <div className="tp-admin-form-grid">
                <label>שם מנהל המשפחה<input value={form.displayName} onChange={(e) => setForm({ ...form, displayName: e.target.value })} placeholder="אופציונלי" /></label>
                <label>אימייל<input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} placeholder="name@example.com" required /></label>
              </div>
              <button className="primary-button" type="submit" disabled={creating}>{creating ? 'מוסיף…' : 'הוסף מנהל משפחה'}</button>
              <small>למשתמש קיים אין צורך באישור. אם המשתמש עדיין לא קיים, ייווצר קישור הזמנה לשיתוף.</small>
            </form>

            {error && <div className="error-box">{error}</div>}
            {notice && <div className="tp-admin-notice">{notice}</div>}

            {latestInvite && latestInvite.status === 'pending' && (
              <section className="tp-invite-result">
                <strong>הקישור מוכן לשיתוף</strong>
                <span>{latestInvite.familyName} · {latestInvite.email}</span>
                <code dir="ltr">{inviteUrl(latestInvite.id)}</code>
                <div className="tp-share-actions">
                  <button type="button" onClick={() => copyInvite(latestInvite)}>🔗 העתק קישור</button>
                  <button type="button" onClick={() => copyInvite(latestInvite, 'message')}>📋 העתק הודעה</button>
                  <button type="button" onClick={() => nativeShare(latestInvite)}>📤 שתף</button>
                </div>
              </section>
            )}

            <section className="tp-admin-list">
              <div className="tp-admin-list-head">
                <div><h3>משפחות ומנהלים</h3><small>{overview.families?.length || 0} משפחות · {inviteRows.length} מנהלים/הזמנות</small></div>
                <button className="secondary-button" type="button" onClick={loadOverview} disabled={loading}>{loading ? 'טוען…' : 'רענון'}</button>
              </div>
              {!loading && !inviteRows.length && <p className="muted">עדיין לא הוגדרו מנהלי משפחות.</p>}
              <div className="tp-invite-list">
                {inviteRows.map((invite) => (
                  <article className="tp-invite-row" key={invite.id}>
                    <div>
                      <div className="tp-invite-title"><strong>{invite.familyName}</strong><span className={`tp-invite-status ${invite.status}`}>{statusLabel(invite.status)}</span></div>
                      <p>{invite.displayName || 'מנהל משפחה'} · {invite.email}</p>
                    </div>
                    <div className="tp-invite-row-actions">
                      {invite.status === 'pending' && <button type="button" onClick={() => copyInvite(invite)}>העתק קישור</button>}
                      {invite.status === 'pending' && <button type="button" onClick={() => nativeShare(invite)}>שתף</button>}
                      {invite.status === 'pending' && <button className="danger" type="button" onClick={() => revoke(invite)}>בטל</button>}
                    </div>
                  </article>
                ))}
              </div>
            </section>
          </section>
        </div>,
        document.body
      )}
    </>
  )
}

export function InviteAcceptanceLayer() {
  const token = useMemo(() => new URL(window.location.href).searchParams.get('invite') || '', [])
  const [user, setUser] = useState(auth.currentUser)
  const [state, setState] = useState(token ? 'waiting' : 'none')
  const [message, setMessage] = useState('')

  useEffect(() => onAuthStateChanged(auth, setUser), [])

  useEffect(() => {
    if (!token || !user || state !== 'waiting') return
    let cancelled = false
    setState('accepting')
    callAdminApi(user, { action: 'acceptInvite', inviteId: token })
      .then((result) => {
        if (cancelled) return
        setMessage(`הצטרפת בהצלחה כמנהל/ת של ${result.familyName || 'המשפחה'}.`)
        setState('success')
        const url = new URL(window.location.href)
        url.searchParams.delete('invite')
        window.history.replaceState({}, '', `${url.pathname}${url.search}${url.hash}`)
      })
      .catch((err) => {
        if (cancelled) return
        setMessage(err?.code === 'email_mismatch' ? `${err.message}. יש להתחבר עם כתובת האימייל שאליה נשלחה ההזמנה.` : err?.message || 'לא הצלחנו לאשר את ההזמנה.')
        setState('error')
      })
    return () => { cancelled = true }
  }, [token, user, state])

  if (!token || state === 'none') return null

  if (!user) {
    return createPortal(
      <div className="tp-invite-banner">🔗 פתחת הזמנה ל-TripPlanner. התחבר/י עם כתובת האימייל שאליה נשלחה ההזמנה.</div>,
      document.body
    )
  }

  return createPortal(
    <div className={`tp-invite-banner ${state === 'error' ? 'error' : state === 'success' ? 'success' : ''}`}>
      {state === 'accepting' ? 'מאשר את ההזמנה…' : message}
      {(state === 'success' || state === 'error') && <button type="button" onClick={() => setState('none')}>✕</button>}
    </div>,
    document.body
  )
}

export default SystemAdminLayer
