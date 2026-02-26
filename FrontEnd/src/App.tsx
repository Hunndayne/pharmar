import { useEffect } from 'react'
import { Route, Routes } from 'react-router-dom'
import { AppShell } from './layout/AppShell'
import { RequireAuth } from './routes/RequireAuth'
import { RequireOwnerOrAdmin } from './routes/RequireOwnerOrAdmin'
import { storeApi } from './api/storeService'
import { Dashboard } from './pages/Dashboard'
import { DrugCatalog } from './pages/DrugCatalog'
import { DrugGroups } from './pages/DrugGroups'
import { Manufacturers } from './pages/Manufacturers'
import { Distributors } from './pages/Distributors'
import { StoreHub } from './pages/StoreHub'
import { Purchases } from './pages/Purchases'
import { Inventory } from './pages/Inventory'
import { Pos } from './pages/Pos'
import { SalesHistory } from './pages/SalesHistory'
import { Customers } from './pages/Customers'
import { Promotions } from './pages/Promotions'
import { Reports } from './pages/Reports'
import { UsersManagement } from './pages/UsersManagement'
import { UserSettings } from './pages/UserSettings'
import { StoreSettings } from './pages/StoreSettings'
import { StoreDrugGroups } from './pages/StoreDrugGroups'
import { SystemHealth } from './pages/SystemHealth'
import { Login } from './pages/Login'
import { NotFound } from './pages/NotFound'
import { setDocumentFavicon } from './utils/assets'

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

      <Route element={<RequireAuth />}>
        <Route element={<AppShell />}>
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
