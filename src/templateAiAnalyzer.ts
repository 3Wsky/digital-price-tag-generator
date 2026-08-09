import {
  createTemplateElementsFromLines,
  type TemplateAnalysisProgress,
  type TemplateOcrLine,
  type TemplateTagElement,
} from './templateImageAnalyzer.ts'

export interface AiTemplateLine {
  text: string
  confidence: number
  x: number
  y: number
  width: number
  height: number
}

interface AiTemplateResponse {
  ok?: boolean
  message?: string
  model?: string
  lines?: unknown
}

export interface AiTemplateAnalysisResult {
  elements: TemplateTagElement[]
  model: string
  lineCount: number
}

const MAX_AI_IMAGE_EDGE = 2200
const MAX_AI_DATA_URL_LENGTH = 7_500_000

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))

function canvasToDataUrl(canvas: HTMLCanvasElement, quality: number) {
  return canvas.toDataURL('image/jpeg', quality)
}

export async function prepareTemplateImageForAi(file: File) {
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' })
  try {
    const scale = Math.min(1, MAX_AI_IMAGE_EDGE / Math.max(bitmap.width, bitmap.height))
    const width = Math.max(1, Math.round(bitmap.width * scale))
    const height = Math.max(1, Math.round(bitmap.height * scale))
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const context = canvas.getContext('2d')
    if (!context) throw new Error('当前浏览器无法处理图片。')

    context.fillStyle = '#ffffff'
    context.fillRect(0, 0, width, height)
    context.drawImage(bitmap, 0, 0, width, height)

    for (const quality of [0.9, 0.82, 0.74, 0.66]) {
      const dataUrl = canvasToDataUrl(canvas, quality)
      if (dataUrl.length <= MAX_AI_DATA_URL_LENGTH) return dataUrl
    }
    throw new Error('图片压缩后仍然过大，请先裁剪照片再进行 AI 识别。')
  } finally {
    bitmap.close()
  }
}

export function normalizeAiTemplateLines(value: unknown): AiTemplateLine[] {
  if (!Array.isArray(value)) return []
  return value
    .map((line) => {
      const candidate = line as Partial<AiTemplateLine>
      return {
        text: typeof candidate.text === 'string' ? candidate.text.replace(/\s+/g, ' ').trim() : '',
        confidence: Number(candidate.confidence),
        x: Number(candidate.x),
        y: Number(candidate.y),
        width: Number(candidate.width),
        height: Number(candidate.height),
      }
    })
    .filter((line) => line.text
      && [line.confidence, line.x, line.y, line.width, line.height].every(Number.isFinite)
      && line.confidence >= 20
      && line.x >= 0 && line.x < 1
      && line.y >= 0 && line.y < 1
      && line.width > 0 && line.height > 0)
    .map((line) => ({
      ...line,
      confidence: clamp(line.confidence, 0, 100),
      width: clamp(line.width, 0.002, 1 - line.x),
      height: clamp(line.height, 0.002, 1 - line.y),
    }))
    .slice(0, 80)
}

export function createTemplateElementsFromAiLines(
  lines: AiTemplateLine[],
  cardWidth: number,
  cardHeight: number,
) {
  const virtualWidth = 1000
  const virtualHeight = 1000
  const ocrLines: TemplateOcrLine[] = lines.map((line) => ({
    text: line.text,
    confidence: line.confidence,
    bbox: {
      x0: line.x * virtualWidth,
      y0: line.y * virtualHeight,
      x1: (line.x + line.width) * virtualWidth,
      y1: (line.y + line.height) * virtualHeight,
    },
  }))
  return createTemplateElementsFromLines(ocrLines, virtualWidth, virtualHeight, cardWidth, cardHeight)
}

export async function analyzeTemplateImageWithAi(
  file: File,
  cardWidth: number,
  cardHeight: number,
  onProgress?: (progress: TemplateAnalysisProgress) => void,
): Promise<AiTemplateAnalysisResult> {
  onProgress?.({ status: '正在压缩照片，准备安全上传', progress: 0.08 })
  const imageDataUrl = await prepareTemplateImageForAi(file)
  onProgress?.({ status: '正在调用 AI 深度识别', progress: 0.3 })

  const response = await fetch('/api/template-analysis', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ imageDataUrl }),
  })
  const payload = await response.json().catch(() => null) as AiTemplateResponse | null
  if (!response.ok || !payload?.ok) {
    throw new Error(payload?.message || `AI 深度识别失败（HTTP ${response.status}）。`)
  }

  onProgress?.({ status: '正在整理 AI 识别结果', progress: 0.86 })
  const lines = normalizeAiTemplateLines(payload.lines)
  const elements = createTemplateElementsFromAiLines(lines, cardWidth, cardHeight)
  if (!elements.length) throw new Error('AI 没有返回可用文字，请换一张更清晰的照片。')

  return {
    elements,
    model: typeof payload.model === 'string' ? payload.model : 'vision-model',
    lineCount: lines.length,
  }
}
