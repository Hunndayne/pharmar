export type AuthLikeUser = {
  role?: string | null
  username?: string | null
} | null

export const isOwnerOrAdmin = (user: AuthLikeUser) => {
  if (!user) return false
  return user.role === 'owner'
}
