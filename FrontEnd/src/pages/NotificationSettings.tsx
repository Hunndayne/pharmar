import { useCallback, useEffect, useState } from 'react'
import {
  notificationApi,
  type AlertRuleRecord,
  type SmtpConfigRecord,
  type SmtpConfigPayload,
} from '../api/notificationService'
import { useAuth } from '../auth/AuthContext'

type SmtpForm = SmtpConfigPayload

const emptySmtpForm: SmtpForm = {
  host: '',
  port: 587,
  username: '',
  password: '',
  use_tls: true,
  from_email: '',
  from_name: 'Pharmar',
  is_active: false,
}

export function NotificationSettings() {
  const { token, user } = useAuth()
  const accessToken = token?.access_token ?? ''
  const isOwner = user?.role === 'owner'

  // ── SMTP ───────────────────────────────────────────────────────────────
  const [smtpForm, setSmtpForm] = useState<SmtpForm>(emptySmtpForm)
  const [smtpLoading, setSmtpLoading] = useState(false)
  const [smtpSaving, setSmtpSaving] = useState(false)
  const [smtpError, setSmtpError] = useState<string | null>(null)
  const [smtpSuccess, setSmtpSuccess] = useState<string | null>(null)
  const [testEmail, setTestEmail] = useState('')
  const [testSending, setTestSending] = useState(false)

  const loadSmtp = useCallback(async () => {
    if (!accessToken || !isOwner) return
    setSmtpLoading(true)
    try {
      const config = await notificationApi.getSmtpConfig(accessToken)
      setSmtpForm({
        host: config.host,
        port: config.port,
        username: config.username,
        password: '',
        use_tls: config.use_tls,
        from_email: config.from_email,
        from_name: config.from_name,
        is_active: config.is_active,
      })
    } catch (err) {
      setSmtpError(err instanceof Error ? err.message : 'Lỗi tải cấu hình SMTP')
    } finally {
      setSmtpLoading(false)
    }
  }, [accessToken, isOwner])

  useEffect(() => {
    void loadSmtp()
  }, [loadSmtp])

  const handleSmtpSave = async () => {
    setSmtpSaving(true)
    setSmtpError(null)
    setSmtpSuccess(null)
    try {
      await notificationApi.updateSmtpConfig(accessToken, smtpForm)
      setSmtpSuccess('Lưu cấu hình SMTP thành công!')
    } catch (err) {
      setSmtpError(err instanceof Error ? err.message : 'Lỗi lưu cấu hình')
    } finally {
      setSmtpSaving(false)
    }
  }

  const handleTestEmail = async () => {
    if (!testEmail.trim()) return
    setTestSending(true)
    setSmtpError(null)
    setSmtpSuccess(null)
    try {
      const res = await notificationApi.testSmtp(accessToken, testEmail.trim())
      setSmtpSuccess(res.message)
    } catch (err) {
      setSmtpError(err instanceof Error ? err.message : 'Gửi email test thất bại')
    } finally {
      setTestSending(false)
    }
  }

  // ── Alert Rules ────────────────────────────────────────────────────────
  const [alertRules, setAlertRules] = useState<AlertRuleRecord[]>([])
  const [alertLoading, setAlertLoading] = useState(false)

  const loadAlertRules = useCallback(async () => {
    if (!accessToken) return
    setAlertLoading(true)
    try {
      const rules = await notificationApi.listAlertRules(accessToken)
      setAlertRules(rules)
    } catch {
      // ignore
    } finally {
      setAlertLoading(false)
    }
  }, [accessToken])

  useEffect(() => {
    void loadAlertRules()
  }, [loadAlertRules])

  const handleToggleRule = async (rule: AlertRuleRecord, field: 'is_active' | 'send_email' | 'send_web') => {
    try {
      const updated = await notificationApi.updateAlertRule(accessToken, rule.id, {
        [field]: !rule[field],
      })
      setAlertRules((prev) => prev.map((r) => (r.id === updated.id ? updated : r)))
    } catch {
      // ignore
    }
  }

  return (
    <div className="space-y-8">
      <h1 className="text-3xl font-bold text-ink-900">Cài đặt thông báo</h1>

      {/* ── Alert Rules ─────────────────────────────────────────────────── */}
      <section className="rounded-2xl border border-ink-100 bg-white p-6">
        <h2 className="text-lg font-semibold text-ink-900">Quy tắc cảnh báo</h2>
        <p className="mt-1 text-sm text-ink-500">Bật/tắt từng loại thông báo và kênh gửi</p>

        {alertLoading && <p className="mt-4 text-sm text-ink-400">Đang tải...</p>}

        <div className="mt-4 overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-ink-100 text-ink-500">
                <th className="pb-2 pr-4 font-medium">Loại cảnh báo</th>
                <th className="pb-2 pr-4 font-medium">Mô tả</th>
                <th className="pb-2 pr-4 text-center font-medium">Bật</th>
                <th className="pb-2 pr-4 text-center font-medium">Web</th>
                <th className="pb-2 text-center font-medium">Email</th>
              </tr>
            </thead>
            <tbody>
              {alertRules.map((rule) => (
                <tr key={rule.id} className="border-b border-ink-50">
                  <td className="py-3 pr-4 font-medium text-ink-800">{rule.name}</td>
                  <td className="py-3 pr-4 text-ink-500">{rule.description ?? '-'}</td>
                  <td className="py-3 pr-4 text-center">
                    <button
                      type="button"
                      onClick={() => void handleToggleRule(rule, 'is_active')}
                      className={`inline-block h-5 w-9 rounded-full transition ${rule.is_active ? 'bg-green-500' : 'bg-ink-200'}`}
                    >
                      <span className={`block h-4 w-4 translate-x-0.5 rounded-full bg-white shadow transition ${rule.is_active ? 'translate-x-4' : ''}`} />
                    </button>
                  </td>
                  <td className="py-3 pr-4 text-center">
                    <button
                      type="button"
                      onClick={() => void handleToggleRule(rule, 'send_web')}
                      className={`inline-block h-5 w-9 rounded-full transition ${rule.send_web ? 'bg-sky-500' : 'bg-ink-200'}`}
                    >
                      <span className={`block h-4 w-4 translate-x-0.5 rounded-full bg-white shadow transition ${rule.send_web ? 'translate-x-4' : ''}`} />
                    </button>
                  </td>
                  <td className="py-3 text-center">
                    <button
                      type="button"
                      onClick={() => void handleToggleRule(rule, 'send_email')}
                      className={`inline-block h-5 w-9 rounded-full transition ${rule.send_email ? 'bg-violet-500' : 'bg-ink-200'}`}
                    >
                      <span className={`block h-4 w-4 translate-x-0.5 rounded-full bg-white shadow transition ${rule.send_email ? 'translate-x-4' : ''}`} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* ── SMTP Config ─────────────────────────────────────────────────── */}
      {isOwner && (
        <section className="rounded-2xl border border-ink-100 bg-white p-6">
          <h2 className="text-lg font-semibold text-ink-900">Cấu hình SMTP (Email)</h2>
          <p className="mt-1 text-sm text-ink-500">
            Cấu hình máy chủ SMTP để gửi email thông báo. Hỗ trợ Gmail, Outlook, v.v.
          </p>

          {smtpLoading && <p className="mt-4 text-sm text-ink-400">Đang tải...</p>}

          {smtpError && <p className="mt-3 text-sm text-coral-500">{smtpError}</p>}
          {smtpSuccess && <p className="mt-3 text-sm text-green-600">{smtpSuccess}</p>}

          <div className="mt-5 grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <label className="mb-1 block text-sm font-medium text-ink-700">SMTP Host</label>
              <input
                type="text"
                placeholder="smtp.gmail.com"
                value={smtpForm.host}
                onChange={(e) => setSmtpForm((f) => ({ ...f, host: e.target.value }))}
                className="w-full rounded-lg border border-ink-200 px-3 py-2 text-sm focus:border-sky-400 focus:outline-none"
              />
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium text-ink-700">Port</label>
              <input
                type="number"
                placeholder="587"
                value={smtpForm.port}
                onChange={(e) => setSmtpForm((f) => ({ ...f, port: Number(e.target.value) }))}
                className="w-full rounded-lg border border-ink-200 px-3 py-2 text-sm focus:border-sky-400 focus:outline-none"
              />
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium text-ink-700">Username</label>
              <input
                type="text"
                placeholder="your-email@gmail.com"
                value={smtpForm.username}
                onChange={(e) => setSmtpForm((f) => ({ ...f, username: e.target.value }))}
                className="w-full rounded-lg border border-ink-200 px-3 py-2 text-sm focus:border-sky-400 focus:outline-none"
              />
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium text-ink-700">Password</label>
              <input
                type="password"
                placeholder="App password"
                value={smtpForm.password}
                onChange={(e) => setSmtpForm((f) => ({ ...f, password: e.target.value }))}
                className="w-full rounded-lg border border-ink-200 px-3 py-2 text-sm focus:border-sky-400 focus:outline-none"
              />
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium text-ink-700">Email gửi</label>
              <input
                type="email"
                placeholder="noreply@pharmar.vn"
                value={smtpForm.from_email}
                onChange={(e) => setSmtpForm((f) => ({ ...f, from_email: e.target.value }))}
                className="w-full rounded-lg border border-ink-200 px-3 py-2 text-sm focus:border-sky-400 focus:outline-none"
              />
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium text-ink-700">Tên hiển thị</label>
              <input
                type="text"
                placeholder="Pharmar"
                value={smtpForm.from_name}
                onChange={(e) => setSmtpForm((f) => ({ ...f, from_name: e.target.value }))}
                className="w-full rounded-lg border border-ink-200 px-3 py-2 text-sm focus:border-sky-400 focus:outline-none"
              />
            </div>
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-4">
            <label className="flex items-center gap-2 text-sm text-ink-700">
              <input
                type="checkbox"
                checked={smtpForm.use_tls}
                onChange={(e) => setSmtpForm((f) => ({ ...f, use_tls: e.target.checked }))}
                className="rounded border-ink-300"
              />
              Sử dụng TLS
            </label>
            <label className="flex items-center gap-2 text-sm text-ink-700">
              <input
                type="checkbox"
                checked={smtpForm.is_active}
                onChange={(e) => setSmtpForm((f) => ({ ...f, is_active: e.target.checked }))}
                className="rounded border-ink-300"
              />
              Kích hoạt gửi email
            </label>
          </div>

          <div className="mt-5 flex flex-wrap gap-3">
            <button
              type="button"
              onClick={() => void handleSmtpSave()}
              disabled={smtpSaving}
              className="rounded-lg bg-ink-900 px-4 py-2 text-sm font-medium text-white hover:bg-ink-800 disabled:opacity-50"
            >
              {smtpSaving ? 'Đang lưu...' : 'Lưu cấu hình'}
            </button>
          </div>

          {/* Test email */}
          <div className="mt-6 border-t border-ink-100 pt-5">
            <h3 className="text-sm font-semibold text-ink-800">Gửi email kiểm tra</h3>
            <div className="mt-2 flex gap-2">
              <input
                type="email"
                placeholder="test@example.com"
                value={testEmail}
                onChange={(e) => setTestEmail(e.target.value)}
                className="flex-1 rounded-lg border border-ink-200 px-3 py-2 text-sm focus:border-sky-400 focus:outline-none"
              />
              <button
                type="button"
                onClick={() => void handleTestEmail()}
                disabled={testSending || !testEmail.trim()}
                className="rounded-lg border border-sky-300 bg-sky-50 px-4 py-2 text-sm font-medium text-sky-700 hover:bg-sky-100 disabled:opacity-50"
              >
                {testSending ? 'Đang gửi...' : 'Gửi test'}
              </button>
            </div>
          </div>
        </section>
      )}
    </div>
  )
}
