import type { AiLineHintData } from './types'

const LOW_CONFIDENCE = 0.8

type AiLineHintProps = {
  hint: AiLineHintData
  currentDrugId: string
}

export function AiLineHint({ hint, currentDrugId }: AiLineHintProps) {
  const userChanged = Boolean(currentDrugId) && currentDrugId !== hint.productId
  const aiMatchedInForm = Boolean(hint.productId) && currentDrugId === hint.productId
  const missingDrug = !currentDrugId
  const lowConfidence =
    aiMatchedInForm && hint.source !== 'memory' && (hint.confidence ?? 0) < LOW_CONFIDENCE

  const tone = missingDrug
    ? 'border-coral-500/40 bg-coral-500/10'
    : lowConfidence
      ? 'border-amber-500/40 bg-amber-50'
      : 'border-brand-500/20 bg-brand-500/5'

  return (
    <div className={`rounded-xl border px-3 py-2 text-xs text-ink-700 ${tone}`}>
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="font-semibold text-ink-900">Trên hóa đơn:</span>
        <span className="break-words">{hint.rawName || '-'}</span>
        {hint.rawUnit ? <span className="text-ink-500">({hint.rawUnit})</span> : null}
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
        {userChanged ? (
          <span className="rounded-full border border-ink-900/10 bg-white px-2 py-0.5 font-semibold text-ink-700">
            Đã đổi thuốc
          </span>
        ) : aiMatchedInForm && hint.source === 'memory' ? (
          <span className="rounded-full bg-brand-500/15 px-2 py-0.5 font-semibold text-brand-700">Đã nhớ</span>
        ) : aiMatchedInForm ? (
          <span
            className={`rounded-full px-2 py-0.5 font-semibold ${
              lowConfidence ? 'bg-amber-500/20 text-amber-800' : 'bg-brand-500/15 text-brand-700'
            }`}
          >
            AI {Math.round((hint.confidence ?? 0) * 100)}%
          </span>
        ) : (
          <span className="rounded-full bg-coral-500/15 px-2 py-0.5 font-semibold text-coral-500">
            {hint.productId ? 'Thuốc AI gợi ý không có trong danh sách' : 'AI chưa khớp được thuốc'}
          </span>
        )}
        {hint.isFree ? (
          <span className="rounded-full bg-sun-500/15 px-2 py-0.5 font-semibold text-sun-500">
            Hàng tặng – tự xử lý
          </span>
        ) : null}
        {hint.unitName && aiMatchedInForm ? (
          <span className="text-ink-500">Đơn vị nhập: {hint.unitName}</span>
        ) : null}
      </div>
      {missingDrug && hint.productName ? (
        <p className="mt-1 text-ink-600">AI gợi ý: {hint.productName}</p>
      ) : null}
      {hint.reason && aiMatchedInForm && lowConfidence ? (
        <p className="mt-1 text-ink-600">{hint.reason}</p>
      ) : null}
      {hint.notes.length ? (
        <ul className="mt-1 list-disc space-y-0.5 pl-4 text-ink-600">
          {hint.notes.map((note, index) => (
            <li key={`${index}-${note}`}>{note}</li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}
