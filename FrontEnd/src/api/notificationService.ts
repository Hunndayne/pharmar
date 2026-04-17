import { requestJson } from './httpClient'
import { buildUsersApiUrl } from './usersService'

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
  to_email: string
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
  to_email: string
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

const requestNotificationJson = async <T>(
  path: string,
  token: string,
  init: RequestInit = {},
  params?: Record<string, string | number | boolean | undefined>,
): Promise<T> =>
  requestJson<T>(buildUsersApiUrl, path, {
    init,
    token,
    params,
  })

export const notificationApi = {
  listNotifications: (
    token: string,
    params?: { is_read?: boolean; category?: string; page?: number; size?: number },
  ) =>
    requestNotificationJson<PageResponse<NotificationRecord>>(
      '/notification/notifications',
      token,
      { method: 'GET' },
      params as Record<string, string | number | boolean | undefined>,
    ),

  getUnreadCount: (token: string) =>
    requestNotificationJson<{ unread_count: number }>(
      '/notification/notifications/unread-count',
      token,
      { method: 'GET' },
    ),

  markRead: (token: string, notificationIds: string[]) =>
    requestNotificationJson<{ message: string; count: number }>(
      '/notification/notifications/mark-read',
      token,
      {
        method: 'PATCH',
        body: JSON.stringify({ notification_ids: notificationIds }),
      },
    ),

  markAllRead: (token: string) =>
    requestNotificationJson<{ message: string; count: number }>(
      '/notification/notifications/mark-all-read',
      token,
      { method: 'PATCH' },
    ),

  deleteNotification: (token: string, notificationId: string) =>
    requestNotificationJson<void>(
      `/notification/notifications/${encodeURIComponent(notificationId)}`,
      token,
      { method: 'DELETE' },
    ),

  deleteAllRead: (token: string) =>
    requestNotificationJson<void>(
      '/notification/notifications',
      token,
      { method: 'DELETE' },
    ),

  getSmtpConfig: (token: string) =>
    requestNotificationJson<SmtpConfigRecord>(
      '/notification/smtp',
      token,
      { method: 'GET' },
    ),

  updateSmtpConfig: (token: string, payload: SmtpConfigPayload) =>
    requestNotificationJson<SmtpConfigRecord>(
      '/notification/smtp',
      token,
      {
        method: 'PUT',
        body: JSON.stringify(payload),
      },
    ),

  testSmtp: (token: string, toEmail: string) =>
    requestNotificationJson<{ message: string }>(
      '/notification/smtp/test',
      token,
      {
        method: 'POST',
        body: JSON.stringify({ to_email: toEmail }),
      },
    ),

  listAlertRules: (token: string) =>
    requestNotificationJson<AlertRuleRecord[]>(
      '/notification/alert-rules',
      token,
      { method: 'GET' },
    ),

  updateAlertRule: (token: string, ruleId: number, payload: AlertRuleUpdatePayload) =>
    requestNotificationJson<AlertRuleRecord>(
      `/notification/alert-rules/${ruleId}`,
      token,
      {
        method: 'PUT',
        body: JSON.stringify(payload),
      },
    ),
}
