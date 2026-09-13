import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { registerSW } from 'virtual:pwa-register'
import App from './AppV081.jsx'
import './styles.css'
import './v04.css'
import './v05.css'
import './v07.css'
import './v08.css'
import './v09.css'
import './v081.css'

registerSW({ immediate: true })

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>
)
