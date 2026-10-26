const FIELD_PATTERNS = {
  directoryRow: [/^(?:no\.?|#|s\.?\s*n\.?|s\s*\/\s*n|row|serial|item)$/i, /^(?:directory\s*)?(?:row\s*)?(?:no\.?|number)$/i],
  studentNumber: [/^(?:student\s*)?(?:no\.?|number|id|#)$/i, /^student\s*number$/i, /^student\s*id$/i],
  lastName: [/^(?:last\s*name|surname|family\s*name|lastname)$/i],
  firstName: [/^(?:first\s*name|given\s*name|firstname)$/i],
  middleInitial: [/^(?:middle\s*(?:initial|name)|m\.?\s*i\.?|mi)$/i],
  program: [/^(?:program|course|degree|course\s*\/\s*program|academic\s*program)$/i],
  yearLevel: [/^(?:year(?:\s*level)?|yr\.?|level)$/i],
  sex: [/^(?:sex|gender)$/i],
  email: [/^(?:e\s*-?\s*mail|email\s*address)$/i],
  contactNumber: [/^(?:contact(?:\s*(?:no\.?|number|#))?|phone(?:\s*(?:no\.?|number|#))?|mobile|cellphone|telephone)$/i],
  address: [/^address$/i]
}

const FIELD_KEYS = Object.keys(FIELD_PATTERNS)
const clean = value => String(value || '').replace(/\s+/g, ' ').trim()
function normalizeItem(item) {
  return {
    text: clean(item.str),
    x: Number(item.transform?.[4] || 0),
    y: Number(item.transform?.[5] || 0),
    width: Number(item.width || 0),
    hasEOL: Boolean(item.hasEOL)
  }
}

function groupByLine(items, tolerance = 18) {
  const sorted = items.filter(item => clean(item.str)).map(normalizeItem).sort((a, b) => b.y - a.y || a.x - b.x)
  const lines = []
  for (const item of sorted) {
    const candidate = lines.at(-1)
    let line = candidate && Math.abs(candidate.y - item.y) <= tolerance ? candidate : null
    if (!line) { line = { y: item.y, items: [] }; lines.push(line) }
    line.items.push(item)
  }
  return lines.map(line => ({ ...line, items: line.items.sort((a, b) => a.x - b.x) })).sort((a, b) => b.y - a.y)
}

const normalizeHeader = value => clean(value).toLowerCase().replace(/[.:_]/g, '').replace(/\s+/g, ' ').replace(/\s*\/\s*/g, '/')

function matchHeaderField(label) {
  const normalized = normalizeHeader(label)
  const compact = normalized.replace(/[^a-z0-9#]/gi, '')
  for (const key of FIELD_KEYS) if (FIELD_PATTERNS[key].some(pattern => pattern.test(normalized) || pattern.test(compact))) return key
  return null
}

function detectHeader(lines, lineIndex) {
  const line = lines[lineIndex]
  const anchors = []
  const consumedLines = new Set([lineIndex])
  // Some PDF text layers split a printed heading (e.g. "Last" + "Name") into
  // multiple positioned spans or place the words on adjacent baselines.
  for (let start = 0; start < line.items.length; start += 1) {
    for (let end = start; end < Math.min(line.items.length, start + 4); end += 1) {
      const key = matchHeaderField(line.items.slice(start, end + 1).map(item => item.text).join(' '))
      if (key) anchors.push({ key, x: line.items[start].x })
    }
    for (let nextIndex = lineIndex + 1; nextIndex < Math.min(lines.length, lineIndex + 3); nextIndex += 1) {
      const nearest = lines[nextIndex].items
        .filter(item => Math.abs(item.x - line.items[start].x) <= 18)
        .sort((a, b) => Math.abs(a.x - line.items[start].x) - Math.abs(b.x - line.items[start].x))[0]
      if (!nearest) continue
      const key = matchHeaderField(`${line.items[start].text} ${nearest.text}`)
      if (key) { anchors.push({ key, x: line.items[start].x }); consumedLines.add(nextIndex) }
      }
  }
  const unique = anchors.filter((anchor, index) => anchors.findIndex(item => item.key === anchor.key) === index).sort((a, b) => a.x - b.x)
  return unique.length >= 4 ? { anchors: unique, consumedLines } : null
}

function printablePageText(items) {
  const lines = groupByLine(items, 3)
  return lines.map(line => line.items.map(item => item.text).join(' ')).join('\n')
}

function isPageFurniture(line) {
  const text = clean(line.items.map(item => item.text).join(' '))
  return /^(?:page\s+)?\d+\s*(?:of|\/)\s*\d+$/i.test(text) || /^page\s+\d+$/i.test(text) ||
    /^student\s+directory\b/i.test(text) || /\bpage\s+\d+\s+of\s+\d+\b/i.test(text)
}

function columnForX(x, anchors) {
  return anchors.reduce((nearest, anchor) => !nearest || Math.abs(anchor.x - x) < Math.abs(nearest.x - x) ? anchor : nearest, null)?.key || null
}

function parseYear(value) {
  const raw = clean(value)
  if (!raw) return ''
  const match = raw.match(/\b([1-5])(?:st|nd|rd|th)?\b/i)
  if (match) return match[1]
  const wordYear = raw.toLowerCase().match(/\b(first|second|third|fourth|fifth)\b/)
  return wordYear ? String(['first', 'second', 'third', 'fourth', 'fifth'].indexOf(wordYear[1]) + 1) : raw
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0
}

function parseUnnumberedPage(lines, columns, pageNumber, headerBand) {
  const records = []
  let current = null
  for (const line of lines) {
    if (headerBand && line.y >= headerBand.min && line.y <= headerBand.max || isPageFurniture(line)) continue
    const cells = Object.fromEntries(FIELD_KEYS.map(key => [key, '']))
    for (const item of line.items) {
      const key = columnForX(item.x, columns)
      if (key) cells[key] = `${cells[key]} ${item.text}`.trim()
    }
    const looksLikeRecord = Boolean(cells.email || (cells.firstName && cells.lastName) || (cells.studentNumber && (cells.program || cells.yearLevel)))
    if (!columns.some(column => column.key === 'directoryRow') && looksLikeRecord) {
      if (current) records.push(makeRecord(null, current))
      current = cells
    } else if (current) {
      for (const key of FIELD_KEYS) if (key !== 'directoryRow' && cells[key]) current[key] = `${current[key]} ${cells[key]}`.trim()
    }
  }
  if (current) records.push(makeRecord(null, current))
  return records
}

function makeRecord(directoryRow, cells) {
  const studentNumber = clean(cells.studentNumber)
  return {
    directoryRow,
    studentNumber,
    lastName: clean(cells.lastName),
    firstName: clean(cells.firstName),
    middleInitial: clean(cells.middleInitial),
    program: clean(cells.program),
    yearLevel: parseYear(cells.yearLevel),
    sex: clean(cells.sex),
    email: clean(cells.email).replace(/\s+/g, ''),
    contactNumber: clean(cells.contactNumber),
    address: clean(cells.address),
    excluded: false
  }
}

/**
 * Parse positioned PDF text from every page. Record numbering is read from the
 * PDF, never inferred from an expected row count. Unnumbered records retain a
 * null directoryRow while still appearing in the preview.
 */
export function parseStudentDirectoryPages(pages) {
  const records = []
  const warnings = []
  // Build a line-oriented view of the PDF.js output first. Keep this exact
  // extraction diagnostic even if record/header interpretation fails.
  const rawText = pages.map((items, index) => `--- Page ${index + 1} ---\n${printablePageText(items)}`).join('\n\n')
  const pageLines = pages.map(items => groupByLine(items, 12))
  const pageHeaders = pageLines.map(lines => {
    for (let index = 0; index < lines.length; index += 1) {
      const header = detectHeader(lines, index)
      if (header) return header
    }
    return null
  })
  let priorAnchors = pageHeaders.find(Boolean)?.anchors || null
  let previousPageRecord = null

  for (const [pageIndex] of pages.entries()) {
    const lines = pageLines[pageIndex]
    const pageHeader = pageHeaders[pageIndex]
    const columns = pageHeader?.anchors || priorAnchors
    if (!columns?.length) { warnings.push(`Page ${pageIndex + 1}: could not detect the directory column headings.`); continue }
    priorAnchors = columns

    const headerY = pageHeader ? [...pageHeader.consumedLines].map(index => lines[index]?.y).filter(Number.isFinite) : []
    const headerBand = headerY.length ? { min: Math.min(...headerY) - 2, max: Math.max(...headerY) + 2 } : null
    const furnitureLines = lines.filter(isPageFurniture)
    const rowAnchor = columns.find(column => column.key === 'directoryRow')
    const firstDataX = Math.min(...columns.filter(column => column.key !== 'directoryRow').map(column => column.x))
    const normalizedItems = pages[pageIndex].filter(item => clean(item.str)).map(normalizeItem)
    const markers = normalizedItems.filter(item => {
      if (!/^#?\s*\d+\s*[.)]?\s*$/.test(item.text)) return false
      if (rowAnchor) return Math.abs(item.x - rowAnchor.x) <= 16
      return item.x < firstDataX - 3
    }).map(item => ({ item, row: Number(item.text.match(/\d+/)?.[0]) }))
      .filter(marker => Number.isSafeInteger(marker.row))

    if (!markers.length) {
      const fallback = parseUnnumberedPage(lines, columns, pageIndex + 1, headerBand)
      records.push(...fallback)
      continue
    }

    const pageRecords = markers.map(marker => ({ row: marker.row, y: marker.item.y, cells: Object.fromEntries(FIELD_KEYS.map(key => [key, []])) }))
    const orderedRows = [...pageRecords].sort((a, b) => b.y - a.y)
    const rowSpacings = orderedRows.slice(1).map((record, index) => Math.abs(orderedRows[index].y - record.y)).filter(value => value > 0)
    const defaultRadius = rowSpacings.length ? median(rowSpacings) / 2 + 2 : 16
    const markerItems = new Set(markers.map(marker => marker.item))
    const furnitureBands = furnitureLines.map(line => ({ min: line.y - 2, max: line.y + 2 }))

    for (const item of normalizedItems) {
      if (markerItems.has(item) || headerBand && item.y >= headerBand.min && item.y <= headerBand.max) continue
      if (furnitureBands.some(band => item.y >= band.min && item.y <= band.max)) continue
      const nearestIndex = pageRecords.reduce((best, record, index) =>
        Math.abs(record.y - item.y) < Math.abs(pageRecords[best].y - item.y) ? index : best, 0)
      const target = pageRecords[nearestIndex]
      const neighboringSpacings = [pageRecords[nearestIndex - 1], pageRecords[nearestIndex + 1]]
        .filter(Boolean).map(record => Math.abs(record.y - target.y))
      const radius = neighboringSpacings.length ? Math.min(...neighboringSpacings) / 2 + 2 : defaultRadius
      const key = columnForX(item.x, columns)
      if (Math.abs(target.y - item.y) > radius) {
        const firstRecordY = Math.max(...pageRecords.map(record => record.y))
        const isTopContinuation = previousPageRecord && item.y > firstRecordY && (!headerBand || item.y < headerBand.min - 4)
        if (isTopContinuation && key && key !== 'directoryRow') {
          previousPageRecord[key] = clean(`${previousPageRecord[key]} ${item.text}`)
          if (key === 'email') previousPageRecord[key] = previousPageRecord[key].replace(/\s+/g, '')
        }
        continue
      }
      if (key && key !== 'directoryRow') target.cells[key].push(item)
    }

    for (const record of pageRecords) {
      const cells = Object.fromEntries(FIELD_KEYS.map(key => [key, key === 'directoryRow' ? String(record.row) :
        record.cells[key].sort((a, b) => b.y - a.y || a.x - b.x).map(item => item.text).join(' ')]))
      records.push(makeRecord(record.row, cells))
    }
    previousPageRecord = records.at(-1) || previousPageRecord
  }

  const detectionSucceeded = records.length > 0
  const rowCounts = new Map()
  for (const record of records) if (Number.isSafeInteger(record.directoryRow)) rowCounts.set(record.directoryRow, (rowCounts.get(record.directoryRow) || 0) + 1)
  const numberedRows = [...rowCounts.keys()].sort((a, b) => a - b)
  const numberingGaps = []
  for (let index = 1; index < numberedRows.length; index += 1) {
    const from = numberedRows[index - 1] + 1
    const to = numberedRows[index] - 1
    if (from <= to) numberingGaps.push({ from, to, count: to - from + 1 })
  }
  const duplicateRows = [...rowCounts].filter(([, count]) => count > 1).map(([row]) => row)
  const expectedCountHint = findExplicitCountHint(rawText)
  if (!records.length) warnings.push('PDF text was extracted, but no member records could be interpreted. The PDF may use a different column layout; inspect the extracted text below and adjust the parser rather than treating all expected rows as missing.')
  if (numberingGaps.length) warnings.push(`Numbering gaps between detected records: ${numberingGaps.map(gap => gap.from === gap.to ? gap.from : `${gap.from}–${gap.to}`).join(', ')}.`)
  if (duplicateRows.length) warnings.push(`Repeated directory row numbers: ${duplicateRows.join(', ')}.`)
  if (expectedCountHint != null && records.length !== expectedCountHint) warnings.push(`The document mentions ${expectedCountHint} records, but ${records.length} were detected. Treat this as a review hint, not an automatically generated set of missing rows.`)
  return {
    records,
    warnings,
    duplicateRows,
    expectedCountHint,
    detectionSucceeded,
    numberingGaps,
    numberingStart: numberedRows.length ? numberedRows[0] : null,
    numberingEnd: numberedRows.length ? numberedRows.at(-1) : null,
    rawText
  }
}

function findExplicitCountHint(text) {
  const ranges = [...text.matchAll(/\brows?\s+(\d+)\s+to\s+(\d+)\b/gi)]
    .map(match => ({ start: Number(match[1]), end: Number(match[2]) }))
    .filter(range => Number.isSafeInteger(range.start) && Number.isSafeInteger(range.end) && range.end >= range.start)
  if (ranges.length) {
    const documentRange = ranges.reduce((largest, range) => range.end - range.start > largest.end - largest.start ? range : largest)
    return documentRange.end - documentRange.start + 1
  }
  const patterns = [
    /\btotal\s+(?:of\s+)?(\d+)\s+(?:students|members|records|entries)\b/i,
    /\b(?:students|members|records|entries)\s*[:=]\s*(\d+)\b/i,
    /\b(\d+)\s+(?:students|members|records|entries)\s+in\s+total\b/i
  ]
  for (const pattern of patterns) {
    const match = text.match(pattern)
    if (match && Number.isSafeInteger(Number(match[1]))) return Number(match[1])
  }
  return null
}
