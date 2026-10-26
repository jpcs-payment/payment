import test from 'node:test'
import assert from 'node:assert/strict'
import { access, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { parseStudentDirectoryPages } from './studentDirectoryParser.js'

const item = (str, x, y) => ({ str, transform: [1, 0, 0, 1, x, y] })
const header = y => [
  item('No.', 10, y), item('Student No.', 42, y), item('Last Name', 120, y), item('First Name', 220, y),
  item('M.I.', 320, y), item('Program', 360, y), item('Year Level', 450, y), item('Sex', 520, y),
  item('Email', 560, y), item('Contact Number', 680, y), item('Address', 800, y)
]

test('parses records across pages and keeps wrapped address values with their row', () => {
  const pages = [
    [
      ...header(700), item('1', 10, 680), item('2024-0001', 42, 680), item('Dela Cruz', 120, 680), item('Ana Marie', 220, 680),
      item('B.', 320, 680), item('BSIT', 360, 680), item('2nd Year', 450, 680), item('F', 520, 680),
      item('ana@example.edu', 560, 680), item('09171234567', 680, 680), item('12 Mabini Street,', 800, 680),
      item('Barangay Uno', 800, 670)
    ],
    [...header(700), item('2', 10, 680), item('2024-0002', 42, 680), item('Santos-Reyes', 120, 680), item('Juan', 220, 680), item('C.', 320, 680), item('BSCS', 360, 680), item('1', 450, 680), item('M', 520, 680), item('juan@example.edu', 560, 680), item('09170000000', 680, 680), item('Lipa City', 800, 680)]
  ]
  const result = parseStudentDirectoryPages(pages)
  assert.equal(result.records.length, 2)
  assert.equal(result.records[0].lastName, 'Dela Cruz')
  assert.equal(result.records[0].address, '12 Mabini Street, Barangay Uno')
  assert.equal(result.records[1].lastName, 'Santos-Reyes')
  assert.equal(result.records[1].directoryRow, 2)
  assert.deepEqual(result.numberingGaps, [])
})

test('reports only numbering gaps bounded by observed directory numbers', () => {
  const result = parseStudentDirectoryPages([[
    ...header(700), item('7', 10, 680), item('1007', 42, 680), item('Dela Cruz', 120, 680), item('Ana', 220, 680), item('BSIT', 360, 680), item('2', 450, 680), item('ana@example.edu', 560, 680),
    item('9', 10, 660), item('1009', 42, 660), item('Santos', 120, 660), item('Bea', 220, 660), item('BSCS', 360, 660), item('3', 450, 660), item('bea@example.edu', 560, 660)
  ]])
  assert.deepEqual(result.numberingGaps, [{ from: 8, to: 8, count: 1 }])
  assert.ok(result.warnings.some(warning => warning.includes('8')))
})

test('assigns directory row numbers in order when the PDF has no serial-number column', () => {
  const pages = [[
    item('Student No.', 40, 700), item('Last Name', 120, 700), item('First Name', 220, 700), item('Program', 360, 700), item('Year Level', 450, 700), item('Email', 560, 700),
    item('2024-0001', 40, 680), item('Reyes', 120, 680), item('Maria', 220, 680), item('BSIT', 360, 680), item('1st Year', 450, 680), item('maria@example.edu', 560, 680),
    item('2024-0002', 40, 660), item('Dela Cruz', 120, 660), item('Juan', 220, 660), item('BSCS', 360, 660), item('2nd Year', 450, 660), item('juan@example.edu', 560, 660)
  ]]
  const result = parseStudentDirectoryPages(pages)
  assert.deepEqual(result.records.map(record => record.directoryRow), [null, null])
  assert.equal(result.records[1].studentNumber, '2024-0002')
})

test('keeps blank fields blank without pulling values from the next student', () => {
  const result = parseStudentDirectoryPages([[
    ...header(700), item('1', 10, 680), item('1001', 42, 680), item('Missing', 120, 680),
    item('2', 10, 660), item('1002', 42, 660), item('Present', 120, 660), item('Has First Name', 220, 660), item('present@example.edu', 560, 660)
  ]])
  assert.equal(result.records.length, 2)
  assert.equal(result.records[0].email, '')
  assert.equal(result.records[1].email, 'present@example.edu')
})

test('reconstructs records when the row number and cell values are extracted on separate lines', () => {
  const result = parseStudentDirectoryPages([[
    ...header(720),
    item('1.', 10, 690),
    item('2025-001', 42, 680), item('Dela', 120, 680), item('Ana', 220, 680), item('B.', 320, 680),
    item('BSIT', 360, 680), item('2nd Year', 450, 680), item('F', 520, 680), item('ana@example.edu', 560, 680),
    item('09171234567', 680, 680), item('12 Mabini St.', 800, 680),
    item('Cruz', 120, 670), item('Barangay Uno', 800, 670),
    item('2', 10, 650),
    item('2025-002', 42, 640), item('Reyes', 120, 640), item('Bea', 220, 640), item('BSCS', 360, 640),
    item('1', 450, 640), item('bea@example.edu', 560, 640), item('Lipa City', 800, 640)
  ]])

  assert.equal(result.records.length, 2)
  assert.deepEqual(result.records.map(record => record.directoryRow), [1, 2])
  assert.equal(result.records[0].lastName, 'Dela Cruz')
  assert.equal(result.records[0].address, '12 Mabini St. Barangay Uno')
  assert.equal(result.records[1].studentNumber, '2025-002')
  assert.equal(result.records[1].email, 'bea@example.edu')
  assert.deepEqual(result.numberingGaps, [])
})

test('recognizes split header labels and keeps text from a missing field blank', () => {
  const result = parseStudentDirectoryPages([[
    item('No.', 10, 720), item('Student', 42, 720), item('Number', 72, 720),
    item('Last', 120, 720), item('Name', 150, 720), item('First Name', 220, 720), item('Program', 360, 720),
    item('Year Level', 450, 720), item('Email', 560, 720),
    item('1', 10, 680), item('2025-001', 42, 680), item('Santos', 120, 680), item('Lia', 220, 680),
    item('BSIT', 360, 680), item('2', 450, 680), item('lia@example.edu', 560, 680)
  ]])
  assert.equal(result.records.length, 1)
  assert.equal(result.records[0].lastName, 'Santos')
  assert.equal(result.records[0].studentNumber, '2025-001')
  assert.equal(result.records[0].contactNumber, '')
  assert.equal(result.records[0].address, '')
})

test('does not calculate missing directory rows when no record was detected', () => {
  const result = parseStudentDirectoryPages([[item('A searchable but unsupported layout', 10, 700)]])
  assert.equal(result.detectionSucceeded, false)
  assert.equal(result.records.length, 0)
  assert.deepEqual(result.numberingGaps, [])
  assert.match(result.warnings.join(' '), /no member records could be interpreted/i)
  assert.match(result.rawText, /A searchable but unsupported layout/)
})

function generatedDirectory(rowNumbers) {
  const page = [...header(rowNumbers.length * 20 + 100)]
  rowNumbers.forEach((row, index) => {
    const y = rowNumbers.length * 20 + 80 - index * 20
    page.push(
      item(String(row), 10, y), item(`ST-${row}`, 42, y), item(`Last${row}`, 120, y), item(`First${row}`, 220, y),
      item('Q.', 320, y), item('BSCS', 360, y), item('2', 450, y), item('F', 520, y),
      item(`student${row}@example.edu`, 560, y), item(`0917${String(row).padStart(7, '0')}`, 680, y), item(`${row} Sample Street`, 800, y)
    )
  })
  return [page]
}

test('detects generated directories of 5, 94, 150, 500, and 1,000 records without count caps', () => {
  for (const count of [5, 94, 150, 500, 1000]) {
    const rows = Array.from({ length: count }, (_, index) => index + 1)
    const result = parseStudentDirectoryPages(generatedDirectory(rows))
    assert.equal(result.records.length, count, `record count ${count}`)
    assert.equal(result.records[0].directoryRow, 1)
    assert.equal(result.records.at(-1).directoryRow, count)
    assert.deepEqual(result.numberingGaps, [])
    assert.equal(result.records.at(-1).email, `student${count}@example.edu`)
  }
})

test('preserves non-one starting numbers and identifies duplicate and gapped numbering', () => {
  const result = parseStudentDirectoryPages(generatedDirectory([25, 26, 28, 28]))
  assert.deepEqual(result.records.map(record => record.directoryRow), [25, 26, 28, 28])
  assert.equal(result.numberingStart, 25)
  assert.equal(result.numberingEnd, 28)
  assert.deepEqual(result.numberingGaps, [{ from: 27, to: 27, count: 1 }])
  assert.deepEqual(result.duplicateRows, [28])
})

test('retains malformed and incomplete numbered records for preview instead of dropping them', () => {
  const result = parseStudentDirectoryPages([[
    ...header(700), item('3', 10, 680), item('ST-3', 42, 680), item('OnlyLast', 120, 680),
    item('4', 10, 660), item('ST-4', 42, 660), item('Surname', 120, 660), item('Given', 220, 660), item('not-an-email', 560, 660)
  ]])
  assert.equal(result.records.length, 2)
  assert.equal(result.records[0].firstName, '')
  assert.equal(result.records[0].email, '')
  assert.equal(result.records[1].email, 'not-an-email')
})

test('records a clear document total as a hint without fabricating rows', () => {
  const result = parseStudentDirectoryPages([[
    item('Total of 150 students', 10, 740), ...header(700),
    item('10', 10, 680), item('ST-10', 42, 680), item('One', 120, 680), item('First', 220, 680), item('one@example.edu', 560, 680),
    item('11', 10, 660), item('ST-11', 42, 660), item('Two', 120, 660), item('Second', 220, 660), item('two@example.edu', 560, 660)
  ]])
  assert.equal(result.expectedCountHint, 150)
  assert.equal(result.records.length, 2)
})

test('reconstructs names, program, email, and address wrapped across rows and pages while ignoring repeated furniture', () => {
  const pages = [
    [
      ...header(740), item('5', 10, 710), item('ST-5', 42, 710), item('De', 120, 710), item('Maria', 220, 710),
      item('Computer', 360, 710), item('2', 450, 710), item('F', 520, 710), item('maria.user@', 560, 710),
      item('0917123', 680, 710), item('12 Main', 800, 710),
      item('Page 1 of 2', 400, 20)
    ],
    [
      ...header(740), item('La Cruz', 120, 720), item('Clara', 220, 720), item('Engineering', 360, 720), item('gmail.com', 560, 720), item('4567', 680, 720), item('Street, Lipa', 800, 720),
      item('6', 10, 700), item('ST-6', 42, 700), item('Reyes', 120, 700), item('Ana', 220, 700),
      item('BSIT', 360, 700), item('1', 450, 700), item('F', 520, 700), item('ana@example.edu', 560, 700),
      item('09170000000', 680, 700), item('Lipa City', 800, 700), item('Page 2 of 2', 400, 20)
    ]
  ]
  const result = parseStudentDirectoryPages(pages)
  assert.equal(result.records.length, 2)
  assert.equal(result.records[0].directoryRow, 5)
  assert.equal(result.records[0].lastName, 'De La Cruz')
  assert.equal(result.records[0].firstName, 'Maria Clara')
  assert.equal(result.records[0].program, 'Computer Engineering')
  assert.equal(result.records[0].email, 'maria.user@gmail.com')
  assert.equal(result.records[0].contactNumber, '0917123 4567')
  assert.equal(result.records[0].address, '12 Main Street, Lipa')
  assert.equal(result.records[1].directoryRow, 6)
})

test('detects column headings split onto adjacent baselines', () => {
  const result = parseStudentDirectoryPages([[
    item('No.', 10, 740), item('Last', 120, 740), item('First', 220, 740), item('Program', 360, 740), item('Year', 450, 740), item('Email', 560, 740),
    item('Name', 120, 730), item('Name', 220, 730), item('Level', 450, 730),
    item('24', 10, 700), item('Santos', 120, 700), item('Bea', 220, 700), item('BSCS', 360, 700), item('2', 450, 700), item('bea@example.edu', 560, 700)
  ]])
  assert.equal(result.records.length, 1)
  assert.equal(result.records[0].directoryRow, 24)
  assert.equal(result.records[0].lastName, 'Santos')
})

const actualPdfPath = fileURLToPath(new URL('../../Cleaned Student Directory.pdf', import.meta.url))
let actualPdfAvailable = true
try { await access(actualPdfPath) } catch { actualPdfAvailable = false }

test('parses the real cleaned directory PDF when it is present, without storing its member data in fixtures', { skip: !actualPdfAvailable }, async () => {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const data = new Uint8Array(await readFile(actualPdfPath))
  const pdf = await pdfjs.getDocument({ data, disableWorker: true, isEvalSupported: false }).promise
  try {
    const pages = []
    for (let number = 1; number <= pdf.numPages; number += 1) {
      const content = await (await pdf.getPage(number)).getTextContent()
      pages.push(content.items.filter(entry => entry.str.trim()).map(entry => ({ str: entry.str, transform: entry.transform, width: entry.width, hasEOL: entry.hasEOL })))
    }
    const result = parseStudentDirectoryPages(pages)
    assert.equal(pdf.numPages, 4)
    assert.equal(result.records.length, 93)
    assert.equal(result.expectedCountHint, 94)
    assert.equal(result.records[0].directoryRow, 1)
    assert.equal(result.records.at(-1).directoryRow, 94)
    assert.deepEqual(result.numberingGaps, [{ from: 24, to: 24, count: 1 }])
    const sample = result.records[0]
    assert.ok(sample.lastName && sample.firstName && sample.program)
    assert.match(sample.email, /^[^\s@]+@[^\s@]+\.[^\s@]+$/)
    assert.match(sample.contactNumber, /^\d{10,11}$/)
    assert.ok(sample.address)
    assert.equal(result.records.find(record => record.directoryRow === 8)?.program, 'Computer Engineering')
  } finally {
    await pdf.destroy()
  }
})
