import { useCallback, useEffect, useMemo, useState } from 'react'
import { ApiError } from '../api/usersService'
import { systemApi, type SystemHealthResponse, type SystemHealthService } from '../api/systemService'

const formatDateTime = (value: string) => {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString('vi-VN')
}

const statusLabel: Record<string, string> = {
  up: 'Hoạt động',
  degraded: 'Cảnh báo',
  down: 'Mất kết nối',
}

const statusClass: Record<string, string> = {
  up: 'border border-brand-500/30 bg-brand-500/10 text-brand-600',
  degraded: 'border border-amber-400/40 bg-amber-100 text-amber-700',
  down: 'border border-coral-500/30 bg-coral-500/10 text-coral-500',
}

const getStatusLabel = (status: string) => statusLabel[status] ?? status
const getStatusClass = (status: string) =>
  statusClass[status] ?? 'border border-ink-900/20 bg-ink-900/10 text-ink-700'

export function SystemHealth() {
  const [health, setHealth] = useState<SystemHealthResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const loadHealth = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const response = await systemApi.getHealth()
      setHealth(response)
    } catch (loadError) {
      if (loadError instanceof ApiError) setError(loadError.message)
      else setError('Không thể tải trạng thái dịch vụ.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadHealth()
  }, [loadHealth])

  const summary = useMemo(() => {
    if (!health) {
      return { total: 0, up: 0, degraded: 0, down: 0 }
    }
    return health.summary
  }, [health])

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-xs uppercase tracking-[0.35em] text-ink-600">Hệ thống</p>
          <h2 className="mt-2 text-3xl font-semibold text-ink-900">Sức khỏe dịch vụ</h2>
          <p className="mt-2 text-sm text-ink-600">
            Theo dõi trạng thái kết nối giữa API Gateway và các microservice.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void loadHealth()}
          disabled={loading}
          className="rounded-full border border-ink-900/10 bg-white px-5 py-2 text-sm font-semibold text-ink-900 disabled:opacity-60"
        >
          {loading ? 'Đang tải...' : 'Làm mới'}
        </button>
      </header>

      <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <div className="glass-card rounded-3xl p-5">
          <p className="text-xs uppercase tracking-[0.28em] text-ink-600">Tổng dịch vụ</p>
          <p className="mt-3 text-2xl font-semibold text-ink-900">{summary.total}</p>
        </div>
        <div className="glass-card rounded-3xl p-5">
          <p className="text-xs uppercase tracking-[0.28em] text-ink-600">Hoạt động</p>
          <p className="mt-3 text-2xl font-semibold text-brand-600">{summary.up}</p>
        </div>
        <div className="glass-card rounded-3xl p-5">
          <p className="text-xs uppercase tracking-[0.28em] text-ink-600">Cảnh báo</p>
          <p className="mt-3 text-2xl font-semibold text-amber-700">{summary.degraded}</p>
        </div>
        <div className="glass-card rounded-3xl p-5">
          <p className="text-xs uppercase tracking-[0.28em] text-ink-600">Mất kết nối</p>
          <p className="mt-3 text-2xl font-semibold text-coral-500">{summary.down}</p>
        </div>
      </section>

      <section className="glass-card rounded-3xl p-6 space-y-4">
        {health?.generated_at ? (
          <p className="text-xs text-ink-600">Cập nhật lúc: {formatDateTime(health.generated_at)}</p>
        ) : null}
        {error ? <p className="text-sm text-coral-500">{error}</p> : null}

        <div className="overflow-hidden rounded-2xl border border-white/60 bg-white/70">
          <div className="overflow-x-auto">
            <table className="min-w-[860px] w-full text-left text-sm">
              <thead className="bg-white/70 text-xs uppercase tracking-[0.25em] text-ink-600">
                <tr>
                  <th className="px-6 py-4">Dịch vụ</th>
                  <th className="px-6 py-4">Trạng thái</th>
                  <th className="px-6 py-4">HTTP</th>
                  <th className="px-6 py-4">Độ trễ</th>
                  <th className="px-6 py-4">Endpoint</th>
                  <th className="px-6 py-4">Chi tiết</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/70">
                {loading && !health ? (
                  <tr>
                    <td colSpan={6} className="px-6 py-6 text-ink-600">Đang tải trạng thái...</td>
                  </tr>
                ) : null}
                {!loading && health?.services?.length ? (
                  health.services.map((service: SystemHealthService) => (
                    <tr key={service.name} className="hover:bg-white/80">
                      <td className="px-6 py-4 font-semibold text-ink-900">{service.name}</td>
                      <td className="px-6 py-4">
                        <span className={`rounded-full px-3 py-1 text-xs font-semibold ${getStatusClass(service.status)}`}>
                          {getStatusLabel(service.status)}
                        </span>
                      </td>
                      <td className="px-6 py-4 text-ink-700">{service.http_status ?? '-'}</td>
                      <td className="px-6 py-4 text-ink-700">
                        {service.latency_ms == null ? '-' : `${service.latency_ms} ms`}
                      </td>
                      <td className="px-6 py-4 text-ink-700">{service.url}</td>
                      <td className="px-6 py-4 text-ink-700">{service.detail ?? '-'}</td>
                    </tr>
                  ))
                ) : null}
                {!loading && !health?.services?.length ? (
                  <tr>
                    <td colSpan={6} className="px-6 py-6 text-ink-600">Chưa có dữ liệu dịch vụ.</td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </div>
      </section>
    </div>
  )
}
