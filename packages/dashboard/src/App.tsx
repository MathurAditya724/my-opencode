import Layout from "@/components/layout"
import { useServers } from "@/hooks/use-servers"
import DashboardPage from "@/pages/dashboard"
import DispatchesPage from "@/pages/dispatches"
import EntitiesPage from "@/pages/entities"
import EntityDetailPage from "@/pages/entity-detail"
import SetupPage from "@/pages/setup"
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom"

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
