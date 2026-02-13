import { Navigate, Outlet } from 'react-router-dom'
import { useAuth } from '../auth/AuthContext'
import { isOwnerOrAdmin } from '../auth/permissions'

export function RequireOwnerOrAdmin() {
  const { user } = useAuth()
  if (!isOwnerOrAdmin(user)) {
    return <Navigate to="/" replace />
  }
  return <Outlet />
}
