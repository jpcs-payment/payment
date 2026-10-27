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

  const [pdfjsLib, workerModule, tesseract] = await Promise.all([
    import('pdfjs-dist'),
    import('pdfjs-dist/build/pdf.worker.min.mjs?url'),
    import('tesseract.js')
  ])
  pdfjsLib.GlobalWorkerOptions.workerSrc = workerModule.default
  const data = new Uint8Array(await file.arrayBuffer())
  let pdf
  let ocrWorker
  try {
    pdf = await pdfjsLib.getDocument({ data, isEvalSupported: false }).promise
    if (!pdf.numPages) throw new Error('No pages were found in this PDF.')
    const pages = []
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber)
      const content = await page.getTextContent()
      let items = content.items.filter(item => typeof item.str === 'string' && item.str.trim()).map(item => ({
        str: item.str,
        transform: item.transform,
        width: item.width,
        hasEOL: item.hasEOL
      }))
      if (!items.length) {
        if (!ocrWorker) ocrWorker = await tesseract.createWorker('eng')
        onProgress({ phase: 'ocr', page: pageNumber, pages: pdf.numPages })
        const viewport = page.getViewport({ scale: 2 })
        const canvas = document.createElement('canvas')
        canvas.width = Math.ceil(viewport.width)
        canvas.height = Math.ceil(viewport.height)
        const context = canvas.getContext('2d')
        if (!context) throw new Error('OCR could not create a canvas for this PDF page.')
        await page.render({ canvasContext: context, viewport }).promise
        const result = await ocrWorker.recognize(canvas)
        items = (result.data.words || []).filter(word => word.text?.trim()).map(word => ({
          str: word.text,
          transform: [1, 0, 0, 1, word.bbox.x0, viewport.height - word.bbox.y1],
          width: word.bbox.x1 - word.bbox.x0,
          hasEOL: false
        }))
        canvas.width = 0
        canvas.height = 0
      } else {
        onProgress({ phase: 'extracting', page: pageNumber, pages: pdf.numPages })
      }
      pages.push(items)
    }
    return { ...parseStudentDirectoryPages(pages), pageCount: pdf.numPages }
  } catch (error) {
    if (error instanceof Error && /No pages|OCR could not/.test(error.message)) throw error
    throw new Error(pdfReadErrorMessage(error))
  } finally {
    await ocrWorker?.terminate()
    await pdf?.destroy()
  }
}

export async function fingerprintFile(file) {
  if (!globalThis.crypto?.subtle) throw new Error('Secure file hashing is unavailable in this browser.')
  const digest = await globalThis.crypto.subtle.digest('SHA-256', await file.arrayBuffer())
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')
}
