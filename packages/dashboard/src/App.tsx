import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom"
import { useServers } from "@/hooks/use-servers"
import Layout from "@/components/layout"
import SetupPage from "@/pages/setup"
import DashboardPage from "@/pages/dashboard"
import EntitiesPage from "@/pages/entities"
import EntityDetailPage from "@/pages/entity-detail"
import DispatchesPage from "@/pages/dispatches"
import SettingsPage from "@/pages/settings"

function AppRoutes() {
  const { servers } = useServers()

  if (servers.length === 0) {
    return (
      <Routes>
        <Route path="/setup" element={<SetupPage />} />
        <Route path="*" element={<Navigate to="/setup" replace />} />
      </Routes>
    )
  }

  return (
    <Routes>
      <Route element={<Layout />}>
        <Route path="/" element={<DashboardPage />} />
        <Route path="/entities" element={<EntitiesPage />} />
        <Route path="/entities/:key" element={<EntityDetailPage />} />
        <Route path="/dispatches" element={<DispatchesPage />} />
        <Route path="/settings" element={<SettingsPage />} />
      </Route>
      <Route path="/setup" element={<SetupPage />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}

export default function App() {
  return (
    <BrowserRouter>
      <AppRoutes />
    </BrowserRouter>
  )
}
