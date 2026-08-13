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
  iconKey?: 'battery' | 'chip' | 'eye' | 'volume' | 'signal' | 'shield' | 'charge' | 'camera' | 'phone'
  iconBackground?: string
  iconColor?: string
  singleLine?: boolean
}

/** AI 视觉识别给出的字号档位：大标题 / 价格 / 正文 / 脚注小字 */
export type TemplateFontRole = 'title' | 'price' | 'normal' | 'small'

export interface TemplateOcrLine {
  text: string
  confidence: number
  bbox: { x0: number; y0: number; x1: number; y1: number }
  /** 语义字号档位（AI 路径提供），用于把字号归一到少数几档 */
  fontRole?: TemplateFontRole
  /** 文字是否加粗（AI 路径提供） */
  bold?: boolean
  /** 该行在版面中的对齐方式（AI 路径提供） */
  align?: 'left' | 'center' | 'right'
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

export function inferIconKey(text: string): TemplateTagElement['iconKey'] {
  if (/(?:电池|续航|电量|耐久)/i.test(text)) return 'battery'
  if (/(?:芯片|处理器|性能|CPU|A\d{2,})/i.test(text)) return 'chip'
  if (/(?:相机|摄像|影像|拍照|镜头|像素)/i.test(text)) return 'camera'
  if (/(?:屏幕|显示|亮度|视觉|色彩)/i.test(text)) return 'eye'
  if (/(?:音频|扬声|音质|立体声|喇叭)/i.test(text)) return 'volume'
  if (/(?:信号|通信|网络|Wi[ -]?Fi|定位)/i.test(text)) return 'signal'
  if (/(?:防水|耐用|安全|防护|保修|保障)/i.test(text)) return 'shield'
  if (/(?:快充|充电|功率|电源|无线充)/i.test(text)) return 'charge'
  if (/(?:手机|轻薄|机身|便携|掌上)/i.test(text)) return 'phone'
  return undefined
}

function inferKind(text: string, yRatio: number, heightRatio: number): TemplateElementKind {
  if (/(?:¥|￥|RMB|CNY|USD|\$)\s*[\d,.]+/i.test(text)) return 'price'
  if (yRatio > 0.86 || text.length > 45) return 'footnote'
  if (inferIconKey(text)) return 'iconSpec'
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
      // 同一视觉行的重叠优先水平错开，保持原图的行结构；放不下再退回下移
      const sameRow = Math.abs(centerYOf(next) - centerYOf(previous)) < Math.max(next.height, previous.height) * 0.5
      if (sameRow) {
        const shiftedX = previous.x + previous.width + 0.35
        if (shiftedX + next.width <= cardWidth - margin + 0.01) {
          next = constrainElementToBounds({ ...next, x: shiftedX }, cardWidth, cardHeight)
          continue
        }
      }
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

const centerYOf = (element: TemplateTagElement) => element.y + element.height / 2

const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

/** 参与字号统一的元素：有文字且不是纯图形类 */
const hasClusterableFont = (element: TemplateTagElement) => (
  Boolean(element.text.trim()) && !['divider', 'image', 'qr'].includes(element.kind)
)

/**
 * 识别结果的排版归一：
 * 1. 同一视觉行的元素垂直居中对齐（消除 bbox 抖动造成的错位）
 * 2. 左边缘相近的元素对齐成列
 * 3. 字号聚类成少数几档（有语义档位按档位统一，否则按数值聚类）
 * 4. 统一字号后扩展单行元素的盒子，避免文字被二次压缩
 */
export function harmonizeTemplateLayout(
  elements: TemplateTagElement[],
  roleById: Map<string, TemplateFontRole | undefined>,
  cardWidth: number,
  cardHeight: number,
): TemplateTagElement[] {
  if (!elements.length) return elements
  const result = elements.map((element) => ({ ...element }))

  // 1. 行对齐：按 y 中心贪心分组，同组取平均中心
  const byCenterY = [...result].sort((a, b) => centerYOf(a) - centerYOf(b))
  const rows: TemplateTagElement[][] = []
  for (const element of byCenterY) {
    const lastRow = rows[rows.length - 1]
    if (lastRow) {
      const rowCenter = lastRow.reduce((sum, item) => sum + centerYOf(item), 0) / lastRow.length
      const rowMinHeight = Math.min(...lastRow.map((item) => item.height))
      const threshold = Math.min(element.height, rowMinHeight) * 0.6
      if (Math.abs(centerYOf(element) - rowCenter) < threshold) {
        lastRow.push(element)
        continue
      }
    }
    rows.push([element])
  }
  for (const row of rows) {
    if (row.length < 2) continue
    const averageCenter = row.reduce((sum, item) => sum + centerYOf(item), 0) / row.length
    for (const element of row) element.y = averageCenter - element.height / 2
  }

  // 2. 列对齐：左对齐元素的左边缘相近时归一
  const columnThreshold = cardWidth * 0.02
  const leftAligned = result.filter((element) => element.align === 'left').sort((a, b) => a.x - b.x)
  const columns: TemplateTagElement[][] = []
  for (const element of leftAligned) {
    const lastColumn = columns[columns.length - 1]
    if (lastColumn) {
      const columnX = lastColumn.reduce((sum, item) => sum + item.x, 0) / lastColumn.length
      if (Math.abs(element.x - columnX) < columnThreshold) {
        lastColumn.push(element)
        continue
      }
    }
    columns.push([element])
  }
  for (const column of columns) {
    if (column.length < 2) continue
    const averageX = column.reduce((sum, item) => sum + item.x, 0) / column.length
    for (const element of column) element.x = averageX
  }

  // 3. 字号聚类
  const cardMin = Math.min(cardWidth, cardHeight)
  const roleFontRange: Record<TemplateFontRole, [number, number]> = {
    title: [cardMin * 0.045, cardMin * 0.12],
    price: [cardMin * 0.04, cardMin * 0.13],
    normal: [1.4, cardMin * 0.055],
    small: [1, cardMin * 0.035],
  }
  const withRole = result.filter((element) => hasClusterableFont(element) && roleById.get(element.id))
  const withoutRole = result.filter((element) => hasClusterableFont(element) && !roleById.get(element.id))

  const roleGroups = new Map<TemplateFontRole, TemplateTagElement[]>()
  for (const element of withRole) {
    const role = roleById.get(element.id) as TemplateFontRole
    const group = roleGroups.get(role) ?? []
    group.push(element)
    roleGroups.set(role, group)
  }
  for (const [role, group] of roleGroups) {
    const [minSize, maxSize] = roleFontRange[role]
    const unified = clamp(median(group.map((item) => item.fontSize)), minSize, maxSize)
    for (const element of group) element.fontSize = unified
  }

  // 无语义档位时按数值单链聚类：相邻字号差 < 14% 视为同档
  const byFontSize = [...withoutRole].sort((a, b) => a.fontSize - b.fontSize)
  const clusters: TemplateTagElement[][] = []
  for (const element of byFontSize) {
    const lastCluster = clusters[clusters.length - 1]
    const lastSize = lastCluster ? lastCluster[lastCluster.length - 1].fontSize : 0
    if (lastCluster && element.fontSize <= lastSize * 1.14) lastCluster.push(element)
    else clusters.push([element])
  }
  for (const cluster of clusters) {
    if (cluster.length < 2) continue
    const unified = clamp(median(cluster.map((item) => item.fontSize)), 1, cardMin * 0.13)
    for (const element of cluster) element.fontSize = unified
  }

  // 4. 统一字号后保证盒子能容纳文字，避免渲染时字号被二次压小
  for (const element of result) {
    if (!element.singleLine || !hasClusterableFont(element)) continue
    const widthFactor = element.kind === 'iconSpec' ? 0.72 : 1
    const neededWidth = (textMeasureUnits(element.text) * element.fontSize) / (0.92 * widthFactor) + 0.6
    if (neededWidth > element.width) element.width = Math.min(neededWidth, cardWidth - element.x)
    const neededHeight = element.fontSize * 1.25
    if (neededHeight > element.height) {
      element.y = clamp(element.y - (neededHeight - element.height) / 2, 0, cardHeight - neededHeight)
      element.height = Math.min(neededHeight, cardHeight - element.y)
    }
  }

  return result.map((element) => constrainElementToBounds(element, cardWidth, cardHeight))
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

  const roleById = new Map<string, TemplateFontRole | undefined>()
  const elements = cleanLines.map((line) => {
    const xRatio = clamp(line.bbox.x0 / safeImageWidth, 0, 1)
    const yRatio = clamp(line.bbox.y0 / safeImageHeight, 0, 1)
    const widthRatio = clamp((line.bbox.x1 - line.bbox.x0) / safeImageWidth, 0.01, 1)
    const heightRatio = clamp((line.bbox.y1 - line.bbox.y0) / safeImageHeight, 0.008, 1)
    const paddingX = clamp(safeCardWidth * 0.008, 0.45, 1.2)
    const paddingY = clamp(safeCardHeight * 0.004, 0.25, 0.8)
    const rawHeight = heightRatio * usableHeight + paddingY * 2
    const kind = inferKind(line.text, yRatio, heightRatio)
    const iconKey = kind === 'iconSpec' ? inferIconKey(line.text) : undefined
    const isLarge = (line.bbox.y1 - line.bbox.y0) >= medianHeight * 1.35
    // 有语义档位时允许更大的字号上限（价格/标题可占卡片短边 13%）
    const fontCeiling = Math.min(safeCardWidth, safeCardHeight) * (line.fontRole === 'title' || line.fontRole === 'price' ? 0.13 : 0.085)
    const desiredFontSize = clamp(rawHeight * 0.72, 1.1, fontCeiling)
    // AI 明确给出加粗标记时优先采纳；价格始终加粗
    const inferredBold = kind === 'price' || kind === 'badge' || isLarge
    const fontWeight = line.bold === undefined
      ? (inferredBold ? 800 : 500)
      : (line.bold || kind === 'price' ? 800 : 500)
    const element: TemplateTagElement = {
      id: crypto.randomUUID(),
      kind,
      text: line.text,
      x: margin + xRatio * usableWidth - paddingX,
      y: margin + yRatio * usableHeight - paddingY,
      width: Math.max(5, widthRatio * usableWidth + paddingX * 2),
      height: Math.max(2.2, rawHeight),
      fontSize: desiredFontSize,
      fontWeight,
      color: kind === 'price' ? '#111827' : '#27303f',
      background: 'transparent',
      align: line.align ?? (kind === 'price' && xRatio > 0.52 ? 'right' : 'left'),
      radius: 0,
      iconKey,
      iconBackground: kind === 'iconSpec' ? '#b96c6b' : undefined,
      iconColor: kind === 'iconSpec' ? '#ffffff' : undefined,
      singleLine: true,
    }
    const bounded = constrainElementToBounds(element, safeCardWidth, safeCardHeight)
    roleById.set(bounded.id, line.fontRole)
    return bounded
  })

  const harmonized = harmonizeTemplateLayout(elements, roleById, safeCardWidth, safeCardHeight)
  return removeLayoutCollisions(harmonized, safeCardWidth, safeCardHeight, margin)
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

/**
 * OCR 前的图像预处理：小图放大到足够分辨率、灰度化、按 5%/95% 分位做对比度拉伸。
 * 手机翻拍的价签照片普遍偏灰偏暗，预处理能明显提升 tesseract 的中文识别率。
 */
async function preprocessImageForOcr(file: File): Promise<{ blob: Blob; width: number; height: number }> {
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' })
  try {
    const longEdge = Math.max(bitmap.width, bitmap.height)
    const scale = longEdge < 1600 ? 1600 / longEdge : longEdge > 2600 ? 2600 / longEdge : 1
    const width = Math.max(1, Math.round(bitmap.width * scale))
    const height = Math.max(1, Math.round(bitmap.height * scale))
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const context = canvas.getContext('2d', { willReadFrequently: true })
    if (!context) throw new Error('当前浏览器无法处理图片。')
    context.imageSmoothingQuality = 'high'
    context.drawImage(bitmap, 0, 0, width, height)

    const imageData = context.getImageData(0, 0, width, height)
    const pixels = imageData.data
    const histogram = new Uint32Array(256)
    for (let index = 0; index < pixels.length; index += 4) {
      const gray = Math.round(pixels[index] * 0.299 + pixels[index + 1] * 0.587 + pixels[index + 2] * 0.114)
      pixels[index] = gray
      pixels[index + 1] = gray
      pixels[index + 2] = gray
      histogram[gray] += 1
    }
    // 找 5% / 95% 分位灰度，线性拉伸到 0-255
    const totalPixels = width * height
    let cumulative = 0
    let lowCut = 0
    let highCut = 255
    for (let level = 0; level < 256; level += 1) {
      cumulative += histogram[level]
      if (cumulative >= totalPixels * 0.05) { lowCut = level; break }
    }
    cumulative = 0
    for (let level = 255; level >= 0; level -= 1) {
      cumulative += histogram[level]
      if (cumulative >= totalPixels * 0.05) { highCut = level; break }
    }
    const range = Math.max(1, highCut - lowCut)
    for (let index = 0; index < pixels.length; index += 4) {
      const stretched = clamp(((pixels[index] - lowCut) / range) * 255, 0, 255)
      pixels[index] = stretched
      pixels[index + 1] = stretched
      pixels[index + 2] = stretched
    }
    context.putImageData(imageData, 0, 0)

    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((value) => (value ? resolve(value) : reject(new Error('图片预处理失败。'))), 'image/png')
    })
    return { blob, width, height }
  } finally {
    bitmap.close()
  }
}

export async function analyzeTemplateImage(
  file: File,
  cardWidth: number,
  cardHeight: number,
  onProgress?: (progress: TemplateAnalysisProgress) => void,
): Promise<TemplateAnalysisResult> {
  onProgress?.({ status: '正在预处理图片', progress: 0.02 })
  const { blob, width: imageWidth, height: imageHeight } = await preprocessImageForOcr(file)

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
    const result = await worker.recognize(blob, { rotateAuto: true }, { text: true, blocks: true })
    const recognizedText = result.data.text.trim()
    const ocrLines = collectOcrLines(result.data.blocks)
    const lines = ocrLines.length ? ocrLines : fallbackLinesFromText(recognizedText, imageWidth, imageHeight)
    const elements = createTemplateElementsFromLines(lines, imageWidth, imageHeight, cardWidth, cardHeight)
    return { elements, imageWidth, imageHeight, recognizedText }
  } finally {
    await worker.terminate()
  }
}
