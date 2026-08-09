import assert from 'node:assert/strict'
import test from 'node:test'
import {
  constrainElementToBounds,
  createTemplateElementsFromLines,
  fitElementFontSize,
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
