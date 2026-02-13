import { Link } from 'react-router-dom'

export function NotFound() {
  return (
    <div className="glass-card mx-auto max-w-lg rounded-3xl p-8 text-center">
      <p className="text-xs uppercase tracking-[0.35em] text-ink-600">404</p>
      <h2 className="mt-3 text-3xl font-semibold text-ink-900">Không tìm thấy trang</h2>
      <p className="mt-2 text-sm text-ink-600">Đường dẫn không tồn tại hoặc bạn không có quyền truy cập.</p>
      <Link
        to="/"
        className="mt-6 inline-flex rounded-full bg-ink-900 px-5 py-2 text-sm font-semibold text-white"
      >
        Quay về Dashboard
      </Link>
    </div>
  )
}
