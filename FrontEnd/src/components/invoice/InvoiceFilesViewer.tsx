import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { fileApi } from '../../api/fileService'

type InvoiceFilesViewerProps = {
  accessToken: string
  fileIds: string[]
  title?: string
  onClose: () => void
}

type ViewerItem =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; url: string; contentType: string; name: string }

const MIN_ZOOM = 1
const MAX_ZOOM = 4
const ZOOM_STEP = 0.5
const DRAG_CLICK_THRESHOLD = 5

const loadViewerItem = async (accessToken: string, fileId: string): Promise<ViewerItem> => {
  try {
    const [meta, presign] = await Promise.all([
      fileApi.getFile(accessToken, fileId),
      fileApi.presignDownload(accessToken, fileId),
    ])
    return {
      status: 'ready',
      url: presign.url,
      contentType: meta.content_type || '',
      name: meta.original_name || meta.filename || fileId,
    }
  } catch {
    return { status: 'error', message: 'Không tải được file hóa đơn này.' }
  }
}

export function InvoiceFilesViewer({ accessToken, fileIds, title, onClose }: InvoiceFilesViewerProps) {
  const [items, setItems] = useState<ViewerItem[]>(() => fileIds.map(() => ({ status: 'loading' })))
  const [index, setIndex] = useState(0)
  const [zoom, setZoom] = useState(MIN_ZOOM)
  const [offset, setOffset] = useState({ x: 0, y: 0 })
  const imageRetriedRef = useRef<Set<number>>(new Set())
  const dragRef = useRef<{ pointerId: number; startX: number; startY: number; originX: number; originY: number; moved: boolean } | null>(null)

  const total = fileIds.length
  const current = items[index] ?? { status: 'loading' }

  const loadAt = useCallback(
    (position: number) => {
      const fileId = fileIds[position]
      if (!fileId) return
      void loadViewerItem(accessToken, fileId).then((item) => {
        setItems((prev) => prev.map((existing, itemIndex) => (itemIndex === position ? item : existing)))
      })
    },
    [accessToken, fileIds],
  )

  // Presigned URLs expire, so they are fetched each time the viewer opens rather than cached.
  useEffect(() => {
    let active = true
    void Promise.all(fileIds.map((fileId) => loadViewerItem(accessToken, fileId))).then((loaded) => {
      if (active) setItems(loaded)
    })
    return () => {
      active = false
    }
  }, [accessToken, fileIds])

  const resetView = () => {
    setZoom(MIN_ZOOM)
    setOffset({ x: 0, y: 0 })
  }

  const goTo = useCallback(
    (next: number) => {
      if (next < 0 || next >= total) return
      setIndex(next)
      setZoom(MIN_ZOOM)
      setOffset({ x: 0, y: 0 })
    },
    [total],
  )

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
      } else if (event.key === 'ArrowLeft') {
        goTo(index - 1)
      } else if (event.key === 'ArrowRight') {
        goTo(index + 1)
      }
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [goTo, index, onClose])

  useEffect(() => {
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = previous
    }
  }, [])

  const changeZoom = (delta: number) => {
    const next = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom + delta))
    setZoom(next)
    if (next === MIN_ZOOM) setOffset({ x: 0, y: 0 })
  }

  const handlePointerDown = (event: ReactPointerEvent<HTMLImageElement>) => {
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originX: offset.x,
      originY: offset.y,
      moved: false,
    }
  }

  const handlePointerMove = (event: ReactPointerEvent<HTMLImageElement>) => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    const dx = event.clientX - drag.startX
    const dy = event.clientY - drag.startY
    if (Math.abs(dx) + Math.abs(dy) > DRAG_CLICK_THRESHOLD) drag.moved = true
    if (zoom > MIN_ZOOM) setOffset({ x: drag.originX + dx, y: drag.originY + dy })
  }

  const handlePointerUp = (event: ReactPointerEvent<HTMLImageElement>) => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    dragRef.current = null
    if (drag.moved) return
    if (zoom > MIN_ZOOM) resetView()
    else setZoom(2)
  }

  const isImage = current.status === 'ready' && current.contentType.startsWith('image/')
  const isPdf = current.status === 'ready' && current.contentType === 'application/pdf'

  return (
    <div className="fixed inset-0 z-[70] flex flex-col bg-ink-900/95 text-white" role="dialog" aria-modal="true" aria-label="Xem hóa đơn">
      <div className="flex flex-wrap items-center gap-2 border-b border-white/10 px-3 py-2 sm:px-4">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold">{title || 'Hóa đơn gốc'}</p>
          <p className="text-xs text-white/60">
            Trang {index + 1}/{total}
            {current.status === 'ready' ? ` · ${current.name}` : ''}
          </p>
        </div>
        {isImage ? (
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => changeZoom(-ZOOM_STEP)}
              disabled={zoom <= MIN_ZOOM}
              aria-label="Thu nhỏ"
              className="h-9 w-9 rounded-full bg-white/10 text-lg font-semibold disabled:opacity-30"
            >
              −
            </button>
            <span className="w-12 text-center text-xs tabular-nums">{Math.round(zoom * 100)}%</span>
            <button
              type="button"
              onClick={() => changeZoom(ZOOM_STEP)}
              disabled={zoom >= MAX_ZOOM}
              aria-label="Phóng to"
              className="h-9 w-9 rounded-full bg-white/10 text-lg font-semibold disabled:opacity-30"
            >
              +
            </button>
          </div>
        ) : null}
        {current.status === 'ready' ? (
          <div className="flex items-center gap-1">
            <a
              href={current.url}
              target="_blank"
              rel="noopener noreferrer"
              className="rounded-full bg-white/10 px-3 py-2 text-xs font-semibold"
            >
              Mở tab mới
            </a>
            <a
              href={current.url}
              download={current.name}
              target="_blank"
              rel="noopener noreferrer"
              className="rounded-full bg-white/10 px-3 py-2 text-xs font-semibold"
            >
              Tải về
            </a>
          </div>
        ) : null}
        <button
          type="button"
          onClick={onClose}
          aria-label="Đóng"
          className="h-9 w-9 rounded-full bg-white/15 text-xl leading-none"
        >
          ×
        </button>
      </div>

      <div
        className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden p-2 sm:p-4"
        onClick={(event) => {
          if (event.target === event.currentTarget) onClose()
        }}
      >
        {current.status === 'loading' ? (
          <div className="flex items-center gap-2 text-sm text-white/80">
            <span className="h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent" />
            Đang tải hóa đơn…
          </div>
        ) : null}
        {current.status === 'error' ? (
          <div className="space-y-3 text-center text-sm text-white/80">
            <p>{current.message}</p>
            <button
              type="button"
              onClick={() => {
                imageRetriedRef.current.delete(index)
                setItems((prev) => prev.map((item, itemIndex) => (itemIndex === index ? { status: 'loading' } : item)))
                loadAt(index)
              }}
              className="rounded-full bg-white/15 px-4 py-2 text-xs font-semibold"
            >
              Thử lại
            </button>
          </div>
        ) : null}
        {current.status === 'ready' && isImage ? (
          <img
            key={current.url}
            src={current.url}
            alt={`Hóa đơn trang ${index + 1}`}
            draggable={false}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerCancel={() => {
              dragRef.current = null
            }}
            onError={() => {
              // One retry covers an expired presigned URL; a second failure usually means the browser can't decode AVIF.
              if (imageRetriedRef.current.has(index)) {
                setItems((prev) =>
                  prev.map((item, itemIndex) =>
                    itemIndex === index
                      ? { status: 'error', message: 'Trình duyệt không hiển thị được ảnh này. Hãy bấm "Thử lại" hoặc dùng trình duyệt mới hơn.' }
                      : item,
                  ),
                )
                return
              }
              imageRetriedRef.current.add(index)
              setItems((prev) => prev.map((item, itemIndex) => (itemIndex === index ? { status: 'loading' } : item)))
              loadAt(index)
            }}
            style={{
              transform: `translate(${offset.x}px, ${offset.y}px) scale(${zoom})`,
              touchAction: 'none',
            }}
            className={`max-h-full max-w-full select-none rounded-lg bg-white object-contain shadow-2xl transition-transform duration-75 ${
              zoom > MIN_ZOOM ? 'cursor-grab active:cursor-grabbing' : 'cursor-zoom-in'
            }`}
          />
        ) : null}
        {current.status === 'ready' && isPdf ? (
          <div className="flex h-full w-full flex-col gap-2">
            <iframe
              key={current.url}
              src={current.url}
              title={`Hóa đơn ${current.name}`}
              className="min-h-0 w-full flex-1 rounded-lg bg-white"
            />
            <p className="text-center text-xs text-white/60">
              Nếu không thấy nội dung PDF (thường gặp trên điện thoại), bấm "Mở tab mới".
            </p>
          </div>
        ) : null}
        {current.status === 'ready' && !isImage && !isPdf ? (
          <p className="text-sm text-white/80">Không xem trước được loại file này, hãy bấm "Tải về".</p>
        ) : null}

        {total > 1 ? (
          <>
            <button
              type="button"
              onClick={() => goTo(index - 1)}
              disabled={index === 0}
              aria-label="Trang trước"
              className="absolute left-2 top-1/2 h-11 w-11 -translate-y-1/2 rounded-full bg-black/50 text-2xl disabled:opacity-20"
            >
              ‹
            </button>
            <button
              type="button"
              onClick={() => goTo(index + 1)}
              disabled={index === total - 1}
              aria-label="Trang sau"
              className="absolute right-2 top-1/2 h-11 w-11 -translate-y-1/2 rounded-full bg-black/50 text-2xl disabled:opacity-20"
            >
              ›
            </button>
          </>
        ) : null}
      </div>

      {total > 1 ? (
        <div className="flex gap-2 overflow-x-auto border-t border-white/10 px-3 py-2">
          {items.map((item, itemIndex) => (
            <button
              key={fileIds[itemIndex]}
              type="button"
              onClick={() => goTo(itemIndex)}
              aria-label={`Trang ${itemIndex + 1}`}
              className={`relative h-14 w-11 shrink-0 overflow-hidden rounded-md border-2 bg-white/10 ${
                itemIndex === index ? 'border-brand-400' : 'border-transparent opacity-70'
              }`}
            >
              {item.status === 'ready' && item.contentType.startsWith('image/') ? (
                <img src={item.url} alt="" className="h-full w-full object-cover" />
              ) : (
                <span className="flex h-full w-full items-center justify-center text-[10px] font-semibold">
                  {item.status === 'ready' && item.contentType === 'application/pdf' ? 'PDF' : itemIndex + 1}
                </span>
              )}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  )
}
