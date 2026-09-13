import LegacyApp from './AppV08.jsx'
import SystemAdminLayer, { InviteAcceptanceLayer } from './SystemAdminLayer.jsx'

export default function AppV081() {
  return (
    <>
      <LegacyApp />
      <SystemAdminLayer />
      <InviteAcceptanceLayer />
    </>
  )
}
