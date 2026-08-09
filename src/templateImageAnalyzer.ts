export type TemplateElementKind = 'text' | 'price' | 'spec' | 'badge' | 'qr' | 'image' | 'iconSpec' | 'colors' | 'divider' | 'footnote'

export interface TemplateTagElement {
  id: string
  kind: TemplateElementKind
  text: string
  x: number
  y: number
  width: number
  height: number
  fontSize: number
  fontWeight: number
  color: string
  background: string
  align: 'left' | 'center' | 'right'
  radius: number
  singleLine?: boolean
}

export interface TemplateOcrLine {
  text: string
  confidence: number
  bbox: { x0: number; y0: number; x1: number; y1: number }
}

export interface TemplateAnalysisProgress {
  status: string
  progress: number
}

export interface TemplateAnalysisResult {
  elements: TemplateTagElement[]
  imageWidth: number
  imageHeight: number
  recognizedText: string
}

interface TextBoxLike {
  kind: string
  text: string
  width: number
  height: number
  fontSize: number
  singleLine?: boolean
}

const round = (value: number, digits = 1) => {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))

const textMeasureUnits = (value: string) => Array.from(value).reduce((total, character) => {
  if (/\s/.test(character)) return total + 0.32
  if (/[/|·・,，、:+＋-]/.test(character)) return total + 0.34
  if (/[A-Z]/.test(character)) return total + 0.62
  if (/[a-z0-9]/.test(character)) return total + 0.56
  if (/[\u4e00-\u9fff]/.test(character)) return total + 1
  return total + 0.7
}, 0)

function estimatedLineCount(text: string, width: number, fontSize: number, singleLine: boolean) {
  if (singleLine) return 1
  const capacity = Math.max(1, (width * 0.92) / Math.max(fontSize, 0.1))
  return text.split('\n').reduce((lines, segment) => (
    lines + Math.max(1, Math.ceil(textMeasureUnits(segment) / capacity))
  ), 0)
}

function textFits(element: TextBoxLike, fontSize: number) {
  if (!element.text.trim()) return true
  const widthFactor = element.kind === 'iconSpec' ? 0.72 : 1
  const width = Math.max(0.1, element.width * widthFactor)
  const height = Math.max(0.1, element.height)
  const singleLine = Boolean(element.singleLine)
  if (singleLine && textMeasureUnits(element.text) * fontSize > width * 0.92) return false
  const lineCount = estimatedLineCount(element.text, width, fontSize, singleLine)
  return lineCount * fontSize * 1.12 <= height * 0.98
}

/** Returns the largest safe font size that keeps all text inside its box. */
export function fitElementFontSize(element: TextBoxLike) {
  if (!element.text.trim() || ['divider', 'image', 'qr'].includes(element.kind)) return element.fontSize
  const desired = Math.max(0.55, element.fontSize)
  if (textFits(element, desired)) return round(desired, 2)

  let low = 0.55
  let high = desired
  for (let index = 0; index < 18; index += 1) {
    const middle = (low + high) / 2
    if (textFits(element, middle)) low = middle
    else high = middle
  }
  return round(low, 2)
}

/** Keeps an element inside the printable card and re-fits its font. */
export function constrainElementToBounds<T extends TemplateTagElement>(element: T, cardWidth: number, cardHeight: number): T {
  const safeCardWidth = Math.max(1, cardWidth)
  const safeCardHeight = Math.max(1, cardHeight)
  const width = clamp(element.width, 0.5, safeCardWidth)
  const height = clamp(element.height, 0.3, safeCardHeight)
  const x = clamp(element.x, 0, Math.max(0, safeCardWidth - width))
  const y = clamp(element.y, 0, Math.max(0, safeCardHeight - height))
  const bounded = { ...element, x: round(x), y: round(y), width: round(width), height: round(height) }
  return { ...bounded, fontSize: fitElementFontSize(bounded) }
}

