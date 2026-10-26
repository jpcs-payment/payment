import { parseStudentDirectoryPages } from './studentDirectoryParser.js'

export const MAX_DIRECTORY_PDF_BYTES = 100 * 1024 * 1024

export function classifyPdfTextPages(pages) {
  if (!Array.isArray(pages) || pages.length === 0) return 'empty-document'
  return pages.some(page => page.some(item => typeof item.str === 'string' && item.str.trim())) ? 'has-text' : 'no-selectable-text'
}

export function pdfReadErrorMessage(error) {
  const message = String(error?.message || '').toLowerCase()
  if (message.includes('password') || message.includes('encrypted')) return 'This PDF is encrypted or password-protected. Remove its protection and retry.'
  return 'Could not read this PDF. It may be malformed or unreadable.'
}

export async function extractStudentDirectoryPdf(file, onProgress = () => {}) {
  if (!file || file.type !== 'application/pdf' && !file.name?.toLowerCase().endsWith('.pdf')) {
    throw new Error('Choose a PDF file to import.')
  }
  if (file.size > MAX_DIRECTORY_PDF_BYTES) throw new Error('The PDF must be 100 MB or smaller.')
  if (!file.size) throw new Error('The selected PDF is empty.')

  const [pdfjsLib, workerModule] = await Promise.all([
    import('pdfjs-dist'),
    import('pdfjs-dist/build/pdf.worker.min.mjs?url')
  ])
  pdfjsLib.GlobalWorkerOptions.workerSrc = workerModule.default
  const data = new Uint8Array(await file.arrayBuffer())
  let pdf
  try {
    pdf = await pdfjsLib.getDocument({ data, isEvalSupported: false }).promise
    if (!pdf.numPages) throw new Error('No pages were found in this PDF.')
    const pages = []
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber)
      const content = await page.getTextContent()
      pages.push(content.items.filter(item => typeof item.str === 'string' && item.str.trim()).map(item => ({
        str: item.str,
        transform: item.transform,
        width: item.width,
        hasEOL: item.hasEOL
      })))
      onProgress({ phase: 'extracting', page: pageNumber, pages: pdf.numPages })
    }
    const textStatus = classifyPdfTextPages(pages)
    if (textStatus === 'no-selectable-text') {
      throw new Error('This PDF contains no selectable text. It may be scanned; use a searchable PDF or enable OCR before importing.')
    }
    return { ...parseStudentDirectoryPages(pages), pageCount: pdf.numPages }
  } catch (error) {
    if (error instanceof Error && /selectable text|No pages/.test(error.message)) throw error
    throw new Error(pdfReadErrorMessage(error))
  } finally {
    await pdf?.destroy()
  }
}

export async function fingerprintFile(file) {
  if (!globalThis.crypto?.subtle) throw new Error('Secure file hashing is unavailable in this browser.')
  const digest = await globalThis.crypto.subtle.digest('SHA-256', await file.arrayBuffer())
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')
}
