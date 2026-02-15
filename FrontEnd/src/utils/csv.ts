export type CsvValue = string | number | boolean | null | undefined

const toStringValue = (value: CsvValue) => {
  if (value === null || value === undefined) return ''
  return String(value)
}

const quoteIfNeeded = (value: string, delimiter: string) => {
  if (!value.includes('"') && !value.includes('\n') && !value.includes('\r') && !value.includes(delimiter)) {
    return value
  }
  return `"${value.replace(/"/g, '""')}"`
}

export const buildDelimitedText = (
  headers: CsvValue[],
  rows: CsvValue[][],
  delimiter = ',',
) => {
  const lines = [headers, ...rows].map((row) =>
    row.map((cell) => quoteIfNeeded(toStringValue(cell), delimiter)).join(delimiter),
  )
  return lines.join('\r\n')
}

export const downloadCsv = (
  filename: string,
  headers: CsvValue[],
  rows: CsvValue[][],
) => {
  const csv = `\uFEFF${buildDelimitedText(headers, rows, ',')}`
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
  const link = document.createElement('a')
  link.href = URL.createObjectURL(blob)
  link.download = filename
  link.click()
  URL.revokeObjectURL(link.href)
}

const detectDelimiter = (text: string) => {
  const firstLine = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0)

  if (!firstLine) return ','
  const commaCount = (firstLine.match(/,/g) ?? []).length
  const semicolonCount = (firstLine.match(/;/g) ?? []).length
  const tabCount = (firstLine.match(/\t/g) ?? []).length

  if (tabCount > commaCount && tabCount > semicolonCount) return '\t'
  if (semicolonCount > commaCount) return ';'
  return ','
}

export const parseDelimitedText = (raw: string) => {
  const text = raw.replace(/^\uFEFF/, '')
  const delimiter = detectDelimiter(text)
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let i = 0
  let inQuotes = false

  while (i < text.length) {
    const ch = text[i]
    const next = text[i + 1]

    if (inQuotes) {
      if (ch === '"' && next === '"') {
        cell += '"'
        i += 2
        continue
      }
      if (ch === '"') {
        inQuotes = false
        i += 1
        continue
      }
      cell += ch
      i += 1
      continue
    }

    if (ch === '"') {
      inQuotes = true
      i += 1
      continue
    }

    if (ch === delimiter) {
      row.push(cell.trim())
      cell = ''
      i += 1
      continue
    }

    if (ch === '\n') {
      row.push(cell.trim())
      rows.push(row)
      row = []
      cell = ''
      i += 1
      continue
    }

    if (ch === '\r') {
      i += 1
      continue
    }

    cell += ch
    i += 1
  }

  if (cell.length > 0 || row.length > 0) {
    row.push(cell.trim())
    rows.push(row)
  }

  return rows.filter((item) => item.some((cellValue) => cellValue.length > 0))
}
