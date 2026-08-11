import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createTemplateElementsFromAiLines,
  normalizeAiTemplateLines,
} from '../src/templateAiAnalyzer.ts'
import {
  buildFastApiRequest,
  normalizeFastApiLines,
  onRequestPost,
} from '../functions/api/template-analysis.js'

const aiLines = [
  { text: 'iPhone 17 Pro', confidence: 98, x: 0.08, y: 0.05, width: 0.54, height: 0.07 },
  { text: 'A19 Pro 芯片', confidence: 94, x: 0.08, y: 0.2, width: 0.34, height: 0.05 },
  { text: '256GB', confidence: 96, x: 0.08, y: 0.52, width: 0.18, height: 0.05 },
  { text: '¥ 8999', confidence: 99, x: 0.58, y: 0.52, width: 0.28, height: 0.07 },
]

test('AI normalized coordinates become bounded, non-overlapping template elements', () => {
  const elements = createTemplateElementsFromAiLines(aiLines, 75, 121)
  assert.equal(elements.length, aiLines.length)
  for (const element of elements) {
    assert.ok(element.x >= 0)
    assert.ok(element.y >= 0)
    assert.ok(element.x + element.width <= 75.01)
    assert.ok(element.y + element.height <= 121.01)
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

test('invalid or low-confidence AI lines are discarded and edge boxes are clamped', () => {
  const lines = normalizeAiTemplateLines([
    ...aiLines,
    { text: '低置信度', confidence: 10, x: 0.1, y: 0.1, width: 0.2, height: 0.05 },
    { text: '越界文字', confidence: 90, x: 0.92, y: 0.94, width: 0.5, height: 0.4 },
    { text: '', confidence: 90, x: 0.1, y: 0.1, width: 0.2, height: 0.05 },
  ])
  assert.equal(lines.length, aiLines.length + 1)
  const edge = lines.at(-1)
  assert.ok(edge)
  assert.ok(Math.abs(edge.width - 0.08) < 0.000001)
  assert.ok(Math.abs(edge.height - 0.06) < 0.000001)
})

test('FastAPI request uses structured image output without embedding credentials', () => {
  const dataUrl = 'data:image/jpeg;base64,ZmFrZQ=='
  const request = buildFastApiRequest(dataUrl, 'gpt-5.6-terra')
  assert.equal(request.model, 'gpt-5.6-terra')
  assert.equal(request.reasoning_effort, 'low')
  assert.equal('temperature' in request, false)
  assert.equal(request.response_format.type, 'json_schema')
  assert.equal(request.messages[1].content[1].image_url.url, dataUrl)
  assert.equal(JSON.stringify(request).includes('Authorization'), false)
})

test('FastAPI structured response is sanitized before returning to the browser', () => {
  const payload = {
    choices: [{ message: { content: JSON.stringify({ lines: aiLines }) } }],
  }
  const lines = normalizeFastApiLines(payload)
  assert.deepEqual(lines, aiLines)
})

test('AI proxy fails safely when the server secret is missing', async () => {
  const request = new Request('https://tag.1go.im/api/template-analysis', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: 'https://tag.1go.im',
    },
    body: JSON.stringify({ imageDataUrl: 'data:image/jpeg;base64,ZmFrZQ==' }),
  })
  const response = await onRequestPost({ request, env: {} })
  const payload = await response.json()
  assert.equal(response.status, 503)
  assert.equal(payload.ok, false)
  assert.match(payload.message, /服务端密钥/)
})

test('AI proxy forwards through the server and returns normalized lines', async () => {
  const request = new Request('https://tag.1go.im/api/template-analysis', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: 'https://tag.1go.im',
    },
    body: JSON.stringify({ imageDataUrl: 'data:image/jpeg;base64,ZmFrZQ==' }),
  })
  let upstreamUrl = ''
  let upstreamAuthorization = ''
  let upstreamModel = ''
  const response = await onRequestPost({
    request,
    env: { FASTAPI_API_KEY: 'test-only-key' },
    fetch: async (url, options) => {
      upstreamUrl = String(url)
      upstreamAuthorization = options.headers.Authorization
      upstreamModel = JSON.parse(options.body).model
      return new Response(JSON.stringify({
        model: 'gpt-5.6-terra',
        choices: [{ message: { content: JSON.stringify({ lines: aiLines }) } }],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    },
  })
  const payload = await response.json()
  assert.equal(response.status, 200)
  assert.equal(payload.ok, true)
  assert.deepEqual(payload.lines, aiLines)
  assert.equal(upstreamUrl, 'https://api.fastapi.ai/v1/chat/completions')
  assert.equal(upstreamAuthorization, 'Bearer test-only-key')
  assert.equal(upstreamModel, 'gpt-5.6-terra')
})

test('AI proxy retries supported vision models and ignores image-generation models', async () => {
  const request = new Request('https://tag.1go.im/api/template-analysis', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: 'https://tag.1go.im',
    },
    body: JSON.stringify({ imageDataUrl: 'data:image/jpeg;base64,ZmFrZQ==' }),
  })
  const attemptedModels: string[] = []
  const response = await onRequestPost({
    request,
    env: {
      FASTAPI_API_KEY: 'test-only-key',
      FASTAPI_VISION_MODEL: 'gpt-4o',
      FASTAPI_VISION_FALLBACKS: 'gpt-image-2,gpt-5.5',
    },
    fetch: async (_url, options) => {
      const body = JSON.parse(options.body)
      attemptedModels.push(body.model)
      if (body.model !== 'gpt-5.5') {
        return new Response(JSON.stringify({
          error: { message: 'The model does not exist or you do not have access to it.' },
        }), { status: 404, headers: { 'Content-Type': 'application/json' } })
      }
      return new Response(JSON.stringify({
        model: 'gpt-5.5',
        choices: [{ message: { content: JSON.stringify({ lines: aiLines }) } }],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    },
  })
  const payload = await response.json()
  assert.equal(response.status, 200)
  assert.equal(payload.ok, true)
  assert.equal(payload.model, 'gpt-5.5')
  assert.deepEqual(attemptedModels, ['gpt-4o', 'gpt-5.6-terra', 'gpt-5.5'])
})
