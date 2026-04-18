import { useNavigate } from 'react-router-dom'
import { CURRENT_VERSION, WHATS_NEW_STORAGE_KEY, changelogEntries } from '../constants/changelog'

type Props = {
  onClose: () => void
}

export function WhatsNewModal({ onClose }: Props) {
  const navigate = useNavigate()

  const handleClose = () => {
    localStorage.setItem(WHATS_NEW_STORAGE_KEY, CURRENT_VERSION)
    onClose()
  }

  const handleFeatureClick = (route: string) => {
    handleClose()
    navigate(route)
  }

  const latestEntry = changelogEntries[0]

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4">
      <div className="w-full max-w-md overflow-hidden rounded-2xl bg-white shadow-2xl">
        <div className="bg-gradient-to-br from-sky-500 to-indigo-600 px-6 py-5 text-white">
          <p className="text-xs font-semibold uppercase tracking-widest opacity-80">Phiên bản mới</p>
          <h2 className="mt-1 text-2xl font-bold">{latestEntry.version}</h2>
          <p className="mt-0.5 text-sm opacity-70">{latestEntry.date}</p>
        </div>

        <div className="px-6 py-5">
          <p className="mb-4 text-sm font-semibold text-ink-700">Tính năng & cải thiện:</p>
          <ul className="space-y-2">
            {latestEntry.features.map((f, i) => (
              <li key={i}>
                {f.route ? (
                  <button
                    type="button"
                    onClick={() => handleFeatureClick(f.route!)}
                    className="group flex w-full items-start gap-2.5 rounded-lg px-3 py-2 text-left text-sm text-ink-700 transition hover:bg-sky-50 hover:text-sky-700"
                  >
                    <span className="mt-0.5 shrink-0 text-sky-400 group-hover:text-sky-600">→</span>
                    <span>{f.text}</span>
                  </button>
                ) : (
                  <div className="flex items-start gap-2.5 px-3 py-2 text-sm text-ink-600">
                    <span className="mt-0.5 shrink-0 text-ink-300">·</span>
                    <span>{f.text}</span>
                  </div>
                )}
              </li>
            ))}
          </ul>
        </div>

        <div className="border-t border-ink-900/5 px-6 py-4">
          <button
            type="button"
            onClick={handleClose}
            className="w-full rounded-full bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-indigo-700"
          >
            Đã hiểu, bắt đầu dùng
          </button>
        </div>
      </div>
    </div>
  )
}
