import { Route, Routes } from 'react-router-dom'
import { AppShell } from './layout/AppShell'
import { RequireAuth } from './routes/RequireAuth'
import { RequireOwnerOrAdmin } from './routes/RequireOwnerOrAdmin'
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
import { Login } from './pages/Login'
import { NotFound } from './pages/NotFound'

function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />

      <Route element={<RequireAuth />}>
        <Route element={<AppShell />}>
          <Route index element={<Dashboard />} />
          <Route path="/thuoc" element={<DrugCatalog />} />
          <Route path="/nhom-thuoc" element={<DrugGroups />} />
          <Route path="/cua-hang" element={<StoreHub />} />
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