function inferKind(text: string, yRatio: number, heightRatio: number): TemplateElementKind {
  if (/(?:¥|￥|RMB|CNY|USD|\$)\s*[\d,.]+/i.test(text)) return 'price'
  if (yRatio > 0.86 || text.length > 45) return 'footnote'
  if (heightRatio > 0.045 && text.length <= 18) return 'badge'
  if (/[：:]|\d+(?:GB|TB|Hz|W|mAh|MP|英寸)/i.test(text)) return 'spec'
  return 'text'
}

function overlaps(a: TemplateTagElement, b: TemplateTagElement, gap = 0.25) {
  return a.x < b.x + b.width + gap
    && a.x + a.width + gap > b.x
    && a.y < b.y + b.height + gap
    && a.y + a.height + gap > b.y
}

function removeLayoutCollisions(elements: TemplateTagElement[], cardWidth: number, cardHeight: number, margin: number) {
  const placed: TemplateTagElement[] = []
  const sorted = [...elements].sort((a, b) => a.y - b.y || a.x - b.x)

  for (const source of sorted) {
    let next = constrainElementToBounds(source, cardWidth, cardHeight)
    for (const previous of placed) {
      if (!overlaps(next, previous)) continue
      const shiftedY = previous.y + previous.height + 0.35
      next = constrainElementToBounds({ ...next, y: shiftedY }, cardWidth, cardHeight)
    }
    placed.push(next)
  }

  const maxBottom = Math.max(...placed.map((element) => element.y + element.height), margin)
  const printableBottom = cardHeight - margin
  if (maxBottom <= printableBottom) return placed

  const scale = clamp((printableBottom - margin) / Math.max(1, maxBottom - margin), 0.55, 1)
  return placed.map((element) => constrainElementToBounds({
    ...element,
    y: margin + (element.y - margin) * scale,
    height: element.height * scale,
    fontSize: element.fontSize * scale,
  }, cardWidth, cardHeight))
}

export function createTemplateElementsFromLines(
  lines: TemplateOcrLine[],
  imageWidth: number,
  imageHeight: number,
  cardWidth: number,
  cardHeight: number,
) {
  const safeImageWidth = Math.max(1, imageWidth)
  const safeImageHeight = Math.max(1, imageHeight)
  const safeCardWidth = Math.max(20, cardWidth)
  const safeCardHeight = Math.max(20, cardHeight)
  const margin = clamp(Math.min(safeCardWidth, safeCardHeight) * 0.025, 1.2, 3)
  const usableWidth = safeCardWidth - margin * 2
  const usableHeight = safeCardHeight - margin * 2
  const cleanLines = lines
    .map((line) => ({ ...line, text: line.text.replace(/\s+/g, ' ').trim() }))
    .filter((line) => line.text && line.confidence >= 25 && line.bbox.x1 > line.bbox.x0 && line.bbox.y1 > line.bbox.y0)
    .slice(0, 80)
  const heights = cleanLines.map((line) => line.bbox.y1 - line.bbox.y0).sort((a, b) => a - b)
  const medianHeight = heights[Math.floor(heights.length / 2)] || safeImageHeight * 0.03

  const elements = cleanLines.map((line) => {
    const xRatio = clamp(line.bbox.x0 / safeImageWidth, 0, 1)
    const yRatio = clamp(line.bbox.y0 / safeImageHeight, 0, 1)
    const widthRatio = clamp((line.bbox.x1 - line.bbox.x0) / safeImageWidth, 0.01, 1)
    const heightRatio = clamp((line.bbox.y1 - line.bbox.y0) / safeImageHeight, 0.008, 1)
    const paddingX = clamp(safeCardWidth * 0.008, 0.45, 1.2)
    const paddingY = clamp(safeCardHeight * 0.004, 0.25, 0.8)
    const rawHeight = heightRatio * usableHeight + paddingY * 2
    const kind = inferKind(line.text, yRatio, heightRatio)
    const isLarge = (line.bbox.y1 - line.bbox.y0) >= medianHeight * 1.35
    const desiredFontSize = clamp(rawHeight * 0.72, 1.1, Math.min(safeCardWidth, safeCardHeight) * 0.085)
    const element: TemplateTagElement = {
      id: crypto.randomUUID(),
      kind,
      text: line.text,
      x: margin + xRatio * usableWidth - paddingX,
      y: margin + yRatio * usableHeight - paddingY,
      width: Math.max(5, widthRatio * usableWidth + paddingX * 2),
      height: Math.max(2.2, rawHeight),
      fontSize: desiredFontSize,
      fontWeight: kind === 'price' || kind === 'badge' || isLarge ? 800 : 500,
      color: kind === 'price' ? '#111827' : '#27303f',
      background: 'transparent',
      align: kind === 'price' && xRatio > 0.52 ? 'right' : 'left',
      radius: 0,
      singleLine: true,
    }
    return constrainElementToBounds(element, safeCardWidth, safeCardHeight)
  })

  return removeLayoutCollisions(elements, safeCardWidth, safeCardHeight, margin)
}

