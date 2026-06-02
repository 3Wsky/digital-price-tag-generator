import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  BatteryFull,
  Camera,
  Copy,
  Cpu,
  Download,
  Eye,
  Image,
  Layout,
  Loader2,
  Printer,
  Rows3,
  Search,
  ShieldCheck,
  Signal,
  Smartphone,
  Trash2,
  Upload,
  Volume2,
  Zap,
} from 'lucide-react'
import html2canvas from 'html2canvas'
import * as XLSX from 'xlsx'
import { jsPDF } from 'jspdf'
import './App.css'

// ─── Types ───────────────────────────────────────────────────────────

type ViewMode = 'page' | 'card'
type ElementKind = 'text' | 'price' | 'spec' | 'badge' | 'qr' | 'image' | 'iconSpec' | 'colors' | 'divider' | 'footnote'
type FeatureIconKey = 'battery' | 'chip' | 'eye' | 'volume' | 'signal' | 'shield' | 'charge' | 'camera' | 'phone'
type PaperSize = 'a4' | 'a3'

interface TagElement {
  id: string
  kind: ElementKind
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
  iconKey?: FeatureIconKey
  iconBackground?: string
  iconColor?: string
  singleLine?: boolean
}

interface TagPreset {
  name: string
  width: number
  height: number
}

interface Card {
  id: string
  name: string
  customName: boolean
  width: number
  height: number
  elements: TagElement[]
}

interface PaperConfig {
  size: PaperSize
  width: number
  height: number
  label: string
}

interface LayoutItem {
  card: Card
  x: number
  y: number
  renderW: number
  renderH: number
  cardScale: number
  page: number
}

interface ProductDraft {
  title: string
  template?: 'standard' | 'dji'
  features: Array<{ iconKey: FeatureIconKey; text: string }>
  colors: string[]
  colorNames?: string[]
  skus: Array<{ label: string; price: string }>
  service: { label: string; price: string }
  services?: Array<{ label: string; price: string }>
  footnote: string
  source: 'zhihu' | 'fallback' | 'official'
  sourceNotes: string[]
}

interface ZhihuItem {
  Title?: string
  ContentText?: string
  VoteUpCount?: number
  AuthorityLevel?: string
}

interface OfficialProduct {
  title: string
  price: string
  priceStatus?: 'available' | 'pending'
  skuPrices: Array<{ version: string; price: string; colors?: string[] }>
  careServices: Array<{ name: string; price: string }>
  colors: string[]
  specs: { chip?: string; battery?: string; screen?: string; charge?: string; refreshRate?: string; screenTech?: string }
  features?: string[]
}

interface DjiBundle {
  title: string
  slug: string
  price: string
  priceValue?: number | null
  controller?: string
  bundleKind?: string
  includedItems?: Array<{ name: string; quantity: number; slug?: string }>
}

interface DjiProduct {
  brand: 'DJI'
  title: string
  slug: string
  url: string
  price: string
  priceStatus?: 'available' | 'pending'
  bundles: DjiBundle[]
  careServices: Array<{ name: string; price: string; slug?: string }>
  highlights: string[]
  specs: {
    camera?: string
    video?: string
    safety?: string
    transmission?: string
    endurance?: string
    weight?: string
  }
  fetchedFrom?: string
}

interface StaticProductEntry {
  ok: boolean
  source?: string
  message?: string
  product?: OfficialProduct
  zhihuItems?: ZhihuItem[]
  fetchedAt?: string
}

interface StaticDjiEntry {
  ok: boolean
  source?: string
  message?: string
  product?: DjiProduct
  fetchedAt?: string
}

interface SearchBundle {
  overview: ZhihuItem[]
  sellingPoints: ZhihuItem[]
  colors: ZhihuItem[]
  prices: ZhihuItem[]
  service: ZhihuItem[]
}

interface AppState {
  paper: PaperConfig
  cards: Card[]
  selectedCardId: string
  selectedElementId: string
  viewMode: ViewMode
  pageZoom: number
}

// ─── Constants ───────────────────────────────────────────────────────

const presets: TagPreset[] = [
  { name: '门店价签 75 x 121', width: 75, height: 121 },
  { name: '手机参数牌 100 x 185', width: 100, height: 185 },
  { name: '手机参数牌 90 x 130', width: 90, height: 130 },
  { name: '桌牌横版 100 x 70', width: 100, height: 70 },
  { name: '小价签 80 x 50', width: 80, height: 50 },
  { name: 'A6 展示牌 105 x 148', width: 105, height: 148 },
]

const paperConfigs: PaperConfig[] = [
  { size: 'a4', width: 210, height: 297, label: 'A4 (210 x 297 mm)' },
  { size: 'a3', width: 297, height: 420, label: 'A3 (297 x 420 mm)' },
]

let staticProductsPromise: Promise<Record<string, StaticProductEntry> | null> | null = null
let staticDjiProductsPromise: Promise<Record<string, StaticDjiEntry> | null> | null = null

const normalizeProductKey = (value: string) => value
  .toLowerCase()
  .replace(/[\s-]+/g, '')
  .replace(/^vivo(?=iqoo)/, '')

const normalizeDjiKey = (value: string) => value
  .toLowerCase()
  .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '')
  .replace(/^dji/, '')
  .replace(/^大疆/, '')

function loadStaticProducts() {
  if (!staticProductsPromise) {
    staticProductsPromise = fetch('/data/products.json', { cache: 'no-cache' })
      .then((r) => r.ok ? r.json() : null)
      .catch(() => null)
  }
  return staticProductsPromise
}

function loadStaticDjiProducts() {
  if (!staticDjiProductsPromise) {
    staticDjiProductsPromise = fetch('/data/dji-products.json', { cache: 'no-cache' })
      .then((r) => r.ok ? r.json() : null)
      .catch(() => null)
  }
  return staticDjiProductsPromise
}

function findStaticProductEntry(products: Record<string, StaticProductEntry> | null, model: string) {
  if (!products) return null
  const target = normalizeProductKey(model)
  const exactKey = Object.keys(products).find(key => normalizeProductKey(key) === target)
  if (exactKey) return products[exactKey]
  return Object.values(products).find(entry => entry?.product?.title && normalizeProductKey(entry.product.title) === target) || null
}

function findStaticDjiEntry(products: Record<string, StaticDjiEntry> | null, model: string) {
  if (!products) return null
  const target = normalizeDjiKey(model)
  const knownAliases: Record<string, string> = {
    mini4pro: 'dji-mini-4-pro',
    djimini4pro: 'dji-mini-4-pro',
    air3s: 'dji-air-3s',
    djiair3s: 'dji-air-3s',
    mavic4pro: 'dji-mavic-4-pro',
    djimavic4pro: 'dji-mavic-4-pro',
    pocket3: 'osmo-pocket-3',
    osmopocket3: 'osmo-pocket-3',
  }
  const aliasKey = knownAliases[target]
  if (aliasKey && products[aliasKey]) return products[aliasKey]
  const exactKey = Object.keys(products).find(key => normalizeDjiKey(key) === target)
  if (exactKey) return products[exactKey]
  return Object.values(products).find(entry => {
    const product = entry?.product
    if (!product) return false
    const titleKey = normalizeDjiKey(product.title)
    return titleKey === target || titleKey.includes(target) || target.includes(titleKey)
  }) || null
}

const featureIconOptions: Array<{ key: FeatureIconKey; label: string; Icon: typeof BatteryFull }> = [
  { key: 'battery', label: '电池', Icon: BatteryFull },
  { key: 'chip', label: '芯片', Icon: Cpu },
  { key: 'eye', label: '护眼屏', Icon: Eye },
  { key: 'volume', label: '大音量', Icon: Volume2 },
  { key: 'signal', label: '通信', Icon: Signal },
  { key: 'shield', label: '耐摔', Icon: ShieldCheck },
  { key: 'charge', label: '快充', Icon: Zap },
  { key: 'camera', label: '影像', Icon: Camera },
  { key: 'phone', label: '整机', Icon: Smartphone },
]


const genericFootnote =
  '产品功能参数详见官网或咨询店员。\n1. 手机作为精密电子产品，跌落仍有损坏风险，请注意避免跌落碰撞。\n2. 规格、价格、库存、服务内容及活动政策请以门店实际销售口径为准。'

const officialFootnote = (_brand: string) =>
  genericFootnote

const zhihuFootnote =
  genericFootnote

const fallbackFootnote =
  genericFootnote

// ─── Helpers ─────────────────────────────────────────────────────────

const makeId = () => crypto.randomUUID()

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v))

const getAlignOffset = (align: TagElement['align']) => {
  if (align === 'center') return 'center'
  if (align === 'right') return 'flex-end'
  return 'flex-start'
}

const getFeatureIcon = (key: FeatureIconKey = 'phone') =>
  featureIconOptions.find((o) => o.key === key) ?? featureIconOptions[0]

