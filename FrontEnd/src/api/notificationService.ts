import { ApiError, buildUsersApiUrl } from './usersService'

export type NotificationRecord = {
  id: string
  title: string
  body: string
  category: string
  is_read: boolean
  email_sent: boolean
  created_at: string
}

export type SmtpConfigRecord = {
  id: number
  host: string
  port: number
  username: string
  use_tls: boolean
  from_email: string
  from_name: string
  is_active: boolean
  updated_at: string
}

export type SmtpConfigPayload = {
  host: string
  port: number
  username: string
  password: string
  use_tls: boolean
  from_email: string
  from_name: string
  is_active: boolean
}

export type AlertRuleRecord = {
  id: number
  code: string
  name: string
  description: string | null
  is_active: boolean
  send_email: boolean
  send_web: boolean
  created_at: string
  updated_at: string
}

export type AlertRuleUpdatePayload = {
  is_active?: boolean
  send_email?: boolean
  send_web?: boolean
}

export type PageResponse<T> = {
  items: T[]
  total: number
  page: number
  size: number
  pages: number
}

const requestJson = async <T>(
  path: string,
  token: string,
  init: RequestInit = {},
  params?: Record<string, string | number | boolean | undefined>,
): Promise<T> => {
  const headers = new Headers(init.headers)
  if (!headers.has('Content-Type') && init.body) headers.set('Content-Type', 'application/json')
  headers.set('Authorization', `Bearer ${token}`)

  const response = await fetch(buildUsersApiUrl(path, params), {
    ...init,
    headers,
  })

  const contentType = response.headers.get('content-type') ?? ''
  const isJson = contentType.includes('application/json')
  const payload = isJson ? await response.json() : null

  if (!response.ok) {
    const detail =
      (typeof payload?.detail === 'string' ? payload.detail : undefined) ??
      payload?.message ??
      `Yêu cầu thất bại (${response.status})`
    throw new ApiError(detail, response.status)
  }

  return payload as T
}

export const notificationApi = {
  // ── Notifications ──────────────────────────────────────────────────────
  listNotifications: (
    token: string,
    params?: { is_read?: boolean; category?: string; page?: number; size?: number },
  ) =>
    requestJson<PageResponse<NotificationRecord>>(
      '/notification/notifications',
      token,
      { method: 'GET' },
      params as Record<string, string | number | boolean | undefined>,
    ),

  getUnreadCount: (token: string) =>
    requestJson<{ unread_count: number }>(
      '/notification/notifications/unread-count',
      token,
      { method: 'GET' },
    ),

  markRead: (token: string, notificationIds: string[]) =>
    requestJson<{ message: string; count: number }>(
      '/notification/notifications/mark-read',
      token,
      {
        method: 'PATCH',
        body: JSON.stringify({ notification_ids: notificationIds }),
      },
    ),

  markAllRead: (token: string) =>
    requestJson<{ message: string; count: number }>(
      '/notification/notifications/mark-all-read',
      token,
      { method: 'PATCH' },
    ),

  deleteNotification: (token: string, notificationId: string) =>
    requestJson<void>(
      `/notification/notifications/${encodeURIComponent(notificationId)}`,
      token,
      { method: 'DELETE' },
    ),

  deleteAllRead: (token: string) =>
    requestJson<void>(
      '/notification/notifications',
      token,
      { method: 'DELETE' },
    ),

  // ── SMTP Config ────────────────────────────────────────────────────────
  getSmtpConfig: (token: string) =>
    requestJson<SmtpConfigRecord>(
      '/notification/smtp',
      token,
      { method: 'GET' },
    ),

  updateSmtpConfig: (token: string, payload: SmtpConfigPayload) =>
    requestJson<SmtpConfigRecord>(
      '/notification/smtp',
      token,
      {
        method: 'PUT',
        body: JSON.stringify(payload),
      },
    ),

  testSmtp: (token: string, toEmail: string) =>
    requestJson<{ message: string }>(
      '/notification/smtp/test',
      token,
      {
        method: 'POST',
        body: JSON.stringify({ to_email: toEmail }),
      },
    ),

  // ── Alert Rules ────────────────────────────────────────────────────────
  listAlertRules: (token: string) =>
    requestJson<AlertRuleRecord[]>(
      '/notification/alert-rules',
      token,
      { method: 'GET' },
    ),

  updateAlertRule: (token: string, ruleId: number, payload: AlertRuleUpdatePayload) =>
    requestJson<AlertRuleRecord>(
      `/notification/alert-rules/${ruleId}`,
      token,
      {
        method: 'PUT',
        body: JSON.stringify(payload),
      },
    ),
}
