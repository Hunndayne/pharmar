import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  storeApi,
  type StoreDrugCategory,
  type CreateDrugCategoryPayload,
  type CreateDrugGroupPayload,
  type UpdateDrugCategoryPayload,
  type UpdateDrugGroupPayload,
} from '../api/storeService'
import { ApiError } from '../api/usersService'
import { useAuth } from '../auth/AuthContext'

type CategoryFormState = {
  id?: string
  name: string
  description: string
  sortOrder: string
  isActive: boolean
}

type GroupFormState = {
  id?: string
  categoryId: string
  name: string
  description: string
  sortOrder: string
  isActive: boolean
}

const emptyCategoryForm = (): CategoryFormState => ({
  name: '',
  description: '',
  sortOrder: '100',
  isActive: true,
})

const emptyGroupForm = (categoryId = ''): GroupFormState => ({
  categoryId,
  name: '',
  description: '',
  sortOrder: '100',
  isActive: true,
})

const parseSortOrder = (value: string) => {
  const numberValue = Number(value)
  if (!Number.isFinite(numberValue)) return 100
  return Math.max(0, Math.floor(numberValue))
}

export function StoreDrugGroups() {
  const { token, user } = useAuth()
  const accessToken = token?.access_token ?? ''
  const isOwner = user?.role === 'owner'

  const [rows, setRows] = useState<StoreDrugCategory[]>([])
  const [search, setSearch] = useState('')
  const [includeInactive, setIncludeInactive] = useState(false)
  const [selectedCategoryId, setSelectedCategoryId] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)

  const [categoryModalOpen, setCategoryModalOpen] = useState(false)
  const [groupModalOpen, setGroupModalOpen] = useState(false)
  const [formSubmitting, setFormSubmitting] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const [categoryForm, setCategoryForm] = useState<CategoryFormState>(emptyCategoryForm())
  const [groupForm, setGroupForm] = useState<GroupFormState>(emptyGroupForm())

  const loadData = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const response = await storeApi.listDrugCategories({
        include_inactive: includeInactive,
        search: search.trim() || undefined,
      })
      setRows(response.items)
      setSelectedCategoryId((prev) => {
        if (!response.items.length) return null
        if (prev && response.items.some((item) => item.id === prev)) return prev
        return response.items[0].id
      })
    } catch (loadError) {
      if (loadError instanceof ApiError) setError(loadError.message)
      else setError('Không thể tải danh mục loại và nhóm thuốc.')
    } finally {
      setLoading(false)
    }
  }, [includeInactive, search])

  useEffect(() => {
    void loadData()
  }, [loadData])

  const selectedCategory = useMemo(
    () => rows.find((item) => item.id === selectedCategoryId) ?? null,
    [rows, selectedCategoryId],
  )

  const totalGroups = useMemo(
    () => rows.reduce((sum, item) => sum + item.groups.length, 0),
    [rows],
  )

  const openCreateCategory = () => {
    setFormError(null)
    setCategoryForm(emptyCategoryForm())
    setCategoryModalOpen(true)
  }

  const openEditCategory = (item: StoreDrugCategory) => {
    setFormError(null)
    setCategoryForm({
      id: item.id,
      name: item.name,
      description: item.description ?? '',
      sortOrder: String(item.sort_order),
      isActive: item.is_active,
    })
    setCategoryModalOpen(true)
  }

  const openCreateGroup = (categoryId?: string) => {
    setFormError(null)
    setGroupForm(emptyGroupForm(categoryId ?? selectedCategoryId ?? rows[0]?.id ?? ''))
    setGroupModalOpen(true)
  }

  const openEditGroup = (groupId: string) => {
    const category = rows.find((item) => item.groups.some((group) => group.id === groupId))
    const group = category?.groups.find((item) => item.id === groupId)
    if (!category || !group) return

    setFormError(null)
    setGroupForm({
      id: group.id,
      categoryId: category.id,
      name: group.name,
      description: group.description ?? '',
      sortOrder: String(group.sort_order),
      isActive: group.is_active,
    })
    setGroupModalOpen(true)
  }

  const saveCategory = async () => {
    if (!accessToken) {
      setFormError('Bạn cần đăng nhập để thực hiện thao tác này.')
      return
    }

    const name = categoryForm.name.trim()
    if (!name) {
      setFormError('Tên loại hàng là bắt buộc.')
      return
    }

    const payload: CreateDrugCategoryPayload | UpdateDrugCategoryPayload = {
      name,
      description: categoryForm.description.trim() || null,
      is_active: categoryForm.isActive,
      sort_order: parseSortOrder(categoryForm.sortOrder),
    }

    setFormSubmitting(true)
    setFormError(null)
    try {
      if (categoryForm.id) {
        await storeApi.updateDrugCategory(accessToken, categoryForm.id, payload)
        setMessage('Đã cập nhật loại hàng.')
      } else {
        await storeApi.createDrugCategory(accessToken, payload as CreateDrugCategoryPayload)
        setMessage('Đã tạo loại hàng.')
      }
      setCategoryModalOpen(false)
      await loadData()
    } catch (saveError) {
      if (saveError instanceof ApiError) setFormError(saveError.message)
      else setFormError('Không thể lưu loại hàng.')
    } finally {
      setFormSubmitting(false)
    }
  }

  const saveGroup = async () => {
    if (!accessToken) {
      setFormError('Bạn cần đăng nhập để thực hiện thao tác này.')
      return
    }

    const name = groupForm.name.trim()
    if (!groupForm.categoryId) {
      setFormError('Vui lòng chọn loại hàng.')
      return
    }
    if (!name) {
      setFormError('Tên nhóm thuốc là bắt buộc.')
      return
    }

    const payload: CreateDrugGroupPayload | UpdateDrugGroupPayload = {
      category_id: groupForm.categoryId,
      name,
      description: groupForm.description.trim() || null,
      is_active: groupForm.isActive,
      sort_order: parseSortOrder(groupForm.sortOrder),
    }

    setFormSubmitting(true)
    setFormError(null)
    try {
      if (groupForm.id) {
        await storeApi.updateDrugGroup(accessToken, groupForm.id, payload as UpdateDrugGroupPayload)
        setMessage('Đã cập nhật nhóm thuốc.')
      } else {
        await storeApi.createDrugGroup(accessToken, payload as CreateDrugGroupPayload)
        setMessage('Đã tạo nhóm thuốc.')
      }
      setGroupModalOpen(false)
      await loadData()
    } catch (saveError) {
      if (saveError instanceof ApiError) setFormError(saveError.message)
      else setFormError('Không thể lưu nhóm thuốc.')
    } finally {
      setFormSubmitting(false)
    }
  }

  const deleteCategory = async (item: StoreDrugCategory) => {
    if (!accessToken) {
      setError('Bạn cần đăng nhập để thực hiện thao tác này.')
      return
    }
    const confirmed = window.confirm(`Xóa loại hàng "${item.name}"?`)
    if (!confirmed) return

    try {
      await storeApi.deleteDrugCategory(accessToken, item.id)
      setMessage('Đã xóa loại hàng.')
      await loadData()
    } catch (deleteError) {
      if (deleteError instanceof ApiError) setError(deleteError.message)
      else setError('Không thể xóa loại hàng.')
    }
  }

  const deleteGroup = async (groupId: string, groupName: string) => {
    if (!accessToken) {
      setError('Bạn cần đăng nhập để thực hiện thao tác này.')
      return
    }
    const confirmed = window.confirm(`Xóa nhóm thuốc "${groupName}"?`)
    if (!confirmed) return

    try {
      await storeApi.deleteDrugGroup(accessToken, groupId)
      setMessage('Đã xóa nhóm thuốc.')
      await loadData()
    } catch (deleteError) {
      if (deleteError instanceof ApiError) setError(deleteError.message)
      else setError('Không thể xóa nhóm thuốc.')
    }
  }

  return (
    <div className="space-y-6">
      <header>
        <p className="text-xs uppercase tracking-[0.35em] text-ink-600">Cửa hàng</p>
        <h2 className="mt-2 text-3xl font-semibold text-ink-900">Loại hàng & nhóm thuốc</h2>
        <p className="mt-2 text-sm text-ink-600">
          Owner quản lý cấu trúc loại hàng và nhóm thuốc dùng chung cho toàn hệ thống.
        </p>
      </header>

      {!isOwner ? (
        <div className="glass-card rounded-2xl px-4 py-3 text-sm text-amber-700">
          Bạn đang ở chế độ chỉ xem. Chỉ owner mới được thêm/sửa/xóa.
        </div>
      ) : null}

      {message ? (
        <div className="glass-card flex items-center justify-between rounded-2xl px-4 py-3 text-sm text-ink-700">
          <span>{message}</span>
          <button type="button" onClick={() => setMessage(null)} className="text-ink-600">
            Đóng
          </button>
        </div>
      ) : null}

      {error ? (
        <div className="glass-card flex items-center justify-between rounded-2xl px-4 py-3 text-sm text-coral-500">
          <span>{error}</span>
          <button type="button" onClick={() => setError(null)} className="text-ink-600">
            Đóng
          </button>
        </div>
      ) : null}

      <section className="glass-card rounded-3xl p-5">
        <div className="grid gap-3 md:grid-cols-[1.2fr,auto,auto]">
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Tìm theo loại hàng hoặc nhóm thuốc"
            className="w-full rounded-2xl border border-ink-900/10 bg-white px-4 py-2 text-sm"
          />
          <label className="inline-flex items-center gap-2 rounded-2xl border border-ink-900/10 bg-white px-3 py-2 text-sm text-ink-700">
            <input
              type="checkbox"
              checked={includeInactive}
              onChange={(event) => setIncludeInactive(event.target.checked)}
              className="h-4 w-4 rounded border-ink-900/20"
            />
            Hiện cả dữ liệu ngừng dùng
          </label>
          <button
            type="button"
            onClick={() => void loadData()}
            className="rounded-2xl border border-ink-900/10 bg-white px-4 py-2 text-sm font-semibold text-ink-900"
          >
            Tải lại
          </button>
        </div>
        <div className="mt-3 flex flex-wrap gap-3 text-xs text-ink-600">
          <span>{rows.length} loại hàng</span>
          <span>{totalGroups} nhóm thuốc</span>
        </div>
      </section>

      <section className="grid gap-4 xl:grid-cols-[1fr,1.4fr]">
        <div className="glass-card rounded-3xl p-5">
          <div className="mb-4 flex items-center justify-between">
            <h3 className="text-lg font-semibold text-ink-900">Loại hàng</h3>
            {isOwner ? (
              <button
                type="button"
                onClick={openCreateCategory}
                className="rounded-full border border-ink-900/10 bg-white px-3 py-1 text-xs font-semibold text-ink-900"
              >
                Thêm loại
              </button>
            ) : null}
          </div>
          {loading ? <p className="text-sm text-ink-600">Đang tải...</p> : null}
          {!loading && rows.length === 0 ? (
            <p className="text-sm text-ink-600">Chưa có loại hàng.</p>
          ) : null}
          <div className="space-y-3">
            {rows.map((item) => (
              <article
                key={item.id}
                className={`rounded-2xl border p-4 ${
                  selectedCategoryId === item.id
                    ? 'border-ink-900/40 bg-white'
                    : 'border-ink-900/10 bg-white/70'
                }`}
              >
                <button
                  type="button"
                  onClick={() => setSelectedCategoryId(item.id)}
                  className="w-full text-left"
                >
                  <div className="flex items-center justify-between gap-2">
                    <p className="font-semibold text-ink-900">{item.name}</p>
                    <span
                      className={`rounded-full px-2 py-0.5 text-xs ${
                        item.is_active ? 'bg-brand-500/15 text-brand-600' : 'bg-ink-500/10 text-ink-500'
                      }`}
                    >
                      {item.is_active ? 'Đang dùng' : 'Ngừng dùng'}
                    </span>
                  </div>
                  <p className="mt-1 text-xs text-ink-600">{item.description || 'Không có mô tả'}</p>
                  <p className="mt-2 text-xs text-ink-500">Nhóm thuốc: {item.groups.length}</p>
                </button>
                {isOwner ? (
                  <div className="mt-3 flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={() => openEditCategory(item)}
                      className="rounded-full border border-ink-900/10 bg-white px-3 py-1 text-xs font-semibold text-ink-900"
                    >
                      Sửa
                    </button>
                    <button
                      type="button"
                      onClick={() => void deleteCategory(item)}
                      className="rounded-full border border-coral-500/30 bg-coral-500/10 px-3 py-1 text-xs font-semibold text-coral-500"
                    >
                      Xóa
                    </button>
                  </div>
                ) : null}
              </article>
            ))}
          </div>
        </div>

        <div className="glass-card rounded-3xl p-5">
          <div className="mb-4 flex items-center justify-between">
            <h3 className="text-lg font-semibold text-ink-900">
              Nhóm thuốc {selectedCategory ? `· ${selectedCategory.name}` : ''}
            </h3>
            {isOwner ? (
              <button
                type="button"
                onClick={() => openCreateGroup(selectedCategory?.id)}
                disabled={!selectedCategory}
                className="rounded-full border border-ink-900/10 bg-white px-3 py-1 text-xs font-semibold text-ink-900 disabled:cursor-not-allowed disabled:opacity-60"
              >
                Thêm nhóm
              </button>
            ) : null}
          </div>

          {!selectedCategory ? <p className="text-sm text-ink-600">Chọn một loại hàng để xem nhóm thuốc.</p> : null}
          {selectedCategory ? (
            <div className="space-y-3">
              {selectedCategory.groups.length === 0 ? (
                <p className="text-sm text-ink-600">Loại hàng này chưa có nhóm thuốc.</p>
              ) : null}
              {selectedCategory.groups.map((group) => (
                <article key={group.id} className="rounded-2xl border border-ink-900/10 bg-white p-4">
                  <div className="flex items-center justify-between gap-2">
                    <p className="font-semibold text-ink-900">{group.name}</p>
                    <span
                      className={`rounded-full px-2 py-0.5 text-xs ${
                        group.is_active ? 'bg-brand-500/15 text-brand-600' : 'bg-ink-500/10 text-ink-500'
                      }`}
                    >
                      {group.is_active ? 'Đang dùng' : 'Ngừng dùng'}
                    </span>
                  </div>
                  <p className="mt-1 text-xs text-ink-600">{group.description || 'Không có mô tả'}</p>
                  <p className="mt-2 text-xs text-ink-500">Thứ tự: {group.sort_order}</p>
                  {isOwner ? (
                    <div className="mt-3 flex flex-wrap gap-2">
                      <button
                        type="button"
                        onClick={() => openEditGroup(group.id)}
                        className="rounded-full border border-ink-900/10 bg-white px-3 py-1 text-xs font-semibold text-ink-900"
                      >
                        Sửa
                      </button>
                      <button
                        type="button"
                        onClick={() => void deleteGroup(group.id, group.name)}
                        className="rounded-full border border-coral-500/30 bg-coral-500/10 px-3 py-1 text-xs font-semibold text-coral-500"
                      >
                        Xóa
                      </button>
                    </div>
                  ) : null}
                </article>
              ))}
            </div>
          ) : null}
        </div>
      </section>

      {categoryModalOpen ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink-900/40 p-4">
          <div className="flex w-full max-w-xl flex-col overflow-hidden rounded-3xl bg-white shadow-lift">
            <div className="flex items-center justify-between border-b border-ink-900/10 px-6 py-4">
              <h3 className="text-xl font-semibold text-ink-900">
                {categoryForm.id ? 'Sửa loại hàng' : 'Thêm loại hàng'}
              </h3>
              <button
                type="button"
                onClick={() => setCategoryModalOpen(false)}
                className="rounded-full border border-ink-900/10 bg-white px-4 py-2 text-sm font-semibold text-ink-900"
              >
                Đóng
              </button>
            </div>
            <div className="space-y-4 px-6 py-5">
              <label className="space-y-2 text-sm text-ink-700">
                <span>Tên loại hàng *</span>
                <input
                  value={categoryForm.name}
                  onChange={(event) => setCategoryForm((prev) => ({ ...prev, name: event.target.value }))}
                  className="w-full rounded-2xl border border-ink-900/10 bg-white px-4 py-2"
                />
              </label>
              <label className="space-y-2 text-sm text-ink-700">
                <span>Mô tả</span>
                <textarea
                  value={categoryForm.description}
                  onChange={(event) => setCategoryForm((prev) => ({ ...prev, description: event.target.value }))}
                  rows={2}
                  className="w-full rounded-2xl border border-ink-900/10 bg-white px-4 py-2"
                />
              </label>
              <label className="space-y-2 text-sm text-ink-700">
                <span>Thứ tự hiển thị</span>
                <input
                  value={categoryForm.sortOrder}
                  onChange={(event) => setCategoryForm((prev) => ({ ...prev, sortOrder: event.target.value }))}
                  className="w-full rounded-2xl border border-ink-900/10 bg-white px-4 py-2"
                />
              </label>
              <label className="inline-flex items-center gap-2 text-sm text-ink-700">
                <input
                  type="checkbox"
                  checked={categoryForm.isActive}
                  onChange={(event) => setCategoryForm((prev) => ({ ...prev, isActive: event.target.checked }))}
                  className="h-4 w-4 rounded border-ink-900/20"
                />
                Đang sử dụng
              </label>
              {formError ? <p className="text-sm text-coral-500">{formError}</p> : null}
            </div>
            <div className="flex gap-3 border-t border-ink-900/10 px-6 py-4">
              <button
                type="button"
                onClick={() => void saveCategory()}
                disabled={formSubmitting}
                className="rounded-full bg-ink-900 px-5 py-2 text-sm font-semibold text-white disabled:opacity-60"
              >
                {formSubmitting ? 'Đang lưu...' : 'Lưu'}
              </button>
              <button
                type="button"
                onClick={() => setCategoryModalOpen(false)}
                className="rounded-full border border-ink-900/10 bg-white px-5 py-2 text-sm font-semibold text-ink-900"
              >
                Hủy
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {groupModalOpen ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink-900/40 p-4">
          <div className="flex w-full max-w-xl flex-col overflow-hidden rounded-3xl bg-white shadow-lift">
            <div className="flex items-center justify-between border-b border-ink-900/10 px-6 py-4">
              <h3 className="text-xl font-semibold text-ink-900">
                {groupForm.id ? 'Sửa nhóm thuốc' : 'Thêm nhóm thuốc'}
              </h3>
              <button
                type="button"
                onClick={() => setGroupModalOpen(false)}
                className="rounded-full border border-ink-900/10 bg-white px-4 py-2 text-sm font-semibold text-ink-900"
              >
                Đóng
              </button>
            </div>
            <div className="space-y-4 px-6 py-5">
              <label className="space-y-2 text-sm text-ink-700">
                <span>Loại hàng *</span>
                <select
                  value={groupForm.categoryId}
                  onChange={(event) => setGroupForm((prev) => ({ ...prev, categoryId: event.target.value }))}
                  className="w-full rounded-2xl border border-ink-900/10 bg-white px-4 py-2"
                >
                  <option value="">Chọn loại hàng</option>
                  {rows.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="space-y-2 text-sm text-ink-700">
                <span>Tên nhóm thuốc *</span>
                <input
                  value={groupForm.name}
                  onChange={(event) => setGroupForm((prev) => ({ ...prev, name: event.target.value }))}
                  className="w-full rounded-2xl border border-ink-900/10 bg-white px-4 py-2"
                />
              </label>
              <label className="space-y-2 text-sm text-ink-700">
                <span>Mô tả</span>
                <textarea
                  value={groupForm.description}
                  onChange={(event) => setGroupForm((prev) => ({ ...prev, description: event.target.value }))}
                  rows={2}
                  className="w-full rounded-2xl border border-ink-900/10 bg-white px-4 py-2"
                />
              </label>
              <label className="space-y-2 text-sm text-ink-700">
                <span>Thứ tự hiển thị</span>
                <input
                  value={groupForm.sortOrder}
                  onChange={(event) => setGroupForm((prev) => ({ ...prev, sortOrder: event.target.value }))}
                  className="w-full rounded-2xl border border-ink-900/10 bg-white px-4 py-2"
                />
              </label>
              <label className="inline-flex items-center gap-2 text-sm text-ink-700">
                <input
                  type="checkbox"
                  checked={groupForm.isActive}
                  onChange={(event) => setGroupForm((prev) => ({ ...prev, isActive: event.target.checked }))}
                  className="h-4 w-4 rounded border-ink-900/20"
                />
                Đang sử dụng
              </label>
              {formError ? <p className="text-sm text-coral-500">{formError}</p> : null}
            </div>
            <div className="flex gap-3 border-t border-ink-900/10 px-6 py-4">
              <button
                type="button"
                onClick={() => void saveGroup()}
                disabled={formSubmitting}
                className="rounded-full bg-ink-900 px-5 py-2 text-sm font-semibold text-white disabled:opacity-60"
              >
                {formSubmitting ? 'Đang lưu...' : 'Lưu'}
              </button>
              <button
                type="button"
                onClick={() => setGroupModalOpen(false)}
                className="rounded-full border border-ink-900/10 bg-white px-5 py-2 text-sm font-semibold text-ink-900"
              >
                Hủy
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}

