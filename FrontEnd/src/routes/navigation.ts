export type NavLinkItem = {
  type: 'item'
  label: string
  path: string
}

export type NavGroupItem = {
  type: 'group'
  label: string
  children: NavLinkItem[]
}

export type NavItem = NavLinkItem | NavGroupItem

export const navItems: NavItem[] = [
  { type: 'item', label: 'Dashboard', path: '/' },
  { type: 'item', label: 'Danh mục thuốc', path: '/thuoc' },
  { type: 'item', label: 'Nhập hàng', path: '/nhap-hang' },
  { type: 'item', label: 'Tồn kho', path: '/ton-kho' },
  { type: 'item', label: 'Bán hàng', path: '/ban-hang' },
  { type: 'item', label: 'Cài đặt', path: '/cua-hang/cai-dat' },
  {
    type: 'group',
    label: 'Cửa hàng',
    children: [
      { type: 'item', label: 'Loại & nhóm thuốc', path: '/cua-hang/nhom-thuoc' },
      { type: 'item', label: 'Nhà sản xuất', path: '/nha-san-xuat' },
      { type: 'item', label: 'Nhà phân phối', path: '/nha-phan-phoi' },
      { type: 'item', label: 'Lịch sử bán hàng', path: '/lich-su-ban-hang' },
      { type: 'item', label: 'Khách hàng', path: '/khach-hang' },
      { type: 'item', label: 'Khuyến mãi', path: '/khuyen-mai' },
    ],
  },
  { type: 'item', label: 'Báo cáo', path: '/bao-cao' },
]
