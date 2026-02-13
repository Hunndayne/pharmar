import { useMemo, useState } from 'react'

type Product = {
  id: string
  code: string
  name: string
  unit: string
  stock: number
  price: number
}

type CartItem = Product & { quantity: number }

const catalog: Product[] = [
  { id: 'p1', code: 'T0001', name: 'Panadol Extra', unit: 'Viên', stock: 189, price: 3000 },
  { id: 'p2', code: 'T0034', name: 'Vitamin C 1000', unit: 'Viên', stock: 210, price: 6000 },
  { id: 'p3', code: 'T0088', name: 'Amoxicillin 500mg', unit: 'Viên', stock: 540, price: 4200 },
]

const formatCurrency = (value: number) => `${value.toLocaleString('vi-VN')}đ`

export function Pos() {
  const [keyword, setKeyword] = useState('')
  const [cart, setCart] = useState<CartItem[]>([])

  const filtered = useMemo(() => {
    const key = keyword.trim().toLowerCase()
    if (!key) return catalog
    return catalog.filter((item) =>
      `${item.code} ${item.name}`.toLowerCase().includes(key),
    )
  }, [keyword])

  const addToCart = (product: Product) => {
    setCart((prev) => {
      const existing = prev.find((item) => item.id === product.id)
      if (existing) {
        return prev.map((item) =>
          item.id === product.id ? { ...item, quantity: item.quantity + 1 } : item,
        )
      }
      return [...prev, { ...product, quantity: 1 }]
    })
  }

  const updateQuantity = (id: string, quantity: number) => {
    if (quantity <= 0) {
      setCart((prev) => prev.filter((item) => item.id !== id))
      return
    }
    setCart((prev) => prev.map((item) => (item.id === id ? { ...item, quantity } : item)))
  }

  const total = useMemo(
    () => cart.reduce((sum, item) => sum + item.quantity * item.price, 0),
    [cart],
  )

  return (
    <div className="space-y-6">
      <header>
        <p className="text-xs uppercase tracking-[0.35em] text-ink-600">POS</p>
        <h2 className="mt-2 text-3xl font-semibold text-ink-900">Bán hàng tại quầy</h2>
      </header>

      <section className="grid gap-4 xl:grid-cols-[1.6fr,1fr]">
        <article className="glass-card rounded-3xl p-6">
          <div className="flex items-center gap-3">
            <input
              value={keyword}
              onChange={(event) => setKeyword(event.target.value)}
              placeholder="Tìm mã thuốc, tên thuốc hoặc quét mã vạch"
              className="w-full rounded-2xl border border-ink-900/10 bg-white px-4 py-2 text-sm"
            />
          </div>

          <div className="mt-4 overflow-hidden rounded-2xl border border-ink-900/10">
            <table className="w-full text-left text-sm">
              <thead className="bg-white/70 text-xs uppercase tracking-[0.22em] text-ink-600">
                <tr>
                  <th className="px-4 py-3">Mã</th>
                  <th className="px-4 py-3">Thuốc</th>
                  <th className="px-4 py-3">Tồn</th>
                  <th className="px-4 py-3">Giá</th>
                  <th className="px-4 py-3">Thao tác</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-900/5">
                {filtered.map((product) => (
                  <tr key={product.id}>
                    <td className="px-4 py-3 font-semibold text-ink-900">{product.code}</td>
                    <td className="px-4 py-3 text-ink-900">{product.name}</td>
                    <td className="px-4 py-3 text-ink-700">{product.stock.toLocaleString('vi-VN')} {product.unit}</td>
                    <td className="px-4 py-3 text-ink-700">{formatCurrency(product.price)}</td>
                    <td className="px-4 py-3">
                      <button
                        type="button"
                        onClick={() => addToCart(product)}
                        className="rounded-full border border-ink-900/10 bg-white px-3 py-1 text-xs font-semibold text-ink-900"
                      >
                        Thêm
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </article>

        <aside className="glass-card rounded-3xl p-6">
          <p className="text-xs uppercase tracking-[0.25em] text-ink-600">Giỏ hàng</p>
          <h3 className="mt-2 text-2xl font-semibold text-ink-900">{cart.length} sản phẩm</h3>

          <div className="mt-4 space-y-3">
            {cart.length === 0 ? (
              <p className="text-sm text-ink-600">Chưa có sản phẩm trong giỏ.</p>
            ) : null}
            {cart.map((item) => (
              <div key={item.id} className="rounded-2xl border border-ink-900/10 bg-white p-3">
                <p className="font-semibold text-ink-900">{item.name}</p>
                <div className="mt-2 flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => updateQuantity(item.id, item.quantity - 1)}
                      className="h-7 w-7 rounded-full border border-ink-900/10 text-sm"
                    >
                      -
                    </button>
                    <span className="text-sm text-ink-700">{item.quantity}</span>
                    <button
                      type="button"
                      onClick={() => updateQuantity(item.id, item.quantity + 1)}
                      className="h-7 w-7 rounded-full border border-ink-900/10 text-sm"
                    >
                      +
                    </button>
                  </div>
                  <p className="text-sm font-semibold text-ink-900">
                    {formatCurrency(item.quantity * item.price)}
                  </p>
                </div>
              </div>
            ))}
          </div>

          <div className="mt-6 border-t border-ink-900/10 pt-4">
            <p className="text-sm text-ink-600">Tổng thanh toán</p>
            <p className="mt-1 text-3xl font-semibold text-ink-900">{formatCurrency(total)}</p>
            <button
              type="button"
              className="mt-4 w-full rounded-2xl bg-ink-900 px-4 py-2 text-sm font-semibold text-white"
            >
              Tạo hóa đơn
            </button>
          </div>
        </aside>
      </section>
    </div>
  )
}
