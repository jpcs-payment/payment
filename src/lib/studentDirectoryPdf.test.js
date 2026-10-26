import test from 'node:test'
import assert from 'node:assert/strict'
import { classifyPdfTextPages, extractStudentDirectoryPdf, MAX_DIRECTORY_PDF_BYTES, pdfReadErrorMessage } from './studentDirectoryPdf.js'

test('distinguishes a document with no pages from a scanned PDF with no selectable text', () => {
  assert.equal(classifyPdfTextPages([]), 'empty-document')
  assert.equal(classifyPdfTextPages([[]]), 'no-selectable-text')
  assert.equal(classifyPdfTextPages([[{ str: 'Selectable text' }]]), 'has-text')
})

test('reports unreadable and password-protected PDF errors separately from parser layout failures', () => {
  assert.match(pdfReadErrorMessage(new Error('Invalid PDF structure')), /malformed or unreadable/i)
  assert.match(pdfReadErrorMessage(new Error('Password required')), /encrypted or password-protected/i)
})

test('rejects empty, non-PDF, and oversized files before parsing', async () => {
  await assert.rejects(extractStudentDirectoryPdf({ name: 'empty.pdf', type: 'application/pdf', size: 0 }), /empty/i)
  await assert.rejects(extractStudentDirectoryPdf({ name: 'notes.txt', type: 'text/plain', size: 1 }), /choose a pdf/i)
  await assert.rejects(extractStudentDirectoryPdf({ name: 'large.pdf', type: 'application/pdf', size: MAX_DIRECTORY_PDF_BYTES + 1 }), /100 mb/i)
})
