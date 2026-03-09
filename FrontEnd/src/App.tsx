import { Suspense, lazy, useEffect } from 'react'
import { Navigate, Route, Routes } from 'react-router-dom'
import { AppShell } from './layout/AppShell'
import { RequireAuth } from './routes/RequireAuth'
import { RequireOwnerOrAdmin } from './routes/RequireOwnerOrAdmin'
import { storeApi } from './api/storeService'
import { Login } from './pages/Login'
import { setDocumentFavicon } from './utils/assets'

const Dashboard = lazy(() => import('./pages/Dashboard').then((module) => ({ default: module.Dashboard })))
const DrugCatalog = lazy(() => import('./pages/DrugCatalog').then((module) => ({ default: module.DrugCatalog })))
const DrugGroups = lazy(() => import('./pages/DrugGroups').then((module) => ({ default: module.DrugGroups })))
const Manufacturers = lazy(() => import('./pages/Manufacturers').then((module) => ({ default: module.Manufacturers })))
const Distributors = lazy(() => import('./pages/Distributors').then((module) => ({ default: module.Distributors })))
const StoreHub = lazy(() => import('./pages/StoreHub').then((module) => ({ default: module.StoreHub })))
const Purchases = lazy(() => import('./pages/Purchases').then((module) => ({ default: module.Purchases })))
const Inventory = lazy(() => import('./pages/Inventory').then((module) => ({ default: module.Inventory })))
const Pos = lazy(() => import('./pages/Pos').then((module) => ({ default: module.Pos })))
const SalesHistory = lazy(() => import('./pages/SalesHistory').then((module) => ({ default: module.SalesHistory })))
const Customers = lazy(() => import('./pages/Customers').then((module) => ({ default: module.Customers })))
const Promotions = lazy(() => import('./pages/Promotions').then((module) => ({ default: module.Promotions })))
const Reports = lazy(() => import('./pages/Reports').then((module) => ({ default: module.Reports })))
const UsersManagement = lazy(() => import('./pages/UsersManagement').then((module) => ({ default: module.UsersManagement })))
const UserSettings = lazy(() => import('./pages/UserSettings').then((module) => ({ default: module.UserSettings })))
const StoreSettings = lazy(() => import('./pages/StoreSettings').then((module) => ({ default: module.StoreSettings })))
const StoreDrugGroups = lazy(() => import('./pages/StoreDrugGroups').then((module) => ({ default: module.StoreDrugGroups })))
const SystemHealth = lazy(() => import('./pages/SystemHealth').then((module) => ({ default: module.SystemHealth })))
const Notifications = lazy(() => import('./pages/Notifications').then((module) => ({ default: module.Notifications })))
const PublicInvoiceLookup = lazy(() => import('./pages/PublicInvoiceLookup').then((module) => ({ default: module.PublicInvoiceLookup })))
const NotFound = lazy(() => import('./pages/NotFound').then((module) => ({ default: module.NotFound })))

function App() {
  useEffect(() => {
    let mounted = true
    const loadStoreLogo = async () => {
      try {
        const info = await storeApi.getInfo()
        if (!mounted) return
        setDocumentFavicon(info.logo_url)
      } catch {
        // keep default favicon
      }
    }
    void loadStoreLogo()
    return () => {
      mounted = false
    }
  }, [])

  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route
        path="/tra-cuu-hoa-don"
        element={(
          <Suspense fallback={<div className="p-4 text-sm text-ink-600">Đang tải trang...</div>}>
            <PublicInvoiceLookup />
          </Suspense>
        )}
      />

      <Route element={<RequireAuth />}>
        <Route
          element={(
            <Suspense fallback={<div className="p-4 text-sm text-ink-600">Đang tải trang...</div>}>
              <AppShell />
            </Suspense>
          )}
        >
          <Route index element={<Dashboard />} />
          <Route path="/thuoc" element={<DrugCatalog />} />
          <Route path="/nhom-thuoc" element={<DrugGroups />} />
          <Route path="/cua-hang" element={<StoreHub />} />
          <Route path="/cua-hang/cai-dat" element={<StoreSettings />} />
          <Route path="/cua-hang/nhom-thuoc" element={<StoreDrugGroups />} />
          <Route path="/nha-san-xuat" element={<Manufacturers />} />
          <Route path="/nha-phan-phoi" element={<Distributors />} />
          <Route path="/nhap-hang" element={<Purchases />} />
          <Route path="/ton-kho" element={<Inventory />} />
          <Route path="/ban-hang" element={<Pos />} />
          <Route path="/lich-su-ban-hang" element={<SalesHistory />} />
          <Route path="/khach-hang" element={<Customers />} />
          <Route path="/khuyen-mai" element={<Promotions />} />
          <Route path="/bao-cao" element={<Reports />} />
          <Route path="/thong-bao" element={<Notifications />} />
          <Route path="/cai-dat-thong-bao" element={<Navigate to="/cua-hang/cai-dat" replace />} />
          <Route path="/cai-dat" element={<UserSettings />} />
          <Route path="/he-thong/suc-khoe-dich-vu" element={<SystemHealth />} />

          <Route element={<RequireOwnerOrAdmin />}>
            <Route path="/quan-ly-tai-khoan" element={<UsersManagement />} />
          </Route>

          <Route path="*" element={<NotFound />} />
        </Route>
      </Route>
    </Routes>
  )
}

export default App
