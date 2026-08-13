import assert from 'node:assert/strict'
import test from 'node:test'
import {
  constrainElementToBounds,
  createTemplateElementsFromLines,
  fitElementFontSize,
  harmonizeTemplateLayout,
  inferIconKey,
  type TemplateFontRole,
  type TemplateOcrLine,
  type TemplateTagElement,
} from '../src/templateImageAnalyzer.ts'

const lines: TemplateOcrLine[] = [
  { text: 'iPhone 17 Pro', confidence: 97, bbox: { x0: 80, y0: 55, x1: 620, y1: 135 } },
  { text: 'A19 Pro 芯片', confidence: 92, bbox: { x0: 80, y0: 220, x1: 390, y1: 275 } },
  { text: '256GB', confidence: 95, bbox: { x0: 80, y0: 520, x1: 260, y1: 575 } },
  { text: '¥ 8999', confidence: 98, bbox: { x0: 520, y0: 520, x1: 820, y1: 590 } },
]

test('OCR lines become bounded, non-overlapping editable elements', () => {
  const elements = createTemplateElementsFromLines(lines, 900, 1200, 75, 121)
  assert.equal(elements.length, lines.length)
  for (const element of elements) {
    assert.ok(element.x >= 0)
    assert.ok(element.y >= 0)
    assert.ok(element.x + element.width <= 75.01)
    assert.ok(element.y + element.height <= 121.01)
    assert.ok(element.fontSize <= fitElementFontSize(element) + 0.01)
  }
  for (let left = 0; left < elements.length; left += 1) {
    for (let right = left + 1; right < elements.length; right += 1) {
      const a = elements[left]
      const b = elements[right]
      const overlaps = a.x < b.x + b.width && a.x + a.width > b.x
        && a.y < b.y + b.height && a.y + a.height > b.y
      assert.equal(overlaps, false)
    }
  }
})

test('feature text gets a similar editable icon without changing ordinary text', () => {
  assert.equal(inferIconKey('长续航电池 5000mAh'), 'battery')
  assert.equal(inferIconKey('A19 Pro 芯片'), 'chip')
  assert.equal(inferIconKey('4800万像素相机'), 'camera')
  assert.equal(inferIconKey('普通产品标题'), undefined)

  const elements = createTemplateElementsFromLines([
    { text: '支持 67W 快充', confidence: 95, bbox: { x0: 80, y0: 200, x1: 480, y1: 260 } },
  ], 900, 1200, 75, 121)
  assert.equal(elements[0]?.kind, 'iconSpec')
  assert.equal(elements[0]?.iconKey, 'charge')
  assert.equal(elements[0]?.iconColor, '#ffffff')
})

test('font fitting keeps long text complete inside a small box', () => {
  const element: TemplateTagElement = {
    id: 'long-text',
    kind: 'text',
    text: '这是一段需要完整显示且不能被遮挡的苹果产品说明文字',
    x: 0,
    y: 0,
    width: 30,
    height: 8,
    fontSize: 5,
    fontWeight: 500,
    color: '#111827',
    background: 'transparent',
    align: 'left',
    radius: 0,
    singleLine: true,
  }
  assert.ok(fitElementFontSize(element) < element.fontSize)
})

test('same visual row elements are aligned to a shared centerline', () => {
  const rowLines: TemplateOcrLine[] = [
    { text: '256GB', confidence: 95, bbox: { x0: 80, y0: 520, x1: 260, y1: 575 } },
    // y 与上一行略有偏差，模拟识别 bbox 抖动
    { text: '¥ 8999', confidence: 98, bbox: { x0: 520, y0: 528, x1: 820, y1: 585 } },
  ]
  const elements = createTemplateElementsFromLines(rowLines, 900, 1200, 75, 121)
  assert.equal(elements.length, 2)
  const [a, b] = elements
  assert.ok(Math.abs((a.y + a.height / 2) - (b.y + b.height / 2)) < 0.5)
})

test('similar font sizes are clustered into one tier', () => {
  const clusterLines: TemplateOcrLine[] = [
    { text: '参数一', confidence: 95, bbox: { x0: 80, y0: 300, x1: 300, y1: 350 } },
    { text: '参数二', confidence: 95, bbox: { x0: 80, y0: 420, x1: 300, y1: 473 } },
    { text: '参数三', confidence: 95, bbox: { x0: 80, y0: 540, x1: 300, y1: 588 } },
  ]
  const elements = createTemplateElementsFromLines(clusterLines, 900, 1200, 75, 121)
  const sizes = new Set(elements.map((element) => element.fontSize))
  assert.equal(sizes.size, 1)
  // 左边缘也应该对齐成列
  const xs = new Set(elements.map((element) => element.x))
  assert.equal(xs.size, 1)
})

test('font roles unify sizes within semantic tiers', () => {
  const makeElement = (id: string, fontSize: number, y: number): TemplateTagElement => ({
    id,
    kind: 'text',
    text: '标题',
    x: 10,
    y,
    width: 30,
    height: 10,
    fontSize,
    fontWeight: 500,
    color: '#111827',
    background: 'transparent',
    align: 'left',
    radius: 0,
    singleLine: true,
  })
  const elements = [makeElement('t1', 5, 10), makeElement('t2', 6.2, 40), makeElement('s1', 3, 80)]
  const roles = new Map<string, TemplateFontRole | undefined>([
    ['t1', 'title'],
    ['t2', 'title'],
    ['s1', 'small'],
  ])
  const result = harmonizeTemplateLayout(elements, roles, 75, 121)
  const t1 = result.find((element) => element.id === 't1')
  const t2 = result.find((element) => element.id === 't2')
  const s1 = result.find((element) => element.id === 's1')
  assert.ok(t1 && t2 && s1)
  // 同档位字号统一，small 档不超过其上限
  assert.equal(t1.fontSize, t2.fontSize)
  assert.ok(s1.fontSize <= 75 * 0.035 + 0.01)
  assert.ok(t1.fontSize > s1.fontSize)
})

test('overlapping elements in the same row are shifted horizontally, not stacked', () => {
  const overlapLines: TemplateOcrLine[] = [
    { text: '左侧文字', confidence: 95, bbox: { x0: 80, y0: 300, x1: 400, y1: 355 } },
    { text: '右侧文字', confidence: 95, bbox: { x0: 380, y0: 302, x1: 700, y1: 357 } },
  ]
  const elements = createTemplateElementsFromLines(overlapLines, 900, 1200, 75, 121)
  const [a, b] = [...elements].sort((left, right) => left.x - right.x)
  // 仍处于同一行（未被推到下一行），且水平方向已经分离
  assert.ok(Math.abs((a.y + a.height / 2) - (b.y + b.height / 2)) < 0.6)
  assert.ok(b.x >= a.x + a.width)
})

test('bounds constraint prevents clipping after a card resize', () => {
  const element: TemplateTagElement = {
    id: 'outside',
    kind: 'price',
    text: '¥ 8999',
    x: 90,
    y: 140,
    width: 35,
    height: 12,
    fontSize: 9,
    fontWeight: 800,
    color: '#111827',
    background: 'transparent',
    align: 'right',
    radius: 0,
    singleLine: true,
  }
  const bounded = constrainElementToBounds(element, 75, 121)
  assert.ok(bounded.x + bounded.width <= 75)
  assert.ok(bounded.y + bounded.height <= 121)
  assert.ok(bounded.fontSize <= element.fontSize)
})
