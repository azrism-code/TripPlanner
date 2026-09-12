import { useEffect } from 'react'
import LegacyApp from './AppV05.jsx'

const APP_VERSION = 'v0.6.6'

function openFlightsSection() {
  const buttons = [...document.querySelectorAll('aside.side-menu button, nav button, .bottom-nav button')]
  const target = buttons.find((button) => button.textContent?.includes('טיסות'))
  if (target) target.click()
}

function flightNumbersFrom(text = '') {
  const matches = text.toUpperCase().match(/\b[A-Z]{1,3}\s?\d{2,4}\b/g) || []
  return [...new Set(matches.map((value) => value.replace(/\s+/g, '')))]
}

function compactItineraryFlights() {
  document.querySelectorAll('.app-title small, .auth-card h1 small').forEach((node) => {
    node.textContent = APP_VERSION
  })

  const seenFlights = new Set()
  document.querySelectorAll('.timeline-item').forEach((row) => {
    const typeNode = row.querySelector('.timeline-type')
    const type = (typeNode?.textContent || '').trim().toLowerCase()

    if (type === 'flight-arrival') {
      row.classList.add('tp-hide-legacy-flight-arrival')
      return
    }
    if (type !== 'flight' && type !== 'airport-arrival') return

    row.classList.add('tp-flight-compact')
    if (type !== 'flight') return

    const title = row.querySelector('.timeline-card h3')
    const route = row.querySelector('.timeline-card p')
    const time = row.querySelector('.timeline-time')?.textContent || ''
    const numbers = flightNumbersFrom(title?.textContent || '')
    const flightIdentity = `${numbers.join('/')}|${time}|${route?.textContent || ''}`
    if (seenFlights.has(flightIdentity)) {
      row.classList.add('tp-hide-duplicate-flight')
      return
    }
    seenFlights.add(flightIdentity)

    if (title && numbers.length) title.textContent = `✈️ ${numbers.join(' / ')}`
    const card = row.querySelector('.timeline-card')
    if (card && !card.querySelector('.tp-flight-details-link')) {
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'tp-flight-details-link'
      button.textContent = 'פרטי הטיסה ›'
      button.addEventListener('click', openFlightsSection)
      card.appendChild(button)
    }
  })
}

function compactFlightCards() {
  const seen = new Set()
  document.querySelectorAll('.record-card.flight-card').forEach((card) => {
    const title = card.querySelector('h3')?.textContent || ''
    const route = card.querySelector('.flight-route')?.textContent || ''
    const departure = [...card.querySelectorAll('p')].find((p) => p.textContent?.includes('יציאה:'))?.textContent || ''
    const numbers = flightNumbersFrom(title)
    const key = `${numbers.join('/')}|${route}|${departure}`
    if (seen.has(key)) card.classList.add('tp-hide-duplicate-flight')
    else seen.add(key)
  })
}

function enhance() {
  compactItineraryFlights()
  compactFlightCards()
}

export default function AppV07() {
  useEffect(() => {
    const observer = new MutationObserver(enhance)
    observer.observe(document.body, { childList: true, subtree: true })
    enhance()
    return () => observer.disconnect()
  }, [])

  return <LegacyApp />
}
