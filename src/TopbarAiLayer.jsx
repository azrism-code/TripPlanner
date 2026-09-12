import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'

function findTripAiMenuButton() {
  return [...document.querySelectorAll('aside.side-menu button')]
    .find((button) => button.textContent?.includes('Trip AI')) || null
}

function hideLegacyAiEntries() {
  const menuButton = findTripAiMenuButton()
  if (menuButton) menuButton.classList.add('tp-hide-trip-ai-entry')
  document.querySelectorAll('.ai-card, .ai-day-button').forEach((node) => {
    node.classList.add('tp-hide-trip-ai-entry')
  })
  return menuButton
}

export default function TopbarAiLayer() {
  const [topbar, setTopbar] = useState(null)
  const [available, setAvailable] = useState(false)
  const [active, setActive] = useState(false)

  useEffect(() => {
    let frameId = 0
    let stopped = false

    const refresh = () => {
      const bar = document.querySelector('.topbar')
      const menuButton = hideLegacyAiEntries()
      setTopbar(bar || null)
      setAvailable(Boolean(bar && menuButton))
      setActive(Boolean(menuButton?.classList.contains('active')))
    }

    const observer = new MutationObserver(() => {
      if (frameId || stopped) return
      frameId = window.requestAnimationFrame(() => {
        frameId = 0
        observer.disconnect()
        refresh()
        if (!stopped) observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] })
      })
    })

    refresh()
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] })

    return () => {
      stopped = true
      observer.disconnect()
      if (frameId) window.cancelAnimationFrame(frameId)
    }
  }, [])

  if (!topbar || !available) return null

  return createPortal(
    <div className="tp-topbar-ai-slot">
      <button
        type="button"
        className={`tp-topbar-ai-button ${active ? 'active' : ''}`}
        onClick={() => findTripAiMenuButton()?.click()}
        aria-label="פתיחת Trip AI"
      >
        <span>✨</span>
        <strong>Trip AI</strong>
      </button>
    </div>,
    topbar
  )
}