const exportFeatureIconShapes: Record<FeatureIconKey, Array<{ tag: string; attrs: Record<string, string> }>> = {
  battery: [
    { tag: 'rect', attrs: { x: '2', y: '7', width: '16', height: '10', rx: '2' } },
    { tag: 'path', attrs: { d: 'M22 11v2' } },
    { tag: 'path', attrs: { d: 'M6 11h8' } },
  ],
  chip: [
    { tag: 'rect', attrs: { x: '4', y: '4', width: '16', height: '16', rx: '2' } },
    { tag: 'rect', attrs: { x: '9', y: '9', width: '6', height: '6', rx: '1' } },
    { tag: 'path', attrs: { d: 'M9 2v2M15 2v2M9 20v2M15 20v2M20 9h2M20 15h2M2 9h2M2 15h2' } },
  ],
  eye: [
    { tag: 'path', attrs: { d: 'M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z' } },
    { tag: 'circle', attrs: { cx: '12', cy: '12', r: '3' } },
  ],
  volume: [
    { tag: 'path', attrs: { d: 'M11 5 6 9H2v6h4l5 4V5Z' } },
    { tag: 'path', attrs: { d: 'M15 9.5a5 5 0 0 1 0 5' } },
    { tag: 'path', attrs: { d: 'M18 7a9 9 0 0 1 0 10' } },
  ],
  signal: [
    { tag: 'path', attrs: { d: 'M2 20h.01M7 20v-4M12 20v-8M17 20V8M22 20V4' } },
  ],
  shield: [
    { tag: 'path', attrs: { d: 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z' } },
    { tag: 'path', attrs: { d: 'm9 12 2 2 4-4' } },
  ],
  charge: [
    { tag: 'path', attrs: { d: 'M13 2 3 14h9l-1 8 10-12h-9l1-8Z' } },
  ],
  camera: [
    { tag: 'path', attrs: { d: 'M14.5 4 16 6h4a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l1.5-2h5Z' } },
    { tag: 'circle', attrs: { cx: '12', cy: '13', r: '3' } },
  ],
  phone: [
    { tag: 'rect', attrs: { x: '7', y: '2', width: '10', height: '20', rx: '2' } },
    { tag: 'path', attrs: { d: 'M12 18h.01' } },
  ],
}

const appendExportFeatureIcon = (target: HTMLElement, iconKey: FeatureIconKey = 'phone', color = '#ffffff') => {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  Object.entries({
    viewBox: '0 0 24 24',
    width: '1em',
    height: '1em',
    fill: 'none',
    stroke: color,
    'stroke-width': '1.8',
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
  }).forEach(([key, value]) => svg.setAttribute(key, value))
  svg.style.display = 'block'
  for (const shape of exportFeatureIconShapes[iconKey] ?? exportFeatureIconShapes.phone) {
    const node = document.createElementNS('http://www.w3.org/2000/svg', shape.tag)
    Object.entries(shape.attrs).forEach(([key, value]) => node.setAttribute(key, value))
    svg.appendChild(node)
  }
  target.appendChild(svg)
}

function scaleElements(elements: TagElement[], sw: number, sh: number): TagElement[] {
  if (sw === 1 && sh === 1) return elements
  const sf = (sw + sh) / 2
  return elements.map((el) => ({
    ...el,
    x: Math.round(el.x * sw * 10) / 10,
    y: Math.round(el.y * sh * 10) / 10,
    width: Math.max(1, Math.round(el.width * sw * 10) / 10),
    height: Math.max(0.3, Math.round(el.height * sh * 10) / 10),
    fontSize: Math.round(el.fontSize * sf * 100) / 100,
  }))
}

function stripHtml(value = '') {
  return value.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()
}

function compactLine(value: string, max = 20) {
  const clean = value.replace(/[，。；、,]/g, ' ').replace(/\s+/g, ' ').trim()
  return clean.length > max ? clean.slice(0, max) : clean
}

function textMeasureUnits(value: string) {
  return Array.from(value).reduce((total, ch) => {
    if (/\s/.test(ch)) return total + 0.32
    if (/[/|·・,，、:+＋-]/.test(ch)) return total + 0.34
    if (/[A-Z]/.test(ch)) return total + 0.62
    if (/[a-z0-9]/.test(ch)) return total + 0.56
    if (/[\u4e00-\u9fff]/.test(ch)) return total + 1
    return total + 0.7
  }, 0)
}

function fitsSingleLine(value: string, width: number, fontSize: number) {
  return textMeasureUnits(value) * fontSize <= width * 0.92
}

function fitSingleLineFontSize(value: string, width: number, base: number, min: number) {
  const units = textMeasureUnits(value)
  if (!units) return base
  const fitted = (width * 0.92) / units
  return Math.round(Math.max(min, Math.min(base, fitted)) * 10) / 10
}

function displayTitleForCard(value: string, width: number, fontSize: number) {
  const clean = value.replace(/\s+/g, ' ').trim()
  if (fitsSingleLine(clean, width, fontSize)) return clean
  const stripped = clean.replace(/^(?:huawei|华为|honor|荣耀|vivo|iqoo|apple|苹果|oppo|oneplus|一加|xiaomi|小米|redmi|红米|samsung|三星|dji|大疆|realme|真我|meizu|魅族)\s*/i, '').trim()
  return stripped || clean
}

function splitSentences(text: string) {
  return text.split(/[。！？!?；;\n]/).map((s) => s.trim()).filter(Boolean)
}

function normalizeModel(value: string) {
  return value.toLowerCase().replace(/huawei|华为/g, '').replace(/\s+/g, '')
}

function findFirst(text: string, pattern: RegExp) {
  return text.match(pattern)?.[0] ?? ''
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function modelPattern(model: string) {
  const tokens = model
    .replace(/华为|huawei/gi, ' ')
    .match(/[a-z]+|\d+|[一-龥]+/gi)
    ?.filter((t) => !['gb', 'tb'].includes(t.toLowerCase())) ?? []
  if (!tokens.length) return escapeRegExp(model.trim())
  return tokens.map((t) => escapeRegExp(t)).join('\\s*')
}

function itemText(items: ZhihuItem[]) {
  return items.map((i) => `${stripHtml(i.Title)}。${stripHtml(i.ContentText)}`).join('。')
}

function getScopedText(model: string, items: ZhihuItem[]) {
  const modelKey = normalizeModel(model)
  const all = splitSentences(itemText(items))
  const modelParts = modelKey.match(/[a-z]+|\d+|pro|max|ultra|plus/gi) ?? []
  const scoped = all.filter((s) => {
    const n = normalizeModel(s)
    if (n.includes(modelKey)) return true
    return modelParts.length > 0 && modelParts.every((p) => n.includes(p))
  })
  return (scoped.length ? scoped : all).join('。')
}

function getModelWindows(model: string, text: string, size = 520) {
  const pattern = modelPattern(model)
  const windows: string[] = []
  for (const match of text.matchAll(new RegExp(pattern, 'gi'))) {
    const start = Math.max(0, match.index - 80)
    windows.push(text.slice(start, Math.min(text.length, match.index + size)))
  }
  return windows.length ? windows : [text]
}

function colorHexFromName(name: string) {
  if (name.includes('黑')) return '#3f3f3f'
  if (name.includes('金')) return '#d5c38f'
  if (name.includes('银')) return '#c7c7c7'
  if (name.includes('青')) return '#8bb8ad'
  if (name.includes('白')) return '#ffffff'
  if (name.includes('蓝')) return '#8aa6c8'
  if (name.includes('紫')) return '#a894c8'
  if (name.includes('红')) return '#b96c6b'
  if (name.includes('粉')) return '#e8a0bf'
  if (name.includes('灰')) return '#9ca3af'
  if (name.includes('绿')) return '#6b9e78'
  return '#d1d5db'
}

function defaultServiceForBrand(title: string) {
  const normalized = title.toLowerCase()
  if (normalized.includes('huawei') || title.includes('华为')) return { label: 'HUAWEI Care+（一年期）', price: '¥ --' }
  if (normalized.includes('iphone') || normalized.includes('apple') || title.includes('苹果')) return { label: 'AppleCare+ 服务计划', price: '¥ --' }
  if (normalized.includes('vivo')) return { label: 'vivo 官方保障服务', price: '¥ --' }
  if (normalized.includes('honor') || title.includes('荣耀')) return { label: '荣耀官方保障服务', price: '¥ --' }
  if (normalized.includes('oppo')) return { label: 'OPPO 官方保障服务', price: '¥ --' }
  if (normalized.includes('xiaomi') || title.includes('小米')) return { label: '小米官方保障服务', price: '¥ --' }
  if (normalized.includes('samsung') || title.includes('三星')) return { label: '三星官方保障服务', price: '¥ --' }
  if (normalized.includes('dji') || title.includes('大疆')) return { label: 'DJI Care 随心换', price: '¥ --' }
  return { label: '官方保障服务（一年期）', price: '¥ --' }
}

// ─── Extraction Functions ────────────────────────────────────────────

function officialPrices(text: string, model = '') {
  const blocked = ['直降', '优惠', '到手', '补贴', '国补', '券', '满减', '促销', '特价', '报价', '商家', '二手']
  const lowerTier = ['标准版', 'Mate80标准版', 'Mate 80标准版', 'Mate80 标准版']
  const official = ['售价', '定价', '官方指导价', '发布', '起售价', '起']
  const minPrice = normalizeModel(model).includes('promax') ? 7000 : 3000
  return splitSentences(text)
    .filter((s) => !blocked.some((w) => s.includes(w)))
    .filter((s) => !lowerTier.some((w) => s.includes(w)))
    .filter((s) => official.some((w) => s.includes(w)))
    .flatMap((s) => Array.from(s.matchAll(/(\d{4,5})\s?元/g)).map((m) => Number(m[1])))
    .filter((p) => p >= minPrice)
}

function normalizeSkuVersion(value: string) {
  return value
    .replace(/(\d{1,2})\s?G(?:B)?/i, '$1GB')
    .replace(/\+\s?(\d{3,4})\s?G(?:B)?/i, '+$1GB')
    .replace(/\+\s?([12])\s?T(?:B)?/i, '+$1TB')
    .replace(/\s+/g, '')
}

function extractSkuPricesFromSearch(model: string, text: string) {
  const minPrice = normalizeModel(model).includes('promax') ? 7000 : 2500
  const blocked = ['直降', '优惠', '到手', '补贴', '国补', '券', '满减', '促销', '特价', '商家', '二手']
  const skuMap = new Map<string, number>()
  const windows = getModelWindows(model, text)
  const versionPattern = /(\d{1,2}\s?G(?:B)?\s?\+\s?(?:\d{3,4}\s?G(?:B)?|[12]\s?T(?:B)?))/gi
  windows.forEach((w) => {
    if (blocked.some((b) => w.includes(b))) return
    for (const match of w.matchAll(versionPattern)) {
      const version = normalizeSkuVersion(match[1])
      const after = w.slice(match.index, Math.min(w.length, match.index + 90))
      const pm = after.match(/(?:售价|定价|价格|为|:|：)?\s*(\d{4,5})\s?元/)
      if (!pm) continue
      const price = Number(pm[1])
      if (!price || price < minPrice) continue
      const cur = skuMap.get(version)
      if (!cur || price > cur) skuMap.set(version, price)
    }
  })
  return Array.from(skuMap.entries())
    .sort((a, b) => a[1] - b[1])
    .slice(0, 3)
    .map(([label, price]) => ({ label, price: `¥ ${price}` }))
}

function extractColorNamesFromSearch(model: string, text: string) {
  const windows = getModelWindows(model, text, 760)
  const colorEndings = '黑|白|金|银|青|蓝|紫|绿|红|粉|灰|棕|黄|橙'
  const nonColorWords = /传感器|搭载|自研|芯片|电池|算法|系统|模型|售价|价格|版本|处理器|屏幕|摄像头|充电|存储|内存|像素|刷新率|分辨率|材质|玻璃|防水|音箱|扬声器|指纹|面部|识别|解锁|系统|版本|标准|配色|外观|颜色|共有|提供|包括|采用|系列|手机|机型|颜色有|颜色为|李水青|其中橙|为钛金|配色有|共有[五六七八九]|精选|限定|经典|新款|潮流/
  const ranked = new Map<string, number>()

  for (const w of windows) {
    // Only match colors that appear between delimiters — strongest signal
    const pattern = new RegExp(
      `[、，,\\/\\s;；]([一-龥]{2,3}(?:${colorEndings}))[、，,\\/\\s;；四五六七款]`,
      'g',
    )
    for (const match of w.matchAll(pattern)) {
      const cn = match[1]
      if (nonColorWords.test(cn)) continue
      ranked.set(cn, (ranked.get(cn) ?? 0) + 1)
    }
  }

  // Fallback: if nothing found, try split-by-delimiter approach
  if (ranked.size === 0) {
    for (const w of windows) {
      const segments = w.split(/[、，,\/；;]+/)
      for (const seg of segments) {
        const match = seg.match(new RegExp(`^\\s*([一-龥]{2,3}(?:${colorEndings}))\\s*$`))
        if (!match) continue
        const cn = match[1]
        if (nonColorWords.test(cn)) continue
        ranked.set(cn, (ranked.get(cn) ?? 0) + 1)
      }
    }
  }

  // 品牌特定颜色库：当正则匹配不到时，在文本中查找已知颜色名
  if (ranked.size === 0) {
    const brandColors: Record<string, string[]> = {
      vivo: ['告白', '灵感紫', '悠悠蓝', '深空黑', '钛色', '银调', '红圈', '黑Ka'],
      xiaomi: ['钛银', '亮黑', '远山蓝', '橄榄绿', '月影白', '星空黑', '橄榄绿'],
      apple: ['原色钛金属', '沙漠钛金属', '白色钛金属', '黑色钛金属', '自然钛金属', '蓝色钛金属', '绿色钛金属', '粉色钛金属'],
      honor: ['流光金', '冰霜蓝', '星空黑', '晨曦金', '月影灰', '天际蓝', '雪域白', '绒黑色'],
    }
    const modelLower = model.toLowerCase()
    const brand = /vivo/i.test(modelLower) ? 'vivo'
      : /iphone|苹果/i.test(modelLower) ? 'apple'
      : /小米|xiaomi|redmi/i.test(modelLower) ? 'xiaomi'
      : /荣耀|honor/i.test(modelLower) ? 'honor'
      : ''
    if (brand && brandColors[brand]) {
      for (const color of brandColors[brand]) {
        if (text.includes(color)) ranked.set(color, 1)
      }
    }
  }

  return Array.from(ranked.keys()).slice(0, 5)
}

function inferColors(text: string) {
  const colorMap: Array<[string, string]> = [
    ['黑', '#3f3f3f'], ['金', '#d5c38f'], ['银', '#c7c7c7'], ['白', '#ffffff'],
    ['蓝', '#8aa6c8'], ['青', '#8bb8ad'], ['紫', '#a894c8'], ['红', '#b96c6b'],
  ]
  const picked = colorMap.filter(([n]) => text.includes(n)).map(([, c]) => c)
  const unique = Array.from(new Set(picked))
  return unique.length ? [...unique, '#ffffff'].slice(0, 4) : ['#3f3f3f', '#d5c38f', '#c7c7c7', '#ffffff']
}

function extractServicesFromSearch(model: string, text: string) {
  const normalized = model.toLowerCase()
  const services = new Map<string, string>()
  const careText = splitSentences(text)
    .filter((s) => /care\+|care|保障|碎屏|服务/i.test(s))
    .join('。')
  if (normalized.includes('huawei') || model.includes('华为')) {
    for (const m of careText.matchAll(/(一年期|两年期)[^\d]{0,30}(\d{3,5})\s?元/g)) {
      services.set(`HUAWEI Care+（${m[1]}）`, `¥ ${Number(m[2])}`)
    }
    for (const m of careText.matchAll(/(\d{3,5})\s?元[^\n。；;]{0,24}(一年期|两年期)/g)) {
      services.set(`HUAWEI Care+（${m[2]}）`, `¥ ${Number(m[1])}`)
    }
  }
  if (normalized.includes('iphone') || normalized.includes('apple') || model.includes('苹果')) {
    for (const m of careText.matchAll(/AppleCare\+?[^\d]{0,40}(\d{3,5})\s?元/gi)) {
      services.set('AppleCare+ 服务计划', `¥ ${Number(m[1])}`)
    }
  }
  return Array.from(services.entries()).map(([label, price]) => ({ label, price }))
}

// ─── Draft Builders ──────────────────────────────────────────────────

function feature(iconKey: FeatureIconKey, line1: string, line2 = '') {
  return { iconKey, text: line2 ? `${line1}\n${line2}` : line1 }
}

function iconForOfficialFeature(value: string): FeatureIconKey {
  if (/电池|续航|mAh|蓝海/.test(value)) return 'battery'
  if (/芯片|性能|系统|流畅|OriginOS|骁龙|天玑|麒麟/i.test(value)) return 'chip'
  if (/屏|显示|护眼|Hz|K\b/i.test(value)) return 'eye'
  if (/影像|主摄|摄像|像素|HP/i.test(value)) return 'camera'
  if (/充电|快充|\d{2,3}W/i.test(value)) return 'charge'
  if (/信号|通信|北斗|卫星/.test(value)) return 'signal'
  if (/防水|耐摔|抗摔|玻璃|IP\d+/i.test(value)) return 'shield'
  return 'phone'
}

function iconForDjiFeature(value: string): FeatureIconKey {
  if (/续航|飞行时间|电池|分钟/i.test(value)) return 'battery'
  if (/避障|全向|LiDAR|夜景/i.test(value)) return 'shield'
  if (/图传|公里|信号/i.test(value)) return 'signal'
  if (/4K|6K|HDR|CMOS|哈苏|像素|长焦|云台|D-Log/i.test(value)) return 'camera'
  return 'camera'
}

function buildDraftFromDji(product: DjiProduct): ProductDraft {
  const highlights = [
    product.specs.camera,
    product.specs.video,
    product.specs.safety,
    product.specs.endurance || product.specs.transmission,
    ...product.highlights,
  ].filter(Boolean) as string[]
  const featureList = Array.from(new Set(highlights.map(text => compactLine(text, 30))))
    .slice(0, 4)
    .map(text => feature(iconForDjiFeature(text), text))
  const bundles = product.bundles.slice(0, 5).map(bundle => ({
    label: compactLine(
      bundle.bundleKind === '标准套装'
        ? `整机标准版${bundle.controller ? `（${bundle.controller}）` : ''}`
        : `整机${bundle.bundleKind}${bundle.controller ? `（${bundle.controller}）` : ''}`,
      26,
    ),
    price: bundle.price,
  }))
  const services = product.careServices.slice(0, 2).map(service => ({
    label: service.name.replace(`（${product.title}）`, '').replace(product.title, '').trim(),
    price: service.price,
  }))
  const controllerNames = Array.from(new Set(product.bundles.map(bundle => bundle.controller).filter(Boolean))) as string[]
  const packageNames = Array.from(new Set(product.bundles.map(bundle => bundle.bundleKind).filter(Boolean))) as string[]
  return {
    title: product.title,
    template: 'dji',
    features: featureList.length ? featureList : [
      feature('camera', '影像创作设备', '官网套装价格'),
      feature('battery', '套装配置可选', '按遥控器与配件区分'),
      feature('shield', 'DJI Care 可选', '随心换服务另计'),
      feature('signal', '参数详见官网', '门店销售请复核'),
    ],
    colors: ['#1f2937', '#667085', '#d0d5dd', '#f2f4f7'],
    colorNames: [
      controllerNames.length ? `遥控：${controllerNames.join(' / ')}` : '遥控器按套装配置',
      packageNames.length ? `套装：${packageNames.join(' / ')}` : '标准 / 套装配置',
    ],
    skus: bundles.length ? bundles : [{ label: '官网套装价', price: product.price || '¥ --' }],
    service: services[0] ?? { label: 'DJI Care 随心换', price: '¥ --' },
    services,
    footnote: '大疆产品价格按套装、遥控器、配件组合区分；DJI Care 随心换为增值服务，门店成交价与库存请以实际销售口径为准。',
    source: 'official',
    sourceNotes: [
      `DJI 官网：${product.bundles.length} 个套装价格，${product.careServices.length} 个随心换服务。`,
      ...product.bundles.slice(0, 3).map(bundle => {
        const items = (bundle.includedItems || []).slice(0, 3).map(item => `${item.name}x${item.quantity}`).join('、')
        return `${bundle.title}：${bundle.price}${items ? `；含 ${items}` : ''}`
      }),
    ],
  }
}

function buildFallbackDraft(model: string): ProductDraft {
  return {
    title: model || '产品型号',
    features: [
      feature('battery', '大容量长续航电池', '快充组合 降低续航焦虑'),
      feature('chip', '旗舰性能芯片', '性能稳定 长久流畅'),
      feature('eye', '旗舰显示屏', '清晰显示 影像出色'),
      feature('signal', '稳定通信体验', '信号稳定 定位精准'),
    ],
    colors: ['#3f3f3f', '#aab2b6', '#c6beb4', '#ffffff'],
    colorNames: ['黑色', '银色', '金色', '白色'],
    skus: [
      { label: '标准版', price: '¥ 7999' },
      { label: '高配版', price: '¥ 8499' },
    ],
    service: defaultServiceForBrand(model),
    services: [defaultServiceForBrand(model)],
    footnote: fallbackFootnote,
    source: 'fallback',
    sourceNotes: ['未使用外部搜索结果，已生成通用门店价签草稿。'],
  }
}

export function buildDraftFromSearch(model: string, search: ZhihuItem[] | SearchBundle): ProductDraft {
  const items = Array.isArray(search)
    ? search
    : [...search.overview, ...search.sellingPoints, ...search.colors, ...search.prices, ...search.service]
  if (!items.length) return buildFallbackDraft(model)
  const overviewItems = Array.isArray(search) ? items : search.overview
  const sellingPointItems = Array.isArray(search) ? items : search.sellingPoints
  const colorItems = Array.isArray(search) ? items : search.colors
  const priceItems = Array.isArray(search) ? items : search.prices
  const serviceItems = Array.isArray(search) ? items : search.service

  const scopedText = getScopedText(model, [...overviewItems, ...sellingPointItems].length ? [...overviewItems, ...sellingPointItems] : items)
  const colorText = getScopedText(model, colorItems.length ? colorItems : items)
  const priceText = getScopedText(model, priceItems.length ? priceItems : items)
  const serviceText = getScopedText(model, serviceItems.length ? serviceItems : items)
  const allText = itemText(items)

  const chipNumber = findFirst(scopedText, /(90[1-9]0|8\s?Gen\s?\d|A\d{2}\s?Pro?)/i)
  const chip = chipNumber ? `${scopedText.includes('麒麟') ? '麒麟' : scopedText.includes('骁龙') ? '骁龙' : ''}${chipNumber}`.trim() : ''
  const batteries = Array.from(scopedText.matchAll(/(\d{4})\s?mAh/g)).map((m) => Number(m[1]))
  const battery = batteries.length ? `${Math.max(...batteries)}mAh` : ''
  const watts = Array.from(scopedText.matchAll(/(\d{2,3})\s?W/g)).map((m) => Number(m[1]))
  const charge = watts.length ? `${Math.max(...watts)}W 有线${watts.length > 1 ? ` / ${Math.min(...watts)}W无线` : ''}` : ''
  // Screen size: prefer decimal (6.x), then whole number (6-7), skip unrealistic sizes like 5英寸
  const screenSize = findFirst(scopedText, /\d\.\d\s*英寸/) || findFirst(scopedText, /[6-7]\s*英寸/) || findFirst(allText, /\d\.\d\s*英寸/) || ''
  const refreshRate = findFirst(scopedText, /\d{2,4}\s?Hz(?:\s?LTPO)?/i)
  const screenTech = scopedText.includes('双层 OLED') || scopedText.includes('双层OLED') ? '双层OLED' : findFirst(scopedText, /(OLED|LTPO|1\.5K|2K|FHD\+)/i)
  const camera = scopedText.includes('双潜望长焦') ? '双潜望长焦' : scopedText.includes('XMAGE') ? 'XMAGE影像' : findFirst(scopedText, /\d{4,5}\s?万像素/)
  const signal = scopedText.includes('双向北斗卫星消息') ? '双向北斗卫星消息' : scopedText.includes('卫星通信') ? '卫星通信' : scopedText.includes('5A') ? '5A 速度' : ''
  const durable = scopedText.includes('IP68+IP69') ? 'IP68+IP69' : scopedText.includes('第二代昆仑玻璃') ? '第二代昆仑玻璃' : scopedText.includes('玄武') ? '玄武架构' : ''
  const special = scopedText.includes('双层 OLED') || scopedText.includes('双层OLED') ? '首发双层OLED架构' : scopedText.includes('双潜望长焦') ? '双潜望长焦' : durable

  const colorNames = extractColorNamesFromSearch(model, colorText || allText)
  const skuPrices = extractSkuPricesFromSearch(model, `${priceText}。${allText}`)
  const memory = Array.from(`${priceText}。${scopedText}`.matchAll(/(\d{1,2}\s?G(?:B)?\s?\+\s?(?:\d{3,4}\s?G(?:B)?|[12]\s?T(?:B)?))/gi)).map((m) => normalizeSkuVersion(m[1]))
  const uniqueMemory = Array.from(new Set(memory)).slice(0, 2)
  const prices = Array.from(new Set([...officialPrices(priceText, model), ...officialPrices(allText, model)]))
    .sort((a, b) => a - b)
    .map((p) => `¥ ${p}`)
  const services = extractServicesFromSearch(model, `${serviceText}。${allText}`)
  const defaultService = defaultServiceForBrand(model)

  // Determine 4th feature: avoid duplicating camera if already used in 3rd feature
  const fourthFeatureKey: FeatureIconKey = signal ? 'signal' : durable ? 'shield' : camera ? 'phone' : 'camera'
  const fourthFeatureLine1 = signal || durable || (camera ? '' : '旗舰可靠体验') || '旗舰可靠体验'
  const fourthFeatureLine2 = signal ? '信号稳定 定位精准' : durable ? '日常使用更安心' : '综合体验更出色'

  return {
    title: model.trim(),
    features: [
      feature('battery', battery ? `${battery} 大容量电池` : '大容量长续航电池', compactLine(charge || '快充组合 降低续航焦虑', 24)),
      feature('chip', chip ? `${chip} 芯片` : '旗舰性能芯片', compactLine(special || durable || '性能稳定 长久流畅', 24)),
      feature('eye', compactLine([screenSize, screenTech, refreshRate].filter(Boolean).join(' '), 24) || '旗舰显示屏', compactLine(camera || '清晰显示 影像出色', 24)),
      feature(fourthFeatureKey, compactLine(fourthFeatureLine1, 24), fourthFeatureLine2),
    ],
    colors: colorNames.length ? colorNames.map(colorHexFromName).slice(0, 4) : inferColors(colorText),
    colorNames,
    skus: skuPrices.length
      ? skuPrices.slice(0, 2).map((sku) => ({ label: `${sku.label} ${chip || model}`.trim(), price: sku.price }))
      : [0, 1].map((i) => ({
        label: uniqueMemory[i] ? `${uniqueMemory[i]} ${chip || model}` : i === 0 ? `标准版 ${chip}`.trim() : `高配版 ${chip}`.trim(),
        price: prices[i] ?? '¥ --',
      })),
    service: services[0] ?? defaultService,
    services: services.length ? services.slice(0, 2) : [defaultService],
    footnote: zhihuFootnote,
    source: 'zhihu',
    sourceNotes: items.slice(0, 3).map((i) => `${stripHtml(i.Title)}（权威 ${i.AuthorityLevel ?? '-'}）`),
  }
}

function buildDraftFromOfficial(
  model: string,
  product: {
    title: string; price: string;
    priceStatus?: 'available' | 'pending';
    skuPrices: Array<{ version: string; price: string; colors?: string[] }>;
    careServices: Array<{ name: string; price: string }>;
    colors: string[];
    specs: { chip?: string; battery?: string; screen?: string; charge?: string; refreshRate?: string; screenTech?: string };
    features?: string[];
  },
  zhihuItems: ZhihuItem[] = [],
): ProductDraft {
  const isHonor = /荣耀|honor/i.test(`${model} ${product.title}`)
  const officialFeatureTexts = Array.from(new Set((product.features ?? [])
    .map(text => compactLine(text.replace(/\s+/g, ' ').trim(), 30))
    .filter(Boolean))).slice(0, 4)
  const officialFeatureText = officialFeatureTexts.join('。')
  const camera = findFirst(officialFeatureText, /(?:\d{4,5}\s?万像素|2亿HP5|HP5|主摄|影像)/i) || ''
  const signal = officialFeatureText.includes('双向北斗卫星消息') ? '双向北斗卫星消息'
    : officialFeatureText.includes('卫星通信') ? '卫星通信'
    : officialFeatureText.includes('5A') ? '5A 速度' : ''
  const durable = officialFeatureText.includes('IP68+IP69') ? 'IP68+IP69'
    : officialFeatureText.includes('第二代昆仑玻璃') ? '第二代昆仑玻璃'
    : officialFeatureText.includes('玄武') ? '玄武架构' : ''
  const special = officialFeatureText.includes('双层OLED') ? '首发双层OLED架构'
    : officialFeatureText.includes('双潜望长焦') ? '双潜望长焦' : durable

  const chip = product.specs.chip || findFirst(officialFeatureText, /(麒麟\s?\d{4}|骁龙\s?[^\s。|,，]{1,18}|天玑\s?\d{4}|A\d{2}\s?Pro?)/i) || ''
  const battery = product.specs.battery || findFirst(officialFeatureText, /\d{4,5}\s?mAh/i) || ''
  const charge = product.specs.charge || ''
  const chargeWatts = charge ? [] : Array.from(officialFeatureText.matchAll(/(\d{2,3})\s?W/g)).map(m => Number(m[1]))
  const chargeStr = charge || (chargeWatts.length ? `${Math.max(...chargeWatts)}W 有线${chargeWatts.length > 1 ? ` / ${Math.min(...chargeWatts)}W无线` : ''}` : '')
  const screenInfo = [product.specs.screen, product.specs.screenTech, product.specs.refreshRate].filter(Boolean).join(' ')

  // 4th feature
  const fourthKey: FeatureIconKey = signal ? 'signal' : durable ? 'shield' : camera ? 'phone' : 'camera'
  const fourthLine1 = signal || durable || (camera ? '' : '旗舰可靠体验') || '旗舰可靠体验'
  const fourthLine2 = signal ? '信号稳定 定位精准' : durable ? '日常使用更安心' : '综合体验更出色'
  const officialFeatures = officialFeatureTexts.map(text => feature(iconForOfficialFeature(text), text))
  const fallbackFeatures = [
    feature('battery', battery ? `${battery} 大容量电池` : '大容量长续航电池', compactLine(chargeStr || '快充组合 降低续航焦虑', 24)),
    feature('chip', chip ? `${chip} 芯片` : '旗舰性能芯片', compactLine(special || durable || '性能稳定 长久流畅', 24)),
    feature('eye', compactLine(screenInfo || '旗舰显示屏', 24) || '旗舰显示屏', compactLine(camera || '清晰显示 影像出色', 24)),
    feature(fourthKey, compactLine(fourthLine1, 24), fourthLine2),
  ]
  const zhihuFeatureDraft = isHonor && zhihuItems.length ? buildDraftFromSearch(product.title || model, zhihuItems) : null
  const hasHardSpec = (text: string) => /(\d|骁龙|天玑|麒麟|OLED|AMOLED|LTPO|绿洲|青海湖|像素|主摄|影像|mAh|W|Hz|英寸|护眼)/i.test(text)
  const mergeHonorFeatures = () => {
    const result: ProductDraft['features'] = []
    const usedIcons = new Set<FeatureIconKey>()
    const add = (item: ProductDraft['features'][number]) => {
      if (!item.text.trim()) return
      if (usedIcons.has(item.iconKey)) return
      result.push(item)
      usedIcons.add(item.iconKey)
    }
    const officialHardFeatures = [...officialFeatures, ...fallbackFeatures].filter(item => hasHardSpec(item.text))
    officialHardFeatures.forEach(add)
    zhihuFeatureDraft?.features.filter(item => !usedIcons.has(item.iconKey) || officialHardFeatures.length === 0).forEach(add)
    ;[...officialFeatures, ...fallbackFeatures].forEach(add)
    return result.slice(0, 4)
  }
  const featureList = zhihuFeatureDraft ? mergeHonorFeatures() : [...officialFeatures, ...fallbackFeatures].slice(0, 4)

  // Colors: use official data
  const colorNames = product.colors.length ? product.colors : ['以官网为准']
  const colors = colorNames.map(colorHexFromName).slice(0, 4)

  // SKUs: use official data
  const hasPublishedPrice = Boolean(product.price && /\d{3,6}/.test(product.price) && !/--/.test(product.price))
    || product.skuPrices.some(sku => Boolean(sku.price && /\d{3,6}/.test(sku.price) && !/--/.test(sku.price)))
  const pricePending = product.priceStatus === 'pending' || !hasPublishedPrice
  const skus = product.skuPrices.map(sku => ({
    label: sku.version,
    price: sku.price,
  }))
  // If no SKU prices from official, use the base price
  if (!skus.length && product.price) {
    skus.push({ label: '标准版', price: product.price })
  }
  if (!skus.length && pricePending) {
    skus.push({ label: '价格待公布', price: '¥ --' })
  }

  // Services: use official data
  const isHuawei = /华为|huawei/i.test(`${model} ${product.title}`)
  const services = isHuawei && product.careServices.length
    ? product.careServices.map(s => ({ label: s.name, price: s.price }))
    : []
  const brandName = isHuawei ? '华为'
    : /vivo/i.test(`${model} ${product.title}`) ? 'vivo'
    : /荣耀|honor/i.test(`${model} ${product.title}`) ? '荣耀'
    : /iphone|苹果|apple/i.test(`${model} ${product.title}`) ? 'Apple'
    : '品牌'

  const sourceNotes = zhihuFeatureDraft
    ? ['官网数据：标题、价格、颜色、版本。', ...zhihuFeatureDraft.sourceNotes.slice(0, 3).map(text => `知乎卖点参考：${text}`)]
    : officialFeatureTexts.length ? officialFeatureTexts.map(text => `官网功能特色：${text}`) : ['仅使用官网数据生成。']
  if (pricePending) {
    sourceNotes.unshift('官网已收录该产品，价格待发布会后公布。')
  }

  return {
    title: product.title || model.trim(),
    features: featureList,
    colors,
    colorNames,
    skus,
    service: services[0] ?? defaultServiceForBrand(model),
    services,
    footnote: isHuawei
      ? officialFootnote(brandName)
      : isHonor && zhihuFeatureDraft
        ? genericFootnote
        : genericFootnote,
    source: 'official',
    sourceNotes,
  }
}

// ─── Layout Algorithm ────────────────────────────────────────────────

function computeLayout(paper: PaperConfig, cards: Card[]): LayoutItem[] {
  if (!cards.length) return []

  interface Placed { card: Card; x: number; y: number; w: number; h: number; rotated: boolean }

  const overlaps = (x: number, y: number, w: number, h: number, placed: Placed[]) =>
    placed.some((p) => x < p.x + p.w && x + w > p.x && y < p.y + p.h && y + h > p.y)

  const tryPack = (cardList: Card[]): Placed[] => {
    const placed: Placed[] = []
    for (const card of cardList) {
      const orientations = [
        { w: card.width, h: card.height, rotated: false },
        { w: card.height, h: card.width, rotated: true },
      ]
      let best: { x: number; y: number; w: number; h: number; rotated: boolean } | null = null
      for (const ori of orientations) {
        if (ori.w > paper.width || ori.h > paper.height) continue
        const xs = [0]
        const ys = [0]
        for (const p of placed) {
          xs.push(p.x + p.w)
          ys.push(p.y + p.h)
        }
        for (const y of ys.sort((a, b) => a - b)) {
          for (const x of xs.sort((a, b) => a - b)) {
            if (x + ori.w > paper.width || y + ori.h > paper.height) continue
            if (overlaps(x, y, ori.w, ori.h, placed)) continue
            if (!best || y < best.y || (y === best.y && x < best.x)) {
              best = { x, y, w: ori.w, h: ori.h, rotated: ori.rotated }
            }
            break
          }
          if (best) break
        }
      }
      if (best) {
        placed.push({ card, x: best.x, y: best.y, w: best.w, h: best.h, rotated: best.rotated })
      }
    }
    return placed
  }

  // Try multiple card orders, pick the one that fits the most
  const orders = [
    [...cards],
    [...cards].sort((a, b) => b.height - a.height),
    [...cards].sort((a, b) => b.width - a.width),
    [...cards].sort((a, b) => (b.width * b.height) - (a.width * a.height)),
  ]

  let bestResult: Placed[] = []
  for (const order of orders) {
    const result = tryPack(order)
    if (result.length > bestResult.length) bestResult = result
  }

  let page = 0
  return bestResult.map((p, i) => {
    if (i > 0 && paper.width * paper.height > 0) {
      // all on same page for now
    }
    return {
      card: p.card,
      x: p.x,
      y: p.y,
      renderW: p.w,
      renderH: p.h,
      cardScale: 1,
      page,
    }
  })
}

function maxCardsByArea(paper: PaperConfig, cardW: number, cardH: number): number {
  if (!cardW || !cardH) return 1
  const cols = Math.floor(paper.width / cardW)
  const rows = Math.floor(paper.height / cardH)
  return Math.max(1, cols * rows)
}

// ─── Small Components ────────────────────────────────────────────────

function FeatureIcon({ background = '#b96c6b', color = '#ffffff', iconKey }: { background?: string; color?: string; iconKey?: FeatureIconKey }) {
  const { Icon } = getFeatureIcon(iconKey)
  return <div className="feature-icon" aria-hidden="true" style={{ background }}><Icon strokeWidth={1.8} style={{ color }} /></div>
}

function QrPreview() {
  return <div className="qr-preview" aria-hidden="true">{Array.from({ length: 25 }).map((_, i) => <i key={i} className={i % 2 === 0 || i % 7 === 0 ? 'filled' : ''} />)}</div>
}

function ImagePreview() {
  return <div className="image-preview" aria-hidden="true"><Image size={24} /></div>
}

// ─── Card Factories ─────────────────────────────────────────────────

function makeEmptyCard(preset: TagPreset): Card {
  return { id: makeId(), name: preset.name, customName: false, width: preset.width, height: preset.height, elements: [] }
}

function elementsFromDjiDraft(draft: ProductDraft, cardW = presets[0].width, cardH = presets[0].height): TagElement[] {
  const r = (v: number) => Math.round(v * 10) / 10
  const contentX = r(cardW * 0.085)
  const contentW = r(cardW * 0.83)
  const titleW = r(cardW - 10)
  const titleBaseFontSize = Math.max(r(cardW * 6.6 / 100), 4.5)
  const displayTitle = displayTitleForCard(draft.title, titleW, titleBaseFontSize)
  const titleFontSize = fitSingleLineFontSize(displayTitle, titleW, titleBaseFontSize, 3.2)
  const metaFontSize = Math.max(r(cardW * 2.35 / 100), 1.7)
  const iconSpecFontSize = Math.max(r(cardW * 4.4 / 100), 3.2)
  const featureTop = cardH * 0.15
  const featureAreaH = cardH * 0.35
  const priceTop = cardH * 0.56
  const rowH = cardH * 0.039
  const specX = contentX
  const specW = r(cardW * 0.58)
  const priceX = r(cardW * 0.64)
  const priceW = r(cardW * 0.28)
  const elements: TagElement[] = [
    { id: makeId(), kind: 'text', text: displayTitle, x: 5, y: r(cardH * 0.04), width: titleW, height: r(cardH * 0.085), fontSize: titleFontSize, fontWeight: 700, color: '#1f2937', background: 'transparent', align: 'left', radius: 0, singleLine: true },
    { id: makeId(), kind: 'text', text: 'DJI 官网套装 / 随心换服务', x: contentX, y: r(cardH * 0.105), width: contentW, height: r(cardH * 0.035), fontSize: metaFontSize, fontWeight: 400, color: '#667085', background: 'transparent', align: 'left', radius: 0, singleLine: true },
  ]

  draft.features.slice(0, 4).forEach((item, index) => {
    const featureH = featureAreaH / 4
    elements.push({
      id: makeId(), kind: 'iconSpec', text: item.text,
      x: contentX, y: r(featureTop + index * featureH),
      width: contentW, height: r(featureH * 0.74), fontSize: iconSpecFontSize, fontWeight: 500,
      color: '#344054', background: 'transparent', align: 'left', radius: 0,
      iconKey: item.iconKey, iconBackground: '#111827', iconColor: '#ffffff',
    })
  })

  const metaText = (draft.colorNames || []).join('；')
  elements.push(
    { id: makeId(), kind: 'colors', text: metaText, x: contentX, y: r(cardH * 0.505), width: contentW, height: r(cardH * 0.04), fontSize: metaFontSize, fontWeight: 400, color: '#667085', background: 'transparent', align: 'left', radius: 0, singleLine: true },
    { id: makeId(), kind: 'divider', text: '', x: contentX, y: r(cardH * 0.545), width: contentW, height: r(0.35), fontSize: 1, fontWeight: 400, color: '#98a2b3', background: '#98a2b3', align: 'left', radius: 0 },
    { id: makeId(), kind: 'text', text: '整机套装价（含飞行器）', x: contentX, y: r(priceTop), width: r(cardW * 0.48), height: r(cardH * 0.032), fontSize: metaFontSize, fontWeight: 700, color: '#475467', background: 'transparent', align: 'left', radius: 0 },
  )

  draft.skus.slice(0, 5).forEach((sku, index) => {
    const y = priceTop + cardH * 0.045 + index * rowH
    elements.push(
      { id: makeId(), kind: 'spec', text: sku.label, x: specX, y: r(y), width: specW, height: r(rowH * 0.94), fontSize: 2.55, fontWeight: 400, color: '#344054', background: 'transparent', align: 'left', radius: 0, singleLine: true },
      { id: makeId(), kind: 'price', text: sku.price, x: priceX, y: r(y - cardH * 0.002), width: priceW, height: r(rowH * 0.94), fontSize: 3.75, fontWeight: 800, color: '#111827', background: 'transparent', align: 'right', radius: 0, singleLine: true },
    )
  })

  const serviceStart = priceTop + cardH * 0.055 + draft.skus.slice(0, 5).length * rowH
  draft.services?.slice(0, 2).forEach((svc, index) => {
    const y = serviceStart + index * rowH
    elements.push(
      { id: makeId(), kind: 'spec', text: svc.label, x: specX, y: r(y), width: specW, height: r(rowH * 0.94), fontSize: 2.45, fontWeight: 400, color: '#475467', background: 'transparent', align: 'left', radius: 0, singleLine: true },
      { id: makeId(), kind: 'price', text: svc.price, x: priceX, y: r(y - cardH * 0.002), width: priceW, height: r(rowH * 0.94), fontSize: 3.35, fontWeight: 700, color: '#475467', background: 'transparent', align: 'right', radius: 0, singleLine: true },
    )
  })

  elements.push({
    id: makeId(), kind: 'footnote', text: draft.footnote,
    x: contentX, y: r(cardH * 0.91), width: contentW, height: r(cardH * 0.075),
    fontSize: 1.15, fontWeight: 400, color: '#667085', background: 'transparent', align: 'left', radius: 0,
  })
  return elements
}

function elementsFromDraft(draft: ProductDraft, cardW = presets[0].width, cardH = presets[0].height): TagElement[] {
  if (draft.template === 'dji') return elementsFromDjiDraft(draft, cardW, cardH)
  const r = (v: number) => Math.round(v * 10) / 10
  const fontSize = (pct: number, min = 2.4) => Math.max(r(cardW * pct / 100), min)
  const shouldShowService = /华为|huawei/i.test(draft.title)

  const contentX = r(cardW * 0.095)
  const contentW = r(cardW * 0.81)
  const titleX = 5
  const titleW = r(cardW - 10)
  const titleTop = 5
  const featureTop = cardH * 0.18
  const featureAreaH = cardH * 0.42
  const colorTop = cardH * 0.585
  const dividerTop = cardH * 0.645
  const priceTop = cardH * 0.685

  const titleBaseFontSize = Math.max(r(cardW * 7.2 / 100), 4.8)
  const displayTitle = displayTitleForCard(draft.title, titleW, titleBaseFontSize)
  const titleFontSize = fitSingleLineFontSize(displayTitle, titleW, titleBaseFontSize, Math.max(r(cardW * 4.6 / 100), 3.2))
  const colorNames = draft.colorNames?.length ? draft.colorNames : ['以官网为准']
  const colorText = `颜色：${colorNames.join(' / ')}`
  const metaFontSize = fontSize(2.7, 1.8)
  const colorFontSize = fitSingleLineFontSize(colorText, contentW, metaFontSize, 1.6)
  const iconSpecFontSize = fontSize(5.15, 3.7)

  const base: TagElement[] = [
    { id: makeId(), kind: 'text', text: displayTitle, x: titleX, y: r(titleTop), width: titleW, height: r(cardH * 0.095), fontSize: titleFontSize, fontWeight: 400, color: '#4a4a4a', background: 'transparent', align: 'left', radius: 0, singleLine: true },
    ...draft.features.slice(0, 4).map<TagElement>((item, index) => {
      const featureH = featureAreaH / 4
      return {
        id: makeId(), kind: 'iconSpec' as ElementKind, text: item.text,
        x: contentX, y: r(featureTop + index * featureH),
        width: contentW, height: r(featureH * 0.74), fontSize: iconSpecFontSize, fontWeight: 400,
        color: '#4b4b4b', background: 'transparent', align: 'left' as const, radius: 0,
        iconKey: item.iconKey, iconBackground: '#b96c6b', iconColor: '#ffffff',
      }
    }),
    { id: makeId(), kind: 'colors', text: colorText, x: contentX, y: r(colorTop), width: contentW, height: r(cardH * 0.042), fontSize: colorFontSize, fontWeight: 400, color: '#6f6f6f', background: 'transparent', align: 'left', radius: 0, singleLine: true },
    { id: makeId(), kind: 'divider', text: '', x: contentX, y: r(dividerTop), width: contentW, height: r(0.35), fontSize: r(1), fontWeight: 400, color: '#9d9d9d', background: '#9d9d9d', align: 'left', radius: 0 },
    { id: makeId(), kind: 'text', text: '\u5efa\u8bae\u96f6\u552e\u4ef7', x: contentX, y: r(priceTop), width: r(cardW * 0.30), height: r(cardH * 0.032), fontSize: metaFontSize, fontWeight: 400, color: '#9a9a9a', background: 'transparent', align: 'left', radius: 0 },
  ]

  const visibleSkus = draft.skus
  const svcs = shouldShowService ? (draft.services?.length ? draft.services : [draft.service]).slice(0, 2) : []
  const totalRows = visibleSkus.length + svcs.length
  const rowH = cardH * (totalRows >= 6 ? 0.033 : totalRows >= 5 ? 0.035 : 0.039)
  const priceRowsTop = cardH * 0.735
  const specFontSize = 2.8
  const priceFontSize = 4
  const specX = contentX
  const specW = r(cardW * 0.60)
  const priceX = r(cardW * 0.645)
  const priceW = r(cardW * 0.26)
  visibleSkus.forEach((sku, index) => {
    const y = priceRowsTop + index * rowH
    base.push(
      { id: makeId(), kind: 'spec', text: sku.label, x: specX, y: r(y), width: specW, height: r(rowH * 0.94), fontSize: specFontSize, fontWeight: 400, color: '#4b4b4b', background: 'transparent', align: 'left', radius: 0, singleLine: true },
      { id: makeId(), kind: 'price', text: sku.price, x: priceX, y: r(y - cardH * 0.002), width: priceW, height: r(rowH * 0.94), fontSize: priceFontSize, fontWeight: 700, color: '#4b4b4b', background: 'transparent', align: 'right', radius: 0, singleLine: true },
    )
  })

  const serviceTop = priceRowsTop + visibleSkus.length * rowH + (svcs.length ? cardH * 0.008 : 0)
  svcs.forEach((svc, index) => {
    const y = serviceTop + index * rowH
    base.push(
      { id: makeId(), kind: 'spec', text: svc.label, x: specX, y: r(y), width: specW, height: r(rowH * 0.94), fontSize: specFontSize, fontWeight: 400, color: '#4b4b4b', background: 'transparent', align: 'left', radius: 0, singleLine: true },
      { id: makeId(), kind: 'price', text: svc.price, x: priceX, y: r(y - cardH * 0.002), width: priceW, height: r(rowH * 0.94), fontSize: priceFontSize, fontWeight: 700, color: '#4b4b4b', background: 'transparent', align: 'right', radius: 0, singleLine: true },
    )
  })

  const rowsEnd = svcs.length
    ? serviceTop + svcs.length * rowH
    : priceRowsTop + visibleSkus.length * rowH
  const footnoteTop = Math.max(cardH * 0.91, rowsEnd + cardH * 0.006)
  const footnoteFontSize = 1.2
  base.push(
    { id: makeId(), kind: 'footnote', text: draft.footnote, x: contentX, y: r(footnoteTop), width: contentW, height: r(cardH - footnoteTop - cardH * 0.014), fontSize: footnoteFontSize, fontWeight: 400, color: '#686868', background: 'transparent', align: 'left', radius: 0 },
  )
  return base
}

function makeCardFromDraft(draft: ProductDraft): Card {
  return {
    id: makeId(),
    name: draft.title,
    customName: false,
    width: presets[0].width,
    height: presets[0].height,
    elements: elementsFromDraft(draft, presets[0].width, presets[0].height),
  }
}

// ─── Initial State ───────────────────────────────────────────────────

const initialDraft = buildFallbackDraft('华为Mate 80 Pro Max')
const initialCard = makeCardFromDraft(initialDraft)
const initialMaxSlots = maxCardsByArea(paperConfigs[0], presets[0].width, presets[0].height)
const initialBlanks = Array.from({ length: initialMaxSlots - 1 }, () => makeEmptyCard(presets[0]))

const initialState: AppState = {
  paper: paperConfigs[0],
  cards: [initialCard, ...initialBlanks],
  selectedCardId: initialCard.id,
  selectedElementId: '',
  viewMode: 'page',
  pageZoom: 1,
}

// ─── Main App ────────────────────────────────────────────────────────

function App() {
  const [state, setState] = useState<AppState>(initialState)
  const [productModel, setProductModel] = useState('华为Mate 80 Pro Max\n')
  const [inputWidth, setInputWidth] = useState(String(presets[0].width))
  const [inputHeight, setInputHeight] = useState(String(presets[0].height))
  const widthRef = useRef<HTMLInputElement>(null)
  const heightRef = useRef<HTMLInputElement>(null)
  const [draft, setDraft] = useState<ProductDraft>(initialDraft)
  const [isGenerating, setIsGenerating] = useState(false)
  const [statusText, setStatusText] = useState('输入型号后可自动生成价签草稿。')
  const [dragState, setDragState] = useState<{ id: string; startX: number; startY: number; baseX: number; baseY: number } | null>(null)
  const [resizeState, setResizeState] = useState<{ id: string; startX: number; startY: number; baseW: number; baseH: number } | null>(null)
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; elementId: string } | null>(null)
  const [previewScale] = useState(4.5)
  const [fillPickerOpen, setFillPickerOpen] = useState(false)
  const [confirmDialog, setConfirmDialog] = useState<{ message: string; onConfirm: () => void } | null>(null)
  const canvasRef = useRef<HTMLDivElement>(null)
  const [snapToGrid, setSnapToGrid] = useState(true)
  const [gridSize, setGridSize] = useState<2 | 5>(5)
  const [activeTab, setActiveTab] = useState<'text' | 'style' | 'pos'>('text')

  const selectedCard = state.cards.find((c) => c.id === state.selectedCardId) ?? null
  const selectedElement = selectedCard?.elements.find((e) => e.id === state.selectedElementId) ?? null

  useEffect(() => {
    if (selectedCard) {
      setInputWidth(String(selectedCard.width))
      setInputHeight(String(selectedCard.height))
    }
  }, [state.selectedCardId])

  const printableScale = useMemo(
    () => selectedCard ? Math.min(720 / selectedCard.width, 700 / selectedCard.height, previewScale) : previewScale,
    [previewScale, selectedCard],
  )

  // Auto-adjust card count to fit paper area
  const paperKey = `${state.paper.width}x${state.paper.height}`
  const cardDims = selectedCard ? `${selectedCard.width}x${selectedCard.height}` : ''
  useEffect(() => {
    setState((s) => {
      const cw = s.cards[0]?.width ?? presets[0].width
      const ch = s.cards[0]?.height ?? presets[0].height
      const max = Math.min(maxCardsByArea(s.paper, cw, ch), 50)
      if (s.cards.length === max) return s
      if (s.cards.length > max) {
        const trimmed = [...s.cards]
        while (trimmed.length > max) {
          const blankIdx = trimmed.findLastIndex((c) => c.elements.length === 0)
          if (blankIdx >= 0) trimmed.splice(blankIdx, 1)
          else trimmed.pop()
        }
        return { ...s, cards: trimmed }
      }
      // Add blank cards to fill the page
      let emptyIdx = s.cards.filter((c) => c.elements.length === 0).length
      const blanks = Array.from({ length: max - s.cards.length }, () => {
        emptyIdx++
        return makeEmptyCard({ name: `价签${cw}*${ch}自定义${emptyIdx}`, width: cw, height: ch })
      })
      return { ...s, cards: [...s.cards, ...blanks] }
    })
  }, [paperKey, cardDims])

  // ─── State Updaters ──────────────────────────────────────────────

  const updateCard = useCallback((cardId: string, patch: Partial<Card>) => {
    setState((s) => ({
      ...s,
      cards: s.cards.map((c) => (c.id === cardId ? { ...c, ...patch } : c)),
    }))
  }, [])

  const updateElement = useCallback((cardId: string, elementId: string, patch: Partial<TagElement>) => {
    setState((s) => ({
      ...s,
      cards: s.cards.map((c) =>
        c.id === cardId
          ? { ...c, elements: c.elements.map((e) => (e.id === elementId ? { ...e, ...patch } : e)) }
          : c,
      ),
    }))
  }, [])

  const setCardSize = useCallback((cardId: string, newWidth: number, newHeight: number, name?: string) => {
    setState((s) => {
      const card = s.cards.find((c) => c.id === cardId)
      if (!card) return s
      const sw = newWidth / card.width
      const sh = newHeight / card.height
      const scaledElements = scaleElements(card.elements, sw, sh)
      return {
        ...s,
        cards: s.cards.map((c) =>
          c.id === cardId
            ? { ...c, width: newWidth, height: newHeight, name: name ?? c.name, elements: scaledElements }
            : c,
        ),
      }
    })
  }, [])

  // ─── Card Management ─────────────────────────────────────────────


  // ─── Batch Actions ───────────────────────────────────────────────

  const fillAllWithSelected = useCallback(() => {
    if (!selectedCard) return
    setState((s) => {
      const source = s.cards.find((c) => c.id === s.selectedCardId)
      if (!source || source.elements.length === 0) return s
      return {
        ...s,
        cards: s.cards.map((c) => {
          if (c.id === s.selectedCardId) return c
          return {
            ...c,
            name: source.name,
            customName: false,
            elements: source.elements.map((e) => ({ ...e, id: makeId() })),
          }
        }),
      }
    })
  }, [selectedCard])

  const fillToCard = useCallback((targetId: string) => {
    if (!selectedCard || selectedCard.id === targetId) return
    setState((s) => {
      const source = s.cards.find((c) => c.id === s.selectedCardId)
      if (!source) return s
      return {
        ...s,
        cards: s.cards.map((c) =>
          c.id === targetId
            ? { ...c, name: source.name, customName: false, elements: source.elements.map((e) => ({ ...e, id: makeId() })) }
            : c,
        ),
      }
    })
  }, [selectedCard])

  // ─── Element Management ──────────────────────────────────────────

  const duplicateSelectedElement = useCallback(() => {
    if (!selectedCard || !selectedElement) return
    const copy: TagElement = {
      ...selectedElement, id: makeId(),
      x: clamp(selectedElement.x + 4, 0, selectedCard.width - selectedElement.width),
      y: clamp(selectedElement.y + 4, 0, selectedCard.height - selectedElement.height),
    }
    setState((s) => ({
      ...s,
      cards: s.cards.map((c) =>
        c.id === s.selectedCardId ? { ...c, elements: [...c.elements, copy] } : c,
      ),
      selectedElementId: copy.id,
    }))
  }, [selectedCard, selectedElement])

  const deleteSelectedElement = useCallback(() => {
    if (!selectedCard || !selectedElement) return
    setState((s) => ({
      ...s,
      cards: s.cards.map((c) =>
        c.id === s.selectedCardId
          ? { ...c, elements: c.elements.filter((e) => e.id !== s.selectedElementId) }
          : c,
      ),
      selectedElementId: '',
    }))
  }, [selectedCard, selectedElement])

  const addNewElement = useCallback((kind: ElementKind) => {
    if (!selectedCard) return
    const defaults: Record<ElementKind, () => TagElement> = {
      text: () => ({ id: makeId(), kind: 'text', text: '新文字', x: 10, y: 10, width: 50, height: 6, fontSize: 3, fontWeight: 500, color: '#111827', background: 'transparent', align: 'left', radius: 0 }),
      price: () => ({ id: makeId(), kind: 'price', text: '¥ 0', x: 60, y: 10, width: 25, height: 6, fontSize: 4, fontWeight: 700, color: '#4b4b4b', background: 'transparent', align: 'right', radius: 0 }),
      spec: () => ({ id: makeId(), kind: 'spec', text: '参数内容', x: 15, y: 20, width: 45, height: 5, fontSize: 2.5, fontWeight: 500, color: '#4b4b4b', background: 'transparent', align: 'left', radius: 0 }),
      badge: () => ({ id: makeId(), kind: 'badge', text: '标签', x: 10, y: 10, width: 20, height: 6, fontSize: 2.5, fontWeight: 700, color: '#ffffff', background: '#0f766e', align: 'center', radius: 1 }),
      qr: () => ({ id: makeId(), kind: 'qr', text: '', x: 35, y: 30, width: 30, height: 30, fontSize: 1, fontWeight: 400, color: '#111827', background: 'transparent', align: 'center', radius: 0 }),
      image: () => ({ id: makeId(), kind: 'image', text: '', x: 20, y: 20, width: 60, height: 50, fontSize: 1, fontWeight: 400, color: '#64748b', background: 'transparent', align: 'center', radius: 0 }),
      iconSpec: () => ({ id: makeId(), kind: 'iconSpec', text: '卖点描述', x: 15, y: 30, width: 65, height: 11, fontSize: 2.8, fontWeight: 500, color: '#4b4b4b', background: 'transparent', align: 'left', radius: 0, iconKey: 'phone' as FeatureIconKey, iconBackground: '#b96c6b', iconColor: '#ffffff' }),
      colors: () => ({ id: makeId(), kind: 'colors', text: '颜色：黑色 / 白色', x: 15, y: 50, width: 60, height: 8, fontSize: 2.2, fontWeight: 500, color: '#6f6f6f', background: 'transparent', align: 'left', radius: 0 }),
      divider: () => ({ id: makeId(), kind: 'divider', text: '', x: 15, y: 20, width: 70, height: 0.5, fontSize: 1, fontWeight: 400, color: '#b5b5b5', background: '#b5b5b5', align: 'left', radius: 0 }),
      footnote: () => ({ id: makeId(), kind: 'footnote', text: '备注信息', x: 15, y: 80, width: 65, height: 12, fontSize: 1.5, fontWeight: 400, color: '#696969', background: 'transparent', align: 'left', radius: 0 }),
    }
    const el = defaults[kind]()
    setState((s) => ({
      ...s,
      cards: s.cards.map((c) =>
        c.id === s.selectedCardId ? { ...c, elements: [...c.elements, el] } : c,
      ),
      selectedElementId: el.id,
    }))
  }, [selectedCard])

  // ─── Draft Loading ───────────────────────────────────────────────

  // ─── Auto Generate ───────────────────────────────────────────────

  const searchModel = async (model: string): Promise<ProductDraft> => {
    const staticDjiEntry = findStaticDjiEntry(await loadStaticDjiProducts(), model)
    if (staticDjiEntry?.ok && staticDjiEntry.product) {
      return buildDraftFromDji(staticDjiEntry.product)
    }

    const staticEntry = findStaticProductEntry(await loadStaticProducts(), model)
    if (staticEntry?.ok && staticEntry.product) {
      return buildDraftFromOfficial(model, staticEntry.product, staticEntry.zhihuItems || [])
    }

    const isStaticSite = !location.hostname.includes('localhost') && !location.hostname.includes('127.0.0.1')
    if (isStaticSite) {
      return {
        ...buildFallbackDraft(model),
        sourceNotes: [
          '静态产品库暂未收录该型号，已生成通用门店价签草稿。',
          '如需官网数据，请将该型号加入 data/models.txt 并等待数据刷新。',
        ],
      }
    }

    const isHonorModel = /荣耀|honor/i.test(model)
    const official = await fetch(`/api/official/search?model=${encodeURIComponent(model)}`)
      .then(r => r.json())
      .catch(() => ({ ok: false, message: '官网接口请求失败。' }))
    const zhihuItems: ZhihuItem[] = isHonorModel
      ? await fetch(`/api/zhihu/global-search?count=8&query=${encodeURIComponent(`${model} 卖点 参数 评测`)}`)
        .then(r => r.json())
        .then(data => Array.isArray(data.items) ? data.items : [])
        .catch(() => [])
      : []

    const hasOfficial = official.ok && official.product

    if (hasOfficial) {
      if (official.source === 'dji' && official.product?.bundles) {
        return buildDraftFromDji(official.product)
      }
      return buildDraftFromOfficial(model, official.product, zhihuItems)
    }

    throw new Error(official.message || '官网未找到该产品。')
  }

  const loadDraftIntoCard = useCallback((cardId: string, nextDraft: ProductDraft) => {
    setState((s) => {
      const card = s.cards.find((c) => c.id === cardId)
      const cw = card?.width ?? presets[0].width
      const ch = card?.height ?? presets[0].height
      const newElements = elementsFromDraft(nextDraft, cw, ch)
      return {
        ...s,
        cards: s.cards.map((c) =>
          c.id === cardId
            ? { ...c, name: c.customName ? c.name : nextDraft.title, elements: newElements }
            : c,
        ),
      }
    })
  }, [])

  const generateCurrent = async () => {
    const model = productModel.split('\n').map((l) => l.trim()).filter(Boolean)[0]
    if (!model || !selectedCard) return
    setIsGenerating(true)
    setStatusText('正在搜索并生成价签草稿...')
    try {
      const nextDraft = await searchModel(model)
      loadDraftIntoCard(selectedCard.id, nextDraft)
      setDraft(nextDraft)
      setStatusText(
        nextDraft.source === 'official' ? '已从官网获取数据并生成草稿，请复核。'
          : nextDraft.source === 'zhihu' ? '已生成草稿，请复核。'
          : nextDraft.sourceNotes[0] || '未拿到搜索结果，已使用本地规则生成。'
      )
    } catch (error) {
      setStatusText(error instanceof Error ? error.message : '官网数据获取失败。')
    } finally {
      setIsGenerating(false)
    }
  }

  const batchGenerate = async () => {
    const models = productModel.split('\n').map((l) => l.trim()).filter(Boolean)
    if (!models.length) return
    setIsGenerating(true)
    let successCount = 0
    try {
      for (let i = 0; i < models.length; i++) {
        const model = models[i]
        setStatusText(`正在生成 (${i + 1}/${models.length}): ${model}...`)
        let targetId: string
        setState((s) => {
          const blankIdx = s.cards.findIndex((c) => c.elements.length === 0)
          if (blankIdx >= 0) {
            targetId = s.cards[blankIdx].id
            return { ...s, selectedCardId: targetId }
          }
          const newCard = makeEmptyCard({ name: presets[0].name, width: presets[0].width, height: presets[0].height })
          targetId = newCard.id
          return { ...s, cards: [...s.cards, newCard], selectedCardId: newCard.id }
        })
        await new Promise((r) => setTimeout(r, 50))
        try {
          const nextDraft = await searchModel(model)
          loadDraftIntoCard(targetId!, nextDraft)
          if (i === 0) setDraft(nextDraft)
          successCount++
        } catch (error) {
          setStatusText(error instanceof Error ? error.message : `${model} 官网数据获取失败。`)
        }
      }
      setStatusText(successCount ? `已从官网批量生成 ${successCount} 张价签草稿，请复核。` : '官网未返回可用产品数据。')
    } finally {
      setIsGenerating(false)
    }
  }

  // ─── Capture & Export ────────────────────────────────────────────

  const fileInputRef = useRef<HTMLInputElement>(null)

  const handleImportFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = (ev) => {
      try {
        const data = ev.target?.result
        let models: string[] = []
        if (file.name.endsWith('.csv')) {
          const text = data as string
          const lines = text.split(/\r?\n/).filter(Boolean)
          models = lines.map(l => l.split(',')[0].trim()).filter(m => m.length > 1 && !/型号|model|name/i.test(m))
        } else {
          const wb = XLSX.read(data, { type: 'binary' })
          const ws = wb.Sheets[wb.SheetNames[0]]
          const rows = XLSX.utils.sheet_to_json<string[]>(ws, { header: 1 })
          models = rows.map(r => String(r[0] || '').trim()).filter(m => m.length > 1 && !/型号|model|name/i.test(m))
        }
        if (models.length) {
          setProductModel(models.join('\n'))
          setStatusText(`已导入 ${models.length} 个型号，点击「批量生成」开始生成。`)
        } else {
          setStatusText('未找到有效型号，请检查文件格式。')
        }
      } catch {
        setStatusText('文件解析失败，请确认格式正确。')
      }
    }
    if (file.name.endsWith('.csv')) {
      reader.readAsText(file)
    } else {
      reader.readAsBinaryString(file)
    }
    e.target.value = ''
  }

  // ─── Capture & Export ────────────────────────────────────────────
  const captureCardImage = useCallback(async (card: Card) => {
    const scale = Math.min(720 / card.width, 700 / card.height, 4.5)
    const container = document.createElement('div')
    container.style.cssText = 'position:fixed;left:-9999px;top:0;z-index:-1;'
    document.body.appendChild(container)

    const wrapper = document.createElement('div')
    wrapper.style.cssText = `position:relative;width:${card.width * scale}px;height:${card.height * scale}px;background:#fff;overflow:hidden;`
    container.appendChild(wrapper)

    for (const el of card.elements) {
      const div = document.createElement('div')
      const whiteSpace = el.singleLine ? 'nowrap' : 'pre-wrap'
      div.style.cssText = `
        position:absolute;display:flex;align-items:center;box-sizing:border-box;
        left:${el.x * scale}px;top:${el.y * scale}px;
        width:${el.width * scale}px;height:${Math.max(el.height * scale, 1)}px;
        color:${el.color};background:${el.background};
        border-radius:${el.radius * scale}px;
        justify-content:${getAlignOffset(el.align)};
        text-align:${el.align};
        font-size:${el.fontSize * scale}px;font-weight:${el.fontWeight};
        line-height:1.08;white-space:${whiteSpace};overflow:hidden;
        padding:0.12em 0.2em;
      `
      if (el.kind === 'iconSpec') {
        const iconDiv = document.createElement('div')
        iconDiv.style.cssText = `display:grid;place-items:center;flex:0 0 auto;width:1.65em;height:1.65em;border-radius:0.32em;background:${el.iconBackground ?? '#b96c6b'};`
        appendExportFeatureIcon(iconDiv, el.iconKey, el.iconColor ?? '#ffffff')
        div.style.gap = '0.55em'
        div.appendChild(iconDiv)
      }
      if (el.kind !== 'divider') {
        const span = document.createElement('span')
        span.textContent = el.text
        span.style.cssText = `display:block;width:100%;overflow:hidden;text-overflow:ellipsis;white-space:${whiteSpace};`
        div.appendChild(span)
      }
      wrapper.appendChild(div)
    }
    const cutBorder = document.createElement('div')
    cutBorder.style.cssText = `position:absolute;inset:0;border:${Math.max(1, Math.round(scale * 0.2))}px solid #b8b8b8;box-sizing:border-box;pointer-events:none;`
    wrapper.appendChild(cutBorder)

    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
    const result = await html2canvas(container, { backgroundColor: '#ffffff', scale: 3, useCORS: true })
    document.body.removeChild(container)
    return result
  }, [])

  const exportCurrentCardPdf = async () => {
    if (!selectedCard) return
    const canvas = await captureCardImage(selectedCard)
    if (!canvas) return
    const pdf = new jsPDF({
      orientation: selectedCard.width >= selectedCard.height ? 'landscape' : 'portrait',
      unit: 'mm',
      format: [selectedCard.width, selectedCard.height],
    })
    pdf.addImage(canvas.toDataURL('image/png', 1), 'PNG', 0, 0, selectedCard.width, selectedCard.height)
    pdf.save('price-tag.pdf')
  }

  const exportCurrentCardPng = async () => {
    if (!selectedCard) return
    const canvas = await captureCardImage(selectedCard)
    if (!canvas) return
    const link = document.createElement('a')
    link.download = 'price-tag.png'
    link.href = canvas.toDataURL('image/png', 1)
    link.click()
  }

  const exportPagePdf = async () => {
    if (!state.cards.length) return
    setStatusText('正在生成多卡片 PDF...')
    try {
      const cardImages = new Map<string, HTMLCanvasElement>()
      for (const card of state.cards) {
        const img = await captureCardImage(card)
        if (img) cardImages.set(card.id, img)
      }

      const { paper } = state
      const pdf = new jsPDF({
        orientation: paper.width > paper.height ? 'landscape' : 'portrait',
        unit: 'mm',
        format: [paper.width, paper.height],
      })

      const layout = computeLayout(paper, state.cards)
      const pages = Math.max(1, ...layout.map((l) => l.page + 1))

      for (let pg = 0; pg < pages; pg++) {
        if (pg > 0) pdf.addPage([paper.width, paper.height], paper.width > paper.height ? 'landscape' : 'portrait')

        const pageItems = layout.filter((l) => l.page === pg)
        for (const item of pageItems) {
          const img = cardImages.get(item.card.id)
          if (!img) continue
          const dataUrl = img.toDataURL('image/png', 1)
          pdf.addImage(dataUrl, 'PNG', item.x, item.y, item.renderW, item.renderH)
        }
      }

      pdf.save('price-tags.pdf')
      setStatusText('PDF 导出完成。')
    } catch {
      setStatusText('PDF 导出失败，请重试。')
    }
  }

  const printPage = async () => {
    await exportPagePdf()
    window.setTimeout(() => window.print(), 300)
  }

  // ─── Drag Handlers ───────────────────────────────────────────────

  const onPointerDown = (event: React.PointerEvent, element: TagElement) => {
    if (!selectedCard) return
    setState((s) => ({ ...s, selectedElementId: element.id }))
    setDragState({ id: element.id, startX: event.clientX, startY: event.clientY, baseX: element.x, baseY: element.y })
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  const onPointerMove = (event: React.PointerEvent) => {
    if (dragState && selectedCard) {
      const element = selectedCard.elements.find((e) => e.id === dragState.id)
      if (!element) return
      let newX = dragState.baseX + (event.clientX - dragState.startX) / printableScale
      let newY = dragState.baseY + (event.clientY - dragState.startY) / printableScale
      
      if (snapToGrid) {
        newX = Math.round(newX / gridSize) * gridSize
        newY = Math.round(newY / gridSize) * gridSize
      }

      newX = clamp(newX, 0, selectedCard.width - element.width)
      newY = clamp(newY, 0, selectedCard.height - element.height)
      updateElement(selectedCard.id, dragState.id, { x: newX, y: newY })
    }
    if (resizeState && selectedCard) {
      const element = selectedCard.elements.find((e) => e.id === resizeState.id)
      if (!element) return
      let newW = resizeState.baseW + (event.clientX - resizeState.startX) / printableScale
      let newH = resizeState.baseH + (event.clientY - resizeState.startY) / printableScale

      if (snapToGrid) {
        newW = Math.round(newW / gridSize) * gridSize
        newH = Math.round(newH / gridSize) * gridSize
      }

      newW = Math.max(5, newW)
      newH = Math.max(5, newH)
      updateElement(selectedCard.id, resizeState.id, { width: newW, height: newH })
    }
  }

  const onResizePointerDown = (event: React.PointerEvent, element: TagElement) => {
    event.stopPropagation()
    setResizeState({ id: element.id, startX: event.clientX, startY: event.clientY, baseW: element.width, baseH: element.height })
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  // ─── Context Menu ─────────────────────────────────────────────

  const onElementContextMenu = (event: React.MouseEvent, element: TagElement) => {
    event.preventDefault()
    setState((s) => ({ ...s, selectedElementId: element.id }))
    setContextMenu({ x: event.clientX, y: event.clientY, elementId: element.id })
  }

  const contextMenuActions = {
    copy: () => {
      if (!selectedCard || !contextMenu) return
      const el = selectedCard.elements.find(e => e.id === contextMenu.elementId)
      if (!el) return
      const newEl: TagElement = { ...el, id: makeId(), x: el.x + 5, y: el.y + 5 }
      setState((s) => ({
        ...s,
        cards: s.cards.map(c => c.id === selectedCard.id ? { ...c, elements: [...c.elements, newEl] } : c),
        selectedElementId: newEl.id,
      }))
      setContextMenu(null)
    },
    delete: () => {
      if (!selectedCard || !contextMenu) return
      setState((s) => ({
        ...s,
        selectedElementId: '',
        cards: s.cards.map(c => c.id === selectedCard.id ? { ...c, elements: c.elements.filter(e => e.id !== contextMenu.elementId) } : c),
      }))
      setContextMenu(null)
    },
    toFront: () => {
      if (!selectedCard || !contextMenu) return
      setState((s) => ({
        ...s,
        cards: s.cards.map(c => {
          if (c.id !== selectedCard.id) return c
          const el = c.elements.find(e => e.id === contextMenu.elementId)
          if (!el) return c
          return { ...c, elements: [...c.elements.filter(e => e.id !== contextMenu.elementId), el] }
        }),
      }))
      setContextMenu(null)
    },
    toBack: () => {
      if (!selectedCard || !contextMenu) return
      setState((s) => ({
        ...s,
        cards: s.cards.map(c => {
          if (c.id !== selectedCard.id) return c
          const el = c.elements.find(e => e.id === contextMenu.elementId)
          if (!el) return c
          return { ...c, elements: [el, ...c.elements.filter(e => e.id !== contextMenu.elementId)] }
        }),
      }))
      setContextMenu(null)
    },
  }

  // ─── Page View Render ────────────────────────────────────────────

  const stageRef = useRef<HTMLDivElement>(null)
  const [pageScale, setPageScale] = useState(2.5)

  useEffect(() => {
    const el = stageRef.current
    if (!el) return
    const ro = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect
      const pad = 48
      const s = Math.min((width - pad) / state.paper.width, (height - pad) / state.paper.height)
      setPageScale(Math.max(1, s))
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [state.paper.width, state.paper.height])

  const renderPageView = () => {
    const layout = computeLayout(state.paper, state.cards)
    const pw = state.paper.width * pageScale
    const ph = state.paper.height * pageScale

    return (
      <section className="canvas-stage" ref={stageRef}>
        <div className="ruler">
          <span>{state.paper.label} · {state.cards.length} 张卡片</span>
          <span className="ruler-divider" />
          {paperConfigs.map((p) => (
            <button
              key={p.size}
              type="button"
              className={['ruler-btn', state.paper.size === p.size ? 'active' : ''].join(' ')}
              onClick={() => {
                const cfg = paperConfigs.find((pc) => pc.size === p.size)
                if (cfg) setState((s) => ({ ...s, paper: cfg }))
              }}
            >{p.size.toUpperCase()}</button>
          ))}
        </div>
        <div className="page-canvas-wrapper" style={{ width: pw, height: ph }}>
          <div className="page-canvas" style={{ width: pw, height: ph }}>
          {layout.filter((l) => l.page === 0).map((item) => (
            <div
              key={item.card.id}
              className={['page-card', item.card.id === state.selectedCardId ? 'page-card-selected' : ''].join(' ')}
              style={{
                left: item.x * pageScale,
                top: item.y * pageScale,
                width: item.renderW * pageScale,
                height: item.renderH * pageScale,
              }}
              onClick={() => setState((s) => ({ ...s, selectedCardId: item.card.id, selectedElementId: '', viewMode: 'card' }))}
            >
              <div className="page-card-label">{item.card.name || '空白价签'}</div>
              {item.card.elements.map((el) => (
                <div
                  key={el.id}
                  className={['tag-element', `kind-${el.kind}`, el.singleLine ? 'single-line' : ''].filter(Boolean).join(' ')}
                  style={{
                    left: (el.x / item.card.width) * 100 + '%',
                    top: (el.y / item.card.height) * 100 + '%',
                    width: (el.width / item.card.width) * 100 + '%',
                    height: Math.max((el.height / item.card.height) * 100, 0.3) + '%',
                    color: el.color,
                    background: el.background,
                    borderRadius: (el.radius / item.card.width) * 100 + '%',
                    justifyContent: getAlignOffset(el.align),
                    textAlign: el.align,
                    fontSize: (el.fontSize / item.card.width) * item.renderW * pageScale * 0.65 + 'px',
                    fontWeight: el.fontWeight,
                  }}
                >
                  {el.kind === 'iconSpec' ? <FeatureIcon background={el.iconBackground} color={el.iconColor} iconKey={el.iconKey} /> : null}
                  {el.kind !== 'divider' ? <span>{el.text}</span> : null}
                </div>
              ))}
            </div>
          ))}
          </div>
        </div>
      </section>
    )
  }

  // ─── Card Editor Render ──────────────────────────────────────────

  const renderCardEditor = () => {
    if (!selectedCard) return null
    return (
      <section className="canvas-stage">
        <div className="ruler">
          <button type="button" className="back-btn" onClick={() => setState((s) => ({ ...s, viewMode: 'page' }))}>
            <Layout size={14} /> 返回页面视图
          </button>
          <span>{selectedCard.width}mm x {selectedCard.height}mm</span>
        </div>
        <div
          ref={canvasRef}
          className="tag-canvas"
          style={{ width: selectedCard.width * printableScale, height: selectedCard.height * printableScale }}
          onPointerMove={onPointerMove}
          onPointerUp={() => { setDragState(null); setResizeState(null) }}
          onPointerLeave={() => { setDragState(null); setResizeState(null) }}
        >
          {selectedCard.elements.map((element) => (
            <div
              role="button"
              tabIndex={0}
              className={['tag-element', `kind-${element.kind}`, element.singleLine ? 'single-line' : '', element.id === state.selectedElementId ? 'selected' : ''].filter(Boolean).join(' ')}
              key={element.id}
              onPointerDown={(e) => onPointerDown(e, element)}
              onContextMenu={(e) => onElementContextMenu(e, element)}
              onDoubleClick={() => {
                const text = window.prompt('编辑内容', element.text)
                if (text !== null) updateElement(selectedCard.id, element.id, { text })
              }}
              style={{
                left: element.x * printableScale,
                top: element.y * printableScale,
                width: element.width * printableScale,
                height: Math.max(element.height * printableScale, 1),
                color: element.color,
                background: element.background,
                borderRadius: element.radius * printableScale,
                justifyContent: getAlignOffset(element.align),
                textAlign: element.align,
                fontSize: element.fontSize * printableScale,
                fontWeight: element.fontWeight,
              }}
            >
              {element.kind === 'iconSpec' ? <FeatureIcon background={element.iconBackground} color={element.iconColor} iconKey={element.iconKey} /> : null}
              {element.kind === 'qr' ? <QrPreview /> : null}
              {element.kind === 'image' ? <ImagePreview /> : null}
              {element.kind !== 'divider' ? <span>{element.text}</span> : null}
              {element.id === state.selectedElementId ? (
                <div className="resize-handle" onPointerDown={(e) => onResizePointerDown(e, element)} />
              ) : null}
            </div>
          ))}
          {contextMenu ? (
            <div className="context-menu" style={{ left: contextMenu.x, top: contextMenu.y }} onClick={() => setContextMenu(null)}>
              <button type="button" onClick={contextMenuActions.copy}>复制元素</button>
              <button type="button" onClick={contextMenuActions.delete}>删除元素</button>
              <button type="button" onClick={contextMenuActions.toFront}>置顶</button>
              <button type="button" onClick={contextMenuActions.toBack}>置底</button>
            </div>
          ) : null}
        </div>
      </section>
    )
  }

  // ─── Main Render ─────────────────────────────────────────────────

  return (
    <main className="app-shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">Digital Price Tag Studio</p>
          <h1>数码产品价签编辑器</h1>
        </div>
        <div className="topbar-actions">
          <div className="top-contact-links">
            <span>定制开发 / 智能体 / 门店工具：微信 xj0991988</span>
            <a href="https://1go.im/xhs/" target="_blank" rel="noreferrer">小红书工具站</a>
            <a href="https://verify.1go.im" target="_blank" rel="noreferrer">验证工具</a>
          </div>
          <button type="button" className="tool-button" onClick={exportCurrentCardPdf}><Download size={17} />导出当前卡</button>
          <button type="button" className="tool-button" onClick={exportCurrentCardPng}><Image size={17} />PNG</button>
          <button type="button" className="tool-button" onClick={exportPagePdf}><Download size={17} />导出全部 PDF</button>
          <button type="button" className="primary-button" onClick={printPage}><Printer size={17} />打印</button>
        </div>
      </header>

      <section className="workspace">
        {/* ─── Left Panel ──────────────────────────────────────────── */}
        <aside className="panel">
          {state.viewMode === 'page' ? (
            <>
              {/* Card Size */}
              <div className="panel-section">
                <h2>尺寸与格式</h2>
                <label>预设
                  <select value={`${selectedCard?.width ?? presets[0].width}x${selectedCard?.height ?? presets[0].height}`} onChange={(e) => {
                    const p = presets.find((pr) => `${pr.width}x${pr.height}` === e.target.value)
                    if (p && selectedCard) setCardSize(selectedCard.id, p.width, p.height, p.name)
                  }}>
                    {presets.map((p) => <option key={p.name} value={`${p.width}x${p.height}`}>{p.name}</option>)}
                    {selectedCard ? <option value={`${selectedCard.width}x${selectedCard.height}`}>自定义 {selectedCard.width}x{selectedCard.height}</option> : null}
                  </select>
                </label>
                <div className="size-grid">
                  <label>宽 mm
                    <input ref={widthRef} type="number" value={inputWidth}
                      onChange={(e) => setInputWidth(e.target.value)} />
                  </label>
                  <label>高 mm
                    <input ref={heightRef} type="number" value={inputHeight}
                      onChange={(e) => setInputHeight(e.target.value)} />
                  </label>
                </div>
                <div className="action-row">
                  <button type="button" className="wide-action primary-inline" onClick={() => {
                    if (selectedCard) setCardSize(selectedCard.id, Number(widthRef.current?.value) || selectedCard.width, Number(heightRef.current?.value) || selectedCard.height, '自定义尺寸')
                  }}>单个应用尺寸</button>
                  <button type="button" className="wide-action" onClick={() => {
                    const w = Number(widthRef.current?.value) || selectedCard?.width || 100
                    const h = Number(heightRef.current?.value) || selectedCard?.height || 185
                    setState((s) => {
                      // Scale and rename existing cards
                      const nameCounts = new Map<string, number>()
                      for (const c of s.cards) {
                        if (c.elements.length > 0 && c.name) {
                          nameCounts.set(c.name, (nameCounts.get(c.name) ?? 0) + 1)
                        }
                      }
                      const nameIdx = new Map<string, number>()
                      let emptyIdx = 0
                      const scaled = s.cards.map((c) => {
                        const sw = w / c.width, sh = h / c.height
                        const els = scaleElements(c.elements, sw, sh)
                        let newName: string
                        if (c.elements.length === 0 || !c.name) {
                          emptyIdx++
                          newName = `价签${w}*${h}自定义${emptyIdx}`
                        } else if ((nameCounts.get(c.name) ?? 0) > 1) {
                          const n = (nameIdx.get(c.name) ?? 0) + 1
                          nameIdx.set(c.name, n)
                          newName = `${c.name}${n}`
                        } else {
                          newName = c.name
                        }
                        return { ...c, width: w, height: h, name: newName, elements: els }
                      })
                      // Add/remove blanks to fit page
                      const max = Math.min(maxCardsByArea(s.paper, w, h), 50)
                      if (scaled.length < max) {
                        for (let i = scaled.length; i < max; i++) {
                          emptyIdx++
                          scaled.push(makeEmptyCard({ name: `价签${w}*${h}自定义${emptyIdx}`, width: w, height: h }))
                        }
                      } else if (scaled.length > max) {
                        while (scaled.length > max) {
                          const blankIdx = scaled.findLastIndex((c) => c.elements.length === 0)
                          if (blankIdx >= 0) scaled.splice(blankIdx, 1)
                          else scaled.pop()
                        }
                      }
                      return { ...s, cards: scaled }
                    })
                  }}>统一应用尺寸</button>
                </div>
              </div>

              {/* Card Management */}
              <div className="panel-section">
                <h2>卡片管理 ({state.cards.length})</h2>
                <div className="card-list">
                  {state.cards.map((card) => (
                    <div
                      key={card.id}
                      className={['card-item', card.id === state.selectedCardId ? 'active' : ''].join(' ')}
                      onClick={() => setState((s) => ({ ...s, selectedCardId: card.id, selectedElementId: '' }))}
                    >
                      <span className="card-item-name">{card.name || '空白价签'}</span>
                      <span className="card-item-size">{card.width}x{card.height} · {card.elements.length}个元素</span>
                      <div className="card-item-actions">
                        {card.elements.length > 0 ? (
                          <button type="button" className="icon-btn danger-icon" title="清空内容" onClick={(e) => {
                            e.stopPropagation()
                            setConfirmDialog({
                              message: `该操作会清空「${card.name || '空白价签'}」的全部内容，且无法恢复，是否确认？`,
                              onConfirm: () => {
                                setState((s) => ({
                                  ...s,
                                  cards: s.cards.map((c) => c.id === card.id
                                    ? { ...c, name: `价签${c.width}*${c.height}空白`, customName: false, elements: [] }
                                    : c,
                                  ),
                                }))
                                setConfirmDialog(null)
                              },
                            })
                          }}><Trash2 size={13} /></button>
                        ) : null}
                      </div>
                    </div>
                  ))}
                </div>
                {selectedCard && selectedCard.elements.length > 0 ? (
                  <div className="action-row">
                    <button type="button" className="wide-action" onClick={() => setFillPickerOpen(true)}><Copy size={14} />填充到</button>
                    <button type="button" className="wide-action" onClick={() => {
                      const targets = state.cards.filter((c) => c.id !== selectedCard.id)
                      if (!targets.length) return
                      setConfirmDialog({
                        message: `该操作会覆盖全部 ${targets.length} 张卡片的原有内容，且无法恢复，是否确认？`,
                        onConfirm: () => { fillAllWithSelected(); setConfirmDialog(null) },
                      })
                    }}><Rows3 size={14} />填充全部</button>
                  </div>
                ) : null}
              </div>
            </>
          ) : (
            <>
              {/* Auto Generate */}
              <div className="panel-section">
                <h2>自动生成</h2>
                <label>产品型号（每行一个）
                  <textarea rows={3} value={productModel} onChange={(e) => setProductModel(e.target.value)} placeholder={"华为Mate 80 Pro Max\n小米15 Ultra\niPhone 16 Pro Max"} />
                </label>
                <div className="action-row">
                  <button type="button" className="wide-action primary-inline" disabled={isGenerating} onClick={generateCurrent}>
                    {isGenerating ? <Loader2 className="spin" size={16} /> : <Search size={16} />}生成当前
                  </button>
                  <button type="button" className="wide-action" disabled={isGenerating} onClick={batchGenerate}>
                    {isGenerating ? <Loader2 className="spin" size={16} /> : <Rows3 size={16} />}批量生成
                  </button>
                </div>
                <div className="action-row">
                  <input ref={fileInputRef} type="file" accept=".csv,.xlsx,.xls" style={{ display: 'none' }} onChange={handleImportFile} />
                  <button type="button" className="wide-action" disabled={isGenerating} onClick={() => fileInputRef.current?.click()}>
                    <Upload size={16} />批量导入
                  </button>
                </div>
                <p className="hint">{statusText}</p>
                {draft.sourceNotes.length ? (
                  <div className="source-list">{draft.sourceNotes.map((n) => <p key={n}>{n}</p>)}</div>
                ) : null}
              </div>

              {/* Add Elements */}
              <div className="panel-section">
                <h2>添加元素</h2>
                <div className="tool-grid">
                  <button type="button" onClick={() => addNewElement('text')}>文字</button>
                  <button type="button" onClick={() => addNewElement('price')}>价格</button>
                  <button type="button" onClick={() => addNewElement('spec')}>参数</button>
                  <button type="button" onClick={() => addNewElement('badge')}>标签</button>
                  <button type="button" onClick={() => addNewElement('iconSpec')}>图标卖点</button>
                  <button type="button" onClick={() => addNewElement('colors')}>颜色</button>
                  <button type="button" onClick={() => addNewElement('divider')}>分割线</button>
                  <button type="button" onClick={() => addNewElement('footnote')}>脚注</button>
                </div>
              </div>
            </>
          )}
        </aside>

        {/* ─── Center Canvas ──────────────────────────────────────── */}
        {state.viewMode === 'page' ? renderPageView() : renderCardEditor()}

        {/* ─── Right Inspector ────────────────────────────────────── */}
        <aside className="panel inspector">
          <div className="panel-section">
            <h2>属性</h2>
            {selectedElement && selectedCard ? (
              <div className="property-stack">
                <div className="inspector-tabs">
                  <button
                    type="button"
                    className={['tab-btn', activeTab === 'text' ? 'active' : ''].join(' ')}
                    onClick={() => setActiveTab('text')}
                  >内容</button>
                  <button
                    type="button"
                    className={['tab-btn', activeTab === 'style' ? 'active' : ''].join(' ')}
                    onClick={() => setActiveTab('style')}
                  >外观</button>
                  <button
                    type="button"
                    className={['tab-btn', activeTab === 'pos' ? 'active' : ''].join(' ')}
                    onClick={() => setActiveTab('pos')}
                  >尺寸位置</button>
                </div>

                {activeTab === 'text' && (
                  <div className="tab-pane">
                    <label>内容<textarea value={selectedElement.text} rows={4} onChange={(e) => updateElement(selectedCard.id, selectedElement.id, { text: e.target.value })} /></label>
                    <div className="size-grid">
                      <label>字号<input type="number" value={selectedElement.fontSize} step="0.1" onChange={(e) => updateElement(selectedCard.id, selectedElement.id, { fontSize: Number(e.target.value) })} /></label>
                      <label>字重
                        <select value={selectedElement.fontWeight} onChange={(e) => updateElement(selectedCard.id, selectedElement.id, { fontWeight: Number(e.target.value) })}>
                          <option value={400}>常规</option>
                          <option value={500}>中等</option>
                          <option value={700}>粗体</option>
                          <option value={900}>特粗</option>
                        </select>
                      </label>
                    </div>
                    <label style={{ marginTop: '10px' }}>对齐
                      <select value={selectedElement.align} onChange={(e) => updateElement(selectedCard.id, selectedElement.id, { align: e.target.value as TagElement['align'] })}>
                        <option value="left">左对齐</option>
                        <option value="center">居中</option>
                        <option value="right">右对齐</option>
                      </select>
                    </label>
                    {selectedElement.kind === 'iconSpec' ? (
                      <>
                        <label style={{ marginTop: '10px' }}>卖点图标
                          <select value={selectedElement.iconKey ?? 'phone'} onChange={(e) => updateElement(selectedCard.id, selectedElement.id, { iconKey: e.target.value as FeatureIconKey })}>
                            {featureIconOptions.map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}
                          </select>
                        </label>
                        <div className="property-group" style={{ marginTop: '15px', borderTop: '1px solid #f1f5f9', paddingTop: '15px' }}>
                          <span style={{ fontSize: '12px', fontWeight: 700, color: '#475569', display: 'block', marginBottom: '8px' }}>图标色彩控制</span>
                          <div className="color-row">
                            <label>图标底色<input type="color" value={selectedElement.iconBackground ?? '#b96c6b'} onChange={(e) => updateElement(selectedCard.id, selectedElement.id, { iconBackground: e.target.value })} /></label>
                            <label>图标线色<input type="color" value={selectedElement.iconColor ?? '#ffffff'} onChange={(e) => updateElement(selectedCard.id, selectedElement.id, { iconColor: e.target.value })} /></label>
                          </div>
                        </div>
                      </>
                    ) : null}
                  </div>
                )}

                {activeTab === 'style' && (
                  <div className="tab-pane">
                    <div className="color-row">
                      <label>文字颜色<input type="color" value={selectedElement.color} onChange={(e) => updateElement(selectedCard.id, selectedElement.id, { color: e.target.value })} /></label>
                      <label>背景颜色<input type="color" value={selectedElement.background === 'transparent' ? '#ffffff' : selectedElement.background} onChange={(e) => updateElement(selectedCard.id, selectedElement.id, { background: e.target.value })} /></label>
                    </div>
                    <div style={{ marginTop: '12px' }}>
                      <label style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                        <span>透明背景</span>
                        <input
                          type="checkbox"
                          style={{ width: 'auto' }}
                          checked={selectedElement.background === 'transparent'}
                          onChange={(e) => updateElement(selectedCard.id, selectedElement.id, { background: e.target.checked ? 'transparent' : '#ffffff' })}
                        />
                      </label>
                    </div>
                    {selectedElement.kind === 'iconSpec' && (
                      <div className="property-group" style={{ marginTop: '15px', borderTop: '1px solid #f1f5f9', paddingTop: '15px' }}>
                        <span style={{ fontSize: '12px', fontWeight: 700, color: '#475569', display: 'block', marginBottom: '8px' }}>图标色彩控制</span>
                        <div className="color-row">
                          <label>图标底色<input type="color" value={selectedElement.iconBackground ?? '#b96c6b'} onChange={(e) => updateElement(selectedCard.id, selectedElement.id, { iconBackground: e.target.value })} /></label>
                          <label>图标线色<input type="color" value={selectedElement.iconColor ?? '#ffffff'} onChange={(e) => updateElement(selectedCard.id, selectedElement.id, { iconColor: e.target.value })} /></label>
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {activeTab === 'pos' && (
                  <div className="tab-pane">
                    <div className="size-grid">
                      <label>X (mm)<input type="number" value={selectedElement.x} onChange={(e) => updateElement(selectedCard.id, selectedElement.id, { x: Number(e.target.value) })} /></label>
                      <label>Y (mm)<input type="number" value={selectedElement.y} onChange={(e) => updateElement(selectedCard.id, selectedElement.id, { y: Number(e.target.value) })} /></label>
                      <label>宽 (mm)<input type="number" value={selectedElement.width} onChange={(e) => updateElement(selectedCard.id, selectedElement.id, { width: Number(e.target.value) })} /></label>
                      <label>高 (mm)<input type="number" value={selectedElement.height} step="0.5" onChange={(e) => updateElement(selectedCard.id, selectedElement.id, { height: Number(e.target.value) })} /></label>
                    </div>
                    <div style={{ marginTop: '15px', borderTop: '1px solid #f1f5f9', paddingTop: '15px' }}>
                      <label style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                        <span>对齐到 {gridSize}mm 网格</span>
                        <input
                          type="checkbox"
                          style={{ width: 'auto' }}
                          checked={snapToGrid}
                          onChange={(e) => setSnapToGrid(e.target.checked)}
                        />
                      </label>
                      <div className="action-row" style={{ marginTop: '10px' }}>
                        <button type="button" className={['wide-action', gridSize === 2 ? 'primary-inline' : ''].join(' ')} onClick={() => setGridSize(2)}>2mm 精细</button>
                        <button type="button" className={['wide-action', gridSize === 5 ? 'primary-inline' : ''].join(' ')} onClick={() => setGridSize(5)}>5mm 快速</button>
                      </div>
                      <p style={{ fontSize: '11px', color: '#94a3b8', margin: '6px 0 0 0', lineHeight: 1.4 }}>开启后，拖拽或调整尺寸会自动按当前网格对齐；2mm 适合精修，5mm 适合快速排版。</p>
                    </div>
                  </div>
                )}

                <div className="action-row" style={{ marginTop: '20px', borderTop: '1px solid #e2e8f0', paddingTop: '15px' }}>
                  <button type="button" onClick={duplicateSelectedElement}><Copy size={16} />复制</button>
                  <button type="button" className="danger" onClick={deleteSelectedElement}><Trash2 size={16} />删除</button>
                </div>
              </div>
            ) : selectedCard ? (
              <div className="property-stack">
                <div className="card-name-row">
                  <label>卡片名称
                    <input value={selectedCard.name} onChange={(e) => updateCard(selectedCard.id, { name: e.target.value, customName: true })} />
                  </label>
                </div>
                <div style={{ marginTop: '20px', borderTop: '1px solid #f1f5f9', paddingTop: '15px' }}>
                  <label style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span style={{ fontSize: '13px', fontWeight: 700, color: '#334155' }}>{gridSize}mm 网格磁吸对齐</span>
                    <input
                      type="checkbox"
                      style={{ width: 'auto' }}
                      checked={snapToGrid}
                      onChange={(e) => setSnapToGrid(e.target.checked)}
                    />
                  </label>
                  <div className="action-row" style={{ marginTop: '10px' }}>
                    <button type="button" className={['wide-action', gridSize === 2 ? 'primary-inline' : ''].join(' ')} onClick={() => setGridSize(2)}>2mm 精细</button>
                    <button type="button" className={['wide-action', gridSize === 5 ? 'primary-inline' : ''].join(' ')} onClick={() => setGridSize(5)}>5mm 快速</button>
                  </div>
                  <p style={{ fontSize: '11px', color: '#94a3b8', margin: '6px 0 0 0', lineHeight: 1.4 }}>专为门店员工精细化微调排版设计。2mm 适合细调，5mm 适合快速对齐。</p>
                </div>
                <p className="empty-state" style={{ marginTop: '25px' }}>选择画布上的元素后可编辑内容和尺寸。</p>
              </div>
            ) : (
              <p className="empty-state">选择一个卡片开始编辑。</p>
            )}
          </div>
        </aside>
      </section>

      {/* Fill-to Picker Modal */}
      {fillPickerOpen && selectedCard ? (
        <div className="modal-overlay" onClick={() => setFillPickerOpen(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>填充到 — 选择目标卡片</h3>
            <p className="modal-hint">将「{selectedCard.name}」的内容复制到：</p>
            <div className="modal-card-list">
              {state.cards.filter((c) => c.id !== selectedCard.id).map((card) => (
                <button
                  key={card.id}
                  type="button"
                  className="modal-card-item"
                  onClick={() => {
                    setFillPickerOpen(false)
                    setConfirmDialog({
                      message: `该操作会覆盖「${card.name || '空白价签'}」的原有内容，且无法恢复，是否确认？`,
                      onConfirm: () => { fillToCard(card.id); setConfirmDialog(null) },
                    })
                  }}
                >
                  <span className="modal-card-name">{card.name || '空白价签'}</span>
                  <span className="modal-card-info">{card.width}x{card.height} · {card.elements.length}个元素</span>
                </button>
              ))}
            </div>
            <button type="button" className="modal-cancel" onClick={() => setFillPickerOpen(false)}>取消</button>
          </div>
        </div>
      ) : null}

      {/* Confirm Dialog */}
      {confirmDialog ? (
        <div className="modal-overlay" onClick={() => setConfirmDialog(null)}>
          <div className="modal modal-confirm" onClick={(e) => e.stopPropagation()}>
            <p>{confirmDialog.message}</p>
            <div className="modal-actions">
              <button type="button" className="modal-cancel" onClick={() => setConfirmDialog(null)}>取消</button>
              <button type="button" className="modal-danger" onClick={confirmDialog.onConfirm}>确认覆盖</button>
            </div>
          </div>
        </div>
      ) : null}
    </main>
  )
}

export default App
