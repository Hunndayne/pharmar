import { useMemo, useState } from 'react'
import { Outlet, useLocation, useNavigate } from 'react-router-dom'
import { MobileHeader } from '../components/layout/MobileHeader'
import { MobileNav } from '../components/layout/MobileNav'
import { Sidebar } from '../components/layout/Sidebar'
import { useAuth } from '../auth/AuthContext'
import { isOwnerOrAdmin } from '../auth/permissions'
import { navItems } from '../routes/navigation'

const titleByPath: Record<string, string> = {
  '/': 'Dashboard',
  '/thuoc': 'Danh mục thuốc',
  '/nhom-thuoc': 'Nhóm thuốc',
  '/cua-hang': 'Cửa hàng',
  '/cua-hang/cai-dat': 'Thông tin cửa hàng',
  '/nha-san-xuat': 'Nhà sản xuất',
  '/nha-phan-phoi': 'Nhà phân phối',
  '/nhap-hang': 'Nhập hàng',
  '/ton-kho': 'Tồn kho',
  '/ban-hang': 'Bán hàng',
  '/lich-su-ban-hang': 'Lịch sử bán hàng',
  '/khach-hang': 'Khách hàng',
  '/khuyen-mai': 'Khuyến mãi',
  '/bao-cao': 'Báo cáo',
  '/he-thong/suc-khoe-dich-vu': 'Sức khỏe dịch vụ',
  '/quan-ly-tai-khoan': 'Quản lý tài khoản',
  '/cai-dat': 'Cài đặt người dùng',
}

export function AppShell() {
  const { pathname } = useLocation()
  const navigate = useNavigate()
  const { user, logout } = useAuth()

  const [mobileNavOpen, setMobileNavOpen] = useState(false)
  const [systemMenuOpen, setSystemMenuOpen] = useState(false)

  const title = titleByPath[pathname] ?? 'PHARMAR'
  const canManageUsers = isOwnerOrAdmin(user)
  const visibleNavItems = useMemo(() => navItems, [])

  const handleLogout = async () => {
    await logout()
    navigate('/login', { replace: true })
  }

  return (
    <div className="flex min-h-screen bg-transparent text-ink-900">
      <Sidebar
        items={visibleNavItems}
        menuOpen={systemMenuOpen}
        onToggleMenu={() => setSystemMenuOpen((prev) => !prev)}
        onOpenSettings={() => {
          setSystemMenuOpen(false)
          navigate('/cai-dat')
        }}
        onOpenUsersManagement={() => {
          setSystemMenuOpen(false)
          navigate('/quan-ly-tai-khoan')
        }}
        onOpenServicesHealth={() => {
          setSystemMenuOpen(false)
          navigate('/he-thong/suc-khoe-dich-vu')
        }}
        onLogout={() => {
          setSystemMenuOpen(false)
          void handleLogout()
        }}
        canManageUsers={canManageUsers}
      />

      <MobileNav open={mobileNavOpen} items={visibleNavItems} onClose={() => setMobileNavOpen(false)} />

      <div className="flex min-h-screen flex-1 flex-col">
        <MobileHeader title={title} onMenu={() => setMobileNavOpen(true)} />
        <main className="flex-1 px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
          <Outlet />
        </main>
      </div>
    </div>
  )
}