function fallbackLinesFromText(text: string, imageWidth: number, imageHeight: number): TemplateOcrLine[] {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).slice(0, 40)
  const top = imageHeight * 0.08
  const rowHeight = Math.max(16, (imageHeight * 0.84) / Math.max(1, lines.length))
  return lines.map((line, index) => ({
    text: line,
    confidence: 50,
    bbox: {
      x0: imageWidth * 0.08,
      y0: top + index * rowHeight,
      x1: imageWidth * 0.92,
      y1: top + (index + 0.72) * rowHeight,
    },
  }))
}

function collectOcrLines(blocks: unknown): TemplateOcrLine[] {
  if (!Array.isArray(blocks)) return []
  const lines: TemplateOcrLine[] = []
  for (const block of blocks) {
    const paragraphs = (block as { paragraphs?: unknown }).paragraphs
    if (!Array.isArray(paragraphs)) continue
    for (const paragraph of paragraphs) {
      const paragraphLines = (paragraph as { lines?: unknown }).lines
      if (!Array.isArray(paragraphLines)) continue
      for (const line of paragraphLines) {
        const candidate = line as { text?: unknown; confidence?: unknown; bbox?: Partial<TemplateOcrLine['bbox']> }
        const bbox = candidate.bbox
        if (typeof candidate.text !== 'string' || !bbox) continue
        if (![bbox.x0, bbox.y0, bbox.x1, bbox.y1].every((value) => typeof value === 'number')) continue
        lines.push({
          text: candidate.text,
          confidence: typeof candidate.confidence === 'number' ? candidate.confidence : 0,
          bbox: bbox as TemplateOcrLine['bbox'],
        })
      }
    }
  }
  return lines
}

export async function analyzeTemplateImage(
  file: File,
  cardWidth: number,
  cardHeight: number,
  onProgress?: (progress: TemplateAnalysisProgress) => void,
): Promise<TemplateAnalysisResult> {
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' })
  const imageWidth = bitmap.width
  const imageHeight = bitmap.height
  bitmap.close()

  const { createWorker, PSM } = await import('tesseract.js')
  const worker = await createWorker(['chi_sim', 'eng'], 1, {
    logger: (message) => onProgress?.({ status: message.status, progress: message.progress }),
  })

  try {
    await worker.setParameters({
      tessedit_pageseg_mode: PSM.SPARSE_TEXT,
      preserve_interword_spaces: '1',
      user_defined_dpi: '300',
    })
    const result = await worker.recognize(file, { rotateAuto: true }, { text: true, blocks: true })
    const recognizedText = result.data.text.trim()
    const ocrLines = collectOcrLines(result.data.blocks)
    const lines = ocrLines.length ? ocrLines : fallbackLinesFromText(recognizedText, imageWidth, imageHeight)
    const elements = createTemplateElementsFromLines(lines, imageWidth, imageHeight, cardWidth, cardHeight)
    return { elements, imageWidth, imageHeight, recognizedText }
  } finally {
    await worker.terminate()
  }
}
