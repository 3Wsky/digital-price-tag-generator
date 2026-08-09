import 'dotenv/config'
import http from 'node:http'
import https from 'node:https'
import { createServer as createViteServer } from 'vite'
import { existsSync as fileExistsSync } from 'node:fs'
import { onRequestPost as handleAiTemplateFunction } from './functions/api/template-analysis.js'

const port = Number(process.env.PORT ?? 5173)
const host = process.env.HOST ?? '127.0.0.1'
const zhihuSearchUrl = 'https://developer.zhihu.com/api/v1/content/global_search'

// CLI batch modes skip HTTP/Vite. `--discover-models` refreshes data/models.txt;
// `--build-data` scrapes that list into public/data/products.json.
const CLI_MODE = process.argv.includes('--build-data') || process.argv.includes('--discover-models') || process.argv.includes('--build-dji-data')

// Resolve the Chrome executable Playwright should use. On the dev box we use
// the system Chrome; in CI / Linux we fall back to whatever `npx playwright
// install chromium` provides (undefined => Playwright's bundled chromium).
const LOCAL_WIN_CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const CHROME_EXECUTABLE_PATH = process.env.CHROME_PATH
  || (fileExistsSync(LOCAL_WIN_CHROME) ? LOCAL_WIN_CHROME : undefined)

const vite = CLI_MODE ? null : await createViteServer({
  server: { middlewareMode: true },
  appType: 'spa',
})

function sendJson(res, statusCode, body) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http
    mod.get(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' } }, res => {
      let body = ''
      res.on('data', d => body += d)
      res.on('end', () => { try { resolve(JSON.parse(body)) } catch { reject(new Error('Invalid JSON')) } })
    }).on('error', reject)
  })
}

async function handleAiTemplateAnalysis(req, res) {
  try {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const headers = new Headers()
    for (const [name, value] of Object.entries(req.headers)) {
      if (Array.isArray(value)) value.forEach((item) => headers.append(name, item))
      else if (value !== undefined) headers.set(name, value)
    }
    const request = new Request(`http://${req.headers.host || `${host}:${port}`}/api/template-analysis`, {
      method: 'POST',
      headers,
      body: Buffer.concat(chunks),
    })
    const response = await handleAiTemplateFunction({ request, env: process.env })
    res.writeHead(response.status, Object.fromEntries(response.headers.entries()))
    res.end(Buffer.from(await response.arrayBuffer()))
  } catch {
    sendJson(res, 500, { ok: false, message: '本地 AI 代理处理失败。' })
  }
}

// ─── Zhihu Search ────────────────────────────────────────────────────

async function handleZhihuSearch(req, res) {
  const accessSecret = process.env.ZHIHU_ACCESS_SECRET
  if (!accessSecret) {
    sendJson(res, 200, {
      ok: false,
      source: 'fallback',
      message: 'ZHIHU_ACCESS_SECRET is not configured.',
      items: [],
    })
    return
  }

  const url = new URL(req.url ?? '/', `http://${req.headers.host}`)
  const query = url.searchParams.get('query')?.trim()
  if (!query) {
    sendJson(res, 400, { ok: false, message: 'Missing query.' })
    return
  }

  const upstream = new URL(zhihuSearchUrl)
  upstream.searchParams.set('Query', query)
  upstream.searchParams.set('Count', url.searchParams.get('count') ?? '10')
  const filter = url.searchParams.get('filter')
  if (filter) {
    upstream.searchParams.set('Filter', filter)
  }

  try {
    const response = await fetch(upstream, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessSecret}`,
        'X-Request-Timestamp': `${Math.floor(Date.now() / 1000)}`,
        'Content-Type': 'application/json',
      },
    })
    const payload = await response.json()
    sendJson(res, response.ok ? 200 : response.status, {
      ok: response.ok && payload.Code === 0,
      source: 'zhihu',
      message: payload.Message ?? '',
      items: payload.Data?.Items ?? [],
    })
  } catch (error) {
    sendJson(res, 502, {
      ok: false,
      source: 'zhihu',
      message: error instanceof Error ? error.message : 'Failed to request Zhihu.',
      items: [],
    })
  }
}

// ─── HTML Helpers ─────────────────────────────────────────────────────

function htmlToLines(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, '\n')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
}

function afterLabel(lines, label) {
  const index = lines.findIndex((line) => line === label)
  return index >= 0 ? lines[index + 1] ?? '' : ''
}

function betweenLabels(lines, startLabel, endLabel) {
  const start = lines.findIndex((line) => line === startLabel)
  const end = lines.findIndex((line, index) => index > start && line === endLabel)
  if (start < 0 || end < 0) return []
  return lines.slice(start + 1, end).filter((line) => !['¥', '×1'].includes(line))
}

const COMMON_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
}

// ─── VMall (Huawei) Scraper ──────────────────────────────────────────

function extractSkuPrices(html) {
  const skuMap = new Map()
  const pattern =
    /"name":"([^"]+)","normalPiaPeriod"[\s\S]{0,900}?"price":(\d+)[\s\S]{0,900}?"sbomAbbr":"([^"]+)"[\s\S]{0,160}?"sbomCode":"([^"]+)"/g
  for (const match of html.matchAll(pattern)) {
    const name = match[1]
    const price = Number(match[2])
    const sbomAbbr = match[3]
    const sbomCode = match[4]
    const version = sbomAbbr.match(/(\d{1,2}GB\+\d{3}GB|\d{1,2}GB\+1TB|\d{1,2}GB\+2TB)/)?.[1]
    const color = sbomAbbr
      .replace(name, '')
      .replace(version ?? '', '')
      .trim()
    if (!version || !price || price < 1000) continue
    const key = version
    if (!skuMap.has(key)) {
      skuMap.set(key, { version, price: `¥ ${price}`, sbomCode, colors: [] })
    }
    const item = skuMap.get(key)
    if (color && !item.colors.includes(color)) item.colors.push(color)
  }
  return Array.from(skuMap.values())
}

function extractCareServices(html) {
  const serviceMap = new Map()
  const pattern = /"price":(\d+)[\s\S]{0,450}?"sbomCode":"([^"]+)"[\s\S]{0,180}?"sbomName":"(HUAWEI Care\+（[^"]+）)"/g
  for (const match of html.matchAll(pattern)) {
    const price = Number(match[1])
    const sbomCode = match[2]
    const name = match[3]
    if (!price || !name) continue
    const key = `${name}-${sbomCode}`
    if (!serviceMap.has(key)) {
      serviceMap.set(key, { name, price: `¥ ${price}`, sbomCode })
    }
  }
  return Array.from(serviceMap.values())
}

async function handleVmallProduct(req, res) {
  const requestUrl = new URL(req.url ?? '/', `http://${req.headers.host}`)
  const target = requestUrl.searchParams.get('url')
  if (!target) {
    sendJson(res, 400, { ok: false, message: 'Missing url.' })
    return
  }

  const targetUrl = new URL(target)
  if (!['www.vmall.com', 'item.vmall.com'].includes(targetUrl.hostname)) {
    sendJson(res, 400, { ok: false, message: 'Only vmall.com product URLs are supported.' })
    return
  }

  try {
    const response = await fetch(targetUrl, { headers: COMMON_HEADERS })
    const html = await response.text()
    const lines = htmlToLines(html)
    const title =
      lines.find((line) => /HUAWEI|华为/.test(line) && /Mate|畅享|nova|Pura|Pocket|手机/.test(line)) ?? ''
    const priceIndex = lines.findIndex((line, index) => line === '¥' && /^\d{3,5}$/.test(lines[index + 1] ?? ''))
    const price = priceIndex >= 0 ? `¥ ${lines[priceIndex + 1]}` : ''
    const colors = betweenLabels(lines, '颜色', '版本')
    const versions = betweenLabels(lines, '版本', 'CPU型号')
    const cpuRaw = afterLabel(lines, 'CPU型号')
    const cpu = cpuRaw.match(/(麒麟\s?\d{4}|骁龙\s?\d\s?Gen\s?\d|天玑\s?\d{4}|A\d{2}\s?Pro?)/i)?.[1] ?? cpuRaw
    const skuPrices = extractSkuPrices(html)
    const careServices = extractCareServices(html)

    sendJson(res, 200, {
      ok: true,
      source: 'vmall',
      product: {
        title,
        subtitle: lines[lines.indexOf(title) + 1] ?? '',
        price,
        skuPrices,
        careServices,
        colors,
        versions,
        cpu,
        os: afterLabel(lines, '操作系统'),
        screenSize: afterLabel(lines, '屏幕尺寸'),
        battery: afterLabel(lines, '电池容量'),
        glass: afterLabel(lines, '玻璃材质'),
        screenType: afterLabel(lines, '屏幕类型'),
        rearCamera: afterLabel(lines, '后置摄像头'),
        frontCamera: afterLabel(lines, '前置摄像头'),
        charge: afterLabel(lines, '充电'),
        features: afterLabel(lines, '特色功能'),
      },
    })
  } catch (error) {
    sendJson(res, 502, {
      ok: false,
      source: 'vmall',
      message: error instanceof Error ? error.message : 'Failed to request VMall.',
    })
  }
}

// ─── Xiaomi Store Scraper ─────────────────────────────────────────────

async function handleXiaomiProduct(req, res) {
  const requestUrl = new URL(req.url ?? '/', `http://${req.headers.host}`)
  const target = requestUrl.searchParams.get('url')
  if (!target) {
    sendJson(res, 400, { ok: false, message: 'Missing url.' })
    return
  }

  const targetUrl = new URL(target)
  if (!['www.mi.com', 'm.mi.com', 'item.mi.com'].includes(targetUrl.hostname)) {
    sendJson(res, 400, { ok: false, message: 'Only mi.com product URLs are supported.' })
    return
  }

  try {
    const response = await fetch(targetUrl, { headers: COMMON_HEADERS })
    const html = await response.text()

    // Check for error/404 pages
    if (html.includes('页面不见了') || html.includes('err.www.mi.com') || html.length < 500) {
      sendJson(res, 200, {
        ok: false,
        source: 'mi',
        message: '小米商城商品页为客户端渲染，暂不支持直接读取。请使用知乎全网搜索生成。',
        product: null,
      })
      return
    }

    const lines = htmlToLines(html)
    const title = lines.find((l) => /小米|Xiaomi|Redmi|POCO/i.test(l) && /手机|Phone|Note|Pro|Ultra|标准版/i.test(l)) ?? ''
    const priceMatch = html.match(/"price"\s*:\s*"?(\d{3,5})"?/)?.[1] ?? ''
    const price = priceMatch ? `¥ ${priceMatch}` : ''

    const skuPrices = []
    const skuPattern = /"name"\s*:\s*"([^"]*(?:GB\+|TB)[^"]*)"[^}]*?"price"\s*:\s*"?(\d{3,5})"?/gi
    for (const m of html.matchAll(skuPattern)) {
      const version = m[1].replace(/\s+/g, '')
      const p = Number(m[2])
      if (p >= 1000) skuPrices.push({ version, price: `¥ ${p}`, sbomCode: '', colors: [] })
    }

    const colorPattern = /[一-龥]{1,4}(?:黑|白|金|银|青|蓝|紫|绿|红|粉|灰)/g
    const colorSet = new Set()
    for (const m of html.matchAll(colorPattern)) {
      const c = m[0]
      if (!/颜色|配色|版本|标准|参数/.test(c)) colorSet.add(c)
    }

    const hasData = title || price || skuPrices.length > 0
    sendJson(res, 200, {
      ok: hasData,
      source: 'mi',
      message: hasData ? '' : '小米商城商品页为客户端渲染，暂未提取到数据。请使用知乎全网搜索生成。',
      product: hasData ? {
        title: title || targetUrl.pathname,
        price,
        skuPrices,
        careServices: [],
        colors: Array.from(colorSet).slice(0, 6),
        versions: [],
        cpu: html.match(/(骁龙\s?\d\s?Gen\s?\d|天玑\s?\d{4}|Snapdragon\s?\w+)/i)?.[1] ?? '',
        screenSize: html.match(/(\d(?:\.\d)?\s?英寸)/)?.[1] ?? '',
        battery: html.match(/(\d{4,5}\s?mAh)/i)?.[1] ?? '',
        glass: '',
        screenType: '',
        rearCamera: html.match(/(\d{4,5}\s?万像素)/)?.[0] ?? '',
        charge: html.match(/(\d{2,3}W)/)?.[0] ?? '',
        features: '',
      } : null,
    })
  } catch (error) {
    sendJson(res, 200, {
      ok: false,
      source: 'mi',
      message: '小米商城商品页暂无法直接读取，请使用知乎全网搜索生成。',
      product: null,
    })
  }
}

// ─── Apple China Scraper ──────────────────────────────────────────────

async function handleAppleProduct(req, res) {
  const requestUrl = new URL(req.url ?? '/', `http://${req.headers.host}`)
  const model = requestUrl.searchParams.get('model')?.trim()
  if (!model) {
    sendJson(res, 400, { ok: false, message: 'Missing model (e.g. iPhone 16 Pro Max).' })
    return
  }

  try {
    // Apple China product pages: try the shop page
    const slug = model.toLowerCase().replace(/\s+/g, '-')
    const shopUrl = `https://www.apple.com.cn/shop/buy-iphone/${slug}`
    const response = await fetch(shopUrl, { headers: COMMON_HEADERS, redirect: 'follow' })
    const html = await response.text()

    // Extract prices from the page
    const prices = []
    const pricePattern = /RMB\s*(\d{1,2},\d{3})/g
    for (const m of html.matchAll(pricePattern)) {
      const p = Number(m[1].replace(',', ''))
      if (p >= 3000) prices.push(p)
    }

    // Try JSON-LD
    const jsonLdMatch = html.match(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/)
    let title = model
    let price = ''
    if (jsonLdMatch) {
      try {
        const ld = JSON.parse(jsonLdMatch[1])
        title = ld.name ?? model
        price = ld.offers?.price ? `¥ ${ld.offers.price}` : ''
      } catch {}
    }

    // Extract from inline data
    if (!price && prices.length) {
      price = `¥ ${Math.min(...prices)}`
    }

    // Storage variants from page
    const storagePattern = /(\d{2,4}\s?GB)/gi
    const storages = Array.from(new Set(Array.from(html.matchAll(storagePattern), (m) => m[1].replace(/\s/g, '')))).slice(0, 4)

    // Colors from Apple product pages
    const appleColors = html.match(/[一-龥]{2,4}(?:色|黑|白|金|蓝|绿|紫|粉|钛)/g) ?? []

    sendJson(res, 200, {
      ok: true,
      source: 'apple',
      product: {
        title,
        price,
        skuPrices: storages.map((s, i) => ({
          version: s,
          price: prices[i] ? `¥ ${prices[i]}` : '¥ --',
          sbomCode: '',
          colors: [],
        })),
        careServices: [{ name: 'AppleCare+ 服务计划', price: '¥ --', sbomCode: '' }],
        colors: Array.from(new Set(appleColors)).slice(0, 6),
        versions: storages,
        cpu: html.match(/(A\d{2}\s?Pro|A\d{2})/i)?.[1] ?? '',
        screenSize: html.match(/(\d(?:\.\d)?\s?英寸)/)?.[1] ?? '',
        battery: '',
        glass: html.match(/(钛金属|陶瓷面板|超瓷晶)/)?.[1] ?? '',
        screenType: html.match(/(Super Retina|OLED|ProMotion|XDR)/i)?.[1] ?? '',
        rearCamera: html.match(/(\d{4,5}\s?万像素)/)?.[0] ?? '',
        charge: html.match(/(\d{2,3}W)/)?.[0] ?? '',
        features: '',
      },
    })
  } catch (error) {
    sendJson(res, 200, {
      ok: false,
      source: 'apple',
      message: 'Apple 商品页暂无法直接读取，请使用知乎全网搜索生成。',
      product: null,
    })
  }
}

// ─── Generic URL Scraper ──────────────────────────────────────────────

async function handleGenericProduct(req, res) {
  const requestUrl = new URL(req.url ?? '/', `http://${req.headers.host}`)
  const target = requestUrl.searchParams.get('url')
  if (!target) {
    sendJson(res, 400, { ok: false, message: 'Missing url.' })
    return
  }

  try {
    const targetUrl = new URL(target)
    const response = await fetch(targetUrl, { headers: COMMON_HEADERS })
    const html = await response.text()
    const lines = htmlToLines(html)

    // Try to detect brand
    const brand = /huawei|华为/i.test(html) ? 'huawei'
      : /xiaomi|小米|redmi/i.test(html) ? 'xiaomi'
      : /apple|苹果|iphone/i.test(html) ? 'apple'
      : /vivo/i.test(html) ? 'vivo'
      : /oppo/i.test(html) ? 'oppo'
      : /honor|荣耀/i.test(html) ? 'honor'
      : /samsung|三星/i.test(html) ? 'samsung'
      : /dji|大疆/i.test(html) ? 'dji'
      : 'unknown'

    // Generic title extraction
    const title = lines.find((l) => /[一-龥]{2,}/.test(l) && l.length < 50 && /手机|Phone|Pro|Ultra|Max|标准/i.test(l))
      ?? html.match(/<title>([^<]+)<\/title>/)?.[1]
      ?? ''

    // Generic price extraction
    const priceMatch = html.match(/(?:¥|￥|RMB)\s*(\d{3,5})/)?.[1]
      ?? html.match(/"price"\s*:\s*"?(\d{3,5})"?/)?.[1]
      ?? ''
    const price = priceMatch ? `¥ ${priceMatch}` : ''

    // Generic SKU extraction
    const skuPrices = []
    const skuPattern = /(\d{1,2}\s?GB?\s?\+\s?\d{3,4}\s?GB?)/gi
    for (const m of html.matchAll(skuPattern)) {
      const version = m[1].replace(/\s/g, '')
      const nearText = html.slice(m.index, Math.min(html.length, m.index + 200))
      const p = nearText.match(/(\d{4,5})\s?(?:元|¥)/)?.[1]
      if (p) skuPrices.push({ version, price: `¥ ${p}`, sbomCode: '', colors: [] })
    }

    // Generic color extraction
    const colorPattern = /[一-龥]{1,4}(?:黑|白|金|银|青|蓝|紫|绿|红|粉|灰|棕|黄|橙)/g
    const colorSet = new Set()
    for (const m of html.matchAll(colorPattern)) {
      const c = m[0]
      if (!/颜色|配色|版本|参数|标准/.test(c)) colorSet.add(c)
    }

    sendJson(res, 200, {
      ok: true,
      source: 'generic',
      brand,
      product: {
        title: title.trim(),
        price,
        skuPrices: skuPrices.slice(0, 4),
        careServices: [],
        colors: Array.from(colorSet).slice(0, 6),
        versions: [],
        cpu: html.match(/(骁龙|天玑|麒麟|Snapdragon|Dimensity|Kirin|A\d{2})[\s\S]{0,20}/i)?.[1] ?? '',
        screenSize: html.match(/(\d(?:\.\d)?\s?英寸)/)?.[1] ?? '',
        battery: html.match(/(\d{4,5}\s?mAh)/i)?.[1] ?? '',
        glass: '',
        screenType: html.match(/(OLED|AMOLED|LTPO|LCD)/i)?.[1] ?? '',
        rearCamera: html.match(/(\d{4,5}\s?万像素)/)?.[0] ?? '',
        charge: html.match(/(\d{2,3}W)/)?.[0] ?? '',
        features: '',
      },
    })
  } catch (error) {
    sendJson(res, 200, {
      ok: false,
      source: 'generic',
      message: '网页暂无法直接读取，请使用知乎全网搜索生成。',
      product: null,
    })
  }
}

// ─── Official Store Scraper (Playwright-based) ─────────────────────────

import { chromium } from 'playwright'

const vmallCache = new Map()

async function handleAppleSearch(req, res, model) {
  if (vmallCache.has(`apple_${model}`)) {
    sendJson(res, 200, vmallCache.get(`apple_${model}`))
    return
  }

  let browser
  try {
    browser = await chromium.launch({
      executablePath: CHROME_EXECUTABLE_PATH,
      headless: true,
      args: ['--no-sandbox', '--disable-gpu'],
    })
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })

    // Convert model to Apple URL slug: "iPhone 17 Pro" → "iphone_17_pro"
    const slug = model.replace(/iphone|苹果|apple/gi, '').trim().replace(/\s+/g, '_').replace(/pro_max/i, 'pro_max').toLowerCase()
    const buyUrl = `https://www.apple.com.cn/cn/shop/goto/buy_iphone/iphone_${slug}`

    await page.goto(buyUrl, { waitUntil: 'domcontentloaded', timeout: 25000 })
    await page.waitForTimeout(8000)

    const pageText = await page.evaluate(() => document.body.innerText)

    // Check if page loaded correctly
    if (!pageText.includes('iPhone') || pageText.includes('页面未找到')) {
      // Try alternate URL format
      const altUrl = `https://www.apple.com.cn/iphone-${slug}/`
      await page.goto(altUrl, { waitUntil: 'domcontentloaded', timeout: 20000 })
      await page.waitForTimeout(5000)
    }

    const text = await page.evaluate(() => document.body.innerText)

    // Extract title
    const titleMatch = text.match(/(iPhone\s*(?:\d+\s*(?:Pro\s*Max|Pro|Air|e)?))/i)
    const title = titleMatch ? titleMatch[1].replace(/\s+/g, ' ').trim() : model

    // Extract price - Apple format: "RMB X,XXX 起" or "RMB XXXX 起"
    const priceMatch = text.match(/RMB\s?([\d,]+)\s*起/)
    const price = priceMatch ? `¥ ${priceMatch[1].replace(/,/g, '')}` : ''

    // Extract colors
    const colorSection = text.match(/颜色[：:]\s*([\s\S]{0,200})/)?.[1] || ''
    const appleColors = ['银色', '星宇橙色', '深蓝色', '白色', '黑色', '蓝色', '绿色', '粉色', '黄色',
      '紫色', '午夜色', '星光色', '红色', '原色钛金属', '沙漠钛金属', '白色钛金属', '黑色钛金属',
      '自然钛金属', '蓝色钛金属', '绿色钛金属', '粉色钛金属', '暗影色', '香草色', '天蓝色']
    const colorSet = new Set()
    for (const c of appleColors) {
      if (text.includes(c)) colorSet.add(c)
    }
    // Also parse from color section
    const colorFromSection = colorSection.split(/[\s\n]+/).map(c => c.trim()).filter(c => c.length >= 2 && c.length <= 6 && /[一-龥]/.test(c))
    for (const c of colorFromSection) colorSet.add(c)

    // Extract SKU prices - Apple format has storage and price on separate lines
    const skuPrices = []
    const lines = text.split('\n')
    for (let i = 0; i < lines.length; i++) {
      const storageMatch = lines[i].match(/^(\d+\s*(?:GB|TB))$/)
      if (storageMatch) {
        // Look for price in nearby lines
        for (let j = i + 1; j < Math.min(i + 5, lines.length); j++) {
          const priceMatch = lines[j].match(/RMB\s?([\d,]+)\s*起/)
          if (priceMatch) {
            skuPrices.push({ version: storageMatch[1].replace(/\s/g, ''), price: `¥ ${priceMatch[1].replace(/,/g, '')}` })
            break
          }
        }
      }
    }

    // Extract specs
    const specs = {
      chip: text.match(/(A\d+\s*(?:Pro)?\s*芯片)/)?.[1] || '',
      battery: '',
      screen: text.match(/(\d\.\d)\s*英寸显示屏/)?.[1] + '英寸' || '',
      charge: '',
      refreshRate: text.match(/ProMotion|(\d{2,4}Hz)/i)?.[0] || '',
      screenTech: text.match(/(超视网膜\s*XDR|OLED|LTPO)/)?.[1] || '',
    }

    // Extract AppleCare+ price
    const careServices = []
    const careMatch = text.match(/AppleCare\+[^R]*RMB\s?([\d,]+)/)
    if (careMatch) {
      careServices.push({ name: 'AppleCare+', price: `¥ ${careMatch[1].replace(/,/g, '')}` })
    }

    const result = {
      ok: true,
      source: 'official',
      product: {
        title,
        price,
        skuPrices,
        careServices,
        colors: Array.from(colorSet),
        specs,
      },
    }

    vmallCache.set(`apple_${model}`, result)
    sendJson(res, 200, result)
  } catch (error) {
    sendJson(res, 200, {
      ok: false,
      source: 'official',
      message: error instanceof Error ? error.message : '苹果官网数据获取失败。',
      product: null,
    })
  } finally {
    if (browser) await browser.close().catch(() => {})
  }
}

async function handleHonorSearch(req, res, model) {
  if (vmallCache.has(`honor_${model}`)) {
    sendJson(res, 200, vmallCache.get(`honor_${model}`))
    return
  }

  let browser
  try {
    browser = await chromium.launch({
      executablePath: CHROME_EXECUTABLE_PATH,
      headless: true,
      args: ['--no-sandbox', '--disable-gpu'],
    })
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })

    const modelClean = model.replace(/荣耀|honor/gi, '').trim().toLowerCase()
    const modelNorm = modelClean.replace(/\s+/g, '')

    const modifierAlt = '(?:pro|plus|max|air|ultra|rsr|gt|mini|焕新版|青春版|活力版|标准版)'
    const tokenRe = new RegExp(`荣耀\\s*([a-z0-9]+(?:\\s*${modifierAlt})*)`, 'i')
    const extractToken = (text) => {
      const m = text.replace(/^new\s+/i, '').match(tokenRe)
      return m ? m[1].toLowerCase().replace(/\s+/g, '') : ''
    }
    const findMatch = (links) => {
      const annotated = links
        .map((l) => ({ ...l, normModel: extractToken(l.text) }))
        .filter((l) => l.normModel)
      return (
        annotated.find((l) => l.normModel === modelNorm) ||
        annotated.find((l) => {
          const slug = l.href.match(/honor-([\w-]+)\//)?.[1]?.replace(/-/g, '') || ''
          return slug === modelNorm
        }) ||
        null
      )
    }

    const collectShopLinks = async (url) => {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 })
      await page.waitForTimeout(4000)
      await page.evaluate(async () => {
        for (let i = 0; i < 8; i++) {
          window.scrollBy(0, document.body.scrollHeight / 8)
          await new Promise((r) => setTimeout(r, 350))
        }
      })
      await page.waitForTimeout(1500)
      return page.evaluate(() => {
        return Array.from(document.querySelectorAll('a[href*="/cn/shop/product/"]')).map((a) => ({
          href: a.href,
          text: (a.textContent || '').replace(/\s+/g, ' ').trim(),
        })).filter((l) => l.text.length >= 3 && !l.text.includes('荣耀亲选'))
      })
    }

    let match = null
    const homeLinks = await collectShopLinks('https://www.honor.com/cn/shop/')
    match = findMatch(homeLinks)

    if (!match) {
      const searchLinks = await collectShopLinks(`https://www.honor.com/cn/shop/v/search?keyword=${encodeURIComponent(model)}`)
      match = findMatch(searchLinks)
    }

    if (!match && /power/i.test(modelClean)) {
      const shopLinks = await collectShopLinks('https://www.honor.com/cn/shop/v/search?categoryId=908')
      match = findMatch(shopLinks)
    }

    if (!match) {
      await page.goto('https://www.honor.com/cn/phones/', { waitUntil: 'domcontentloaded', timeout: 20000 })
      await page.waitForTimeout(5000)
      const links = await page.evaluate(() => {
        return Array.from(document.querySelectorAll('a[href*="/phones/"]')).map((a) => ({
          href: a.href,
          text: (a.textContent || '').trim(),
        })).filter((l) =>
          l.href.includes('honor-magic') || l.href.includes('honor-play') || l.href.includes('honor-x')
        )
      })
      match = findMatch(links)
    }

    if (!match) {
      const result = { ok: false, source: 'official', message: '荣耀官网未找到该产品。', product: null }
      vmallCache.set(`honor_${model}`, result)
      sendJson(res, 200, result)
      return
    }

    // Step 2: Visit product page
    await page.goto(match.href, { waitUntil: 'domcontentloaded', timeout: 25000 })
    await page.waitForTimeout(8000)

    const pageText = await page.evaluate(() => document.body.innerText)
    const pageLines = pageText.split('\n').map(line => line.trim()).filter(Boolean)

    let title = await page.evaluate(() => document.title.split('-')[0].trim())
    if (!title || /荣耀商城|官方商城/.test(title)) title = match.text.split('|')[0].trim()
    title = title.replace(/预估到手价.*$/, '').trim()

    // Extract price - Honor format: "¥4999 ¥5999 起" or "¥4999 起"
    const formatHonorPrice = (value) => {
      const n = Number(String(value || '').replace(/[^\d.]/g, ''))
      if (!Number.isFinite(n) || n <= 0) return ''
      return `¥ ${Number.isInteger(n) ? n : n.toFixed(2).replace(/\.?0+$/, '')}`
    }
    const priceIndex = pageLines.findIndex(line => /价\s*格|价格/.test(line))
    const priceWindow = priceIndex >= 0 ? pageLines.slice(priceIndex, priceIndex + 4).join(' ') : pageText.slice(0, 1200)
    const displayPrices = [...priceWindow.matchAll(/[¥￥]\s*([\d.]+)/g)].map(m => m[1])
    let price = displayPrices.length > 1 ? formatHonorPrice(displayPrices[1]) : formatHonorPrice(displayPrices[0])

    // Extract colors - look for known Honor colors or color patterns
    const honorKnownColors = ['流光金', '冰霜蓝', '星空黑', '晨曦金', '月影灰', '天际蓝', '雪域白', '绒黑色',
      '朝霞金', '丝路敦煌', '祁连雪', '苔原绿', '曙光金', '暖白色', '旭日金砂', '天青色', '天青釉', '旭日金',
      '普罗旺斯紫', '玛瑙灰', '冰莓粉', '天穹紫', '墨岩黑', '香槟粉', '山茶白', '鸢尾黑',
      '晨曦紫', '月影白', '钛空灰', '织梦蓝', '旭日金砂', '天青色']
    const colorSet = new Set()
    for (const c of honorKnownColors) {
      if (pageText.includes(c)) colorSet.add(c)
    }

    // Also look for colors in SKU selector DOM
    const domColors = await page.evaluate(() => {
      const els = document.querySelectorAll('[class*="color"] a, [class*="sku"] span, [data-color]')
      return Array.from(els).map(el => el.textContent?.trim()).filter(c => c && c.length >= 2 && c.length <= 6 && /[一-龥]/.test(c))
    })
    const notColors = ['全部', '对比', '了解更多', '购买', '到货通知', '规格参数', '概述', '玩机技巧', '服务支持']
    for (const c of domColors) {
      if (!notColors.includes(c)) colorSet.add(c)
    }
    const colorStart = pageLines.findIndex(line => line.includes('选择颜色'))
    const colorEnd = pageLines.findIndex((line, index) => index > colorStart && line.includes('选择版本'))
    if (colorStart >= 0 && colorEnd > colorStart) {
      colorSet.clear()
      for (const c of pageLines.slice(colorStart + 1, colorEnd)) {
        if (/^[一-龥A-Za-z0-9\s]{2,8}$/.test(c) && !notColors.includes(c)) colorSet.add(c)
      }
    }

    // Extract specs
    const chipMatch = pageText.match(/(第[一二三四五]代骁龙\s?\d+\s?(?:至尊版)?|骁龙\s?[^\s,，。]{1,20}\s?(?:至尊版|Gen\s?\d|移动平台)|天玑\s?\d{4}|麒麟\s?\d{4})/)?.[1]?.replace(/\s+/g, ' ').trim()
    const batteryAll = [...pageText.matchAll(/(\d{4,5})\s*(?:mAh|毫安)/gi)]
    const batteryVal = batteryAll.map(m => Number(m[1])).filter(n => n >= 3000).sort((a, b) => b - a)?.[0]
    // Screen: match "X.XX 英寸" but NOT when preceded by "/" (camera sensor size like 1/1.4 英寸)
    // Normalize non-breaking spaces
    const normalizedText = pageText.replace(/[   ]/g, ' ')
    const screenMatch = normalizedText.match(/(?<!\/)([4-7]\.\d{1,2})\s*英寸/)?.[1]
    const chargeAll = [...pageText.matchAll(/(\d{2,3})W/g)]
    const chargeCandidates = chargeAll
      .map(m => ({
        value: Number(m[1]),
        context: pageText.slice(Math.max(0, (m.index ?? 0) - 24), (m.index ?? 0) + 42),
      }))
      .filter(item => item.value >= 18 && item.value <= 200)
      .sort((a, b) => {
        const aReverse = /反向|反充/.test(a.context) ? 1 : 0
        const bReverse = /反向|反充/.test(b.context) ? 1 : 0
        return aReverse - bReverse || b.value - a.value
      })
    let chargeVal = chargeCandidates[0]?.value
    const vaMatch = pageText.match(/(\d{1,2})V\s*\/?\s*(\d(?:\.\d)?)A/) || pageText.match(/(\d{1,2})V(\d(?:\.\d)?)A/)
    if (!chargeVal && vaMatch) chargeVal = Math.round(Number(vaMatch[1]) * Number(vaMatch[2]))
    const refreshMatch = pageText.match(/(\d{2,4}Hz)/i)?.[1]

    const specs = {
      chip: chipMatch || '',
      battery: batteryVal ? batteryVal + 'mAh' : '',
      screen: screenMatch ? screenMatch + '英寸' : '',
      charge: chargeVal ? chargeVal + 'W' : '',
      refreshRate: refreshMatch || '',
      screenTech: pageText.match(/(OLED|AMOLED|LTPO|绿洲护眼屏)/)?.[1] || '',
    }

    const honorSkuPrices = await page.evaluate(() => {
      const decodeHtml = (value) => {
        const el = document.createElement('textarea')
        el.innerHTML = String(value || '')
        return el.value
      }
      const allSkus = window.ec?.product?.getAllSku?.() || {}
      const byVersion = new Map()
      for (const sku of Object.values(allSkus)) {
        const name = decodeHtml(sku?.name || '')
        const version = name.match(/(\d+GB\+\d+(?:GB|TB))/)?.[1]
        const rawPrice = sku?.originPrice || sku?.price || sku?.totalUnitPrice
        if (!version || !rawPrice || byVersion.has(version)) continue
        byVersion.set(version, { version, price: String(rawPrice) })
      }
      return Array.from(byVersion.values())
    }).catch(() => [])

    const versionStart = pageLines.findIndex(line => line.includes('选择版本'))
    const versionEnd = pageLines.findIndex((line, index) => index > versionStart && line.includes('选择套餐'))
    const versions = versionStart >= 0 && versionEnd > versionStart
      ? pageLines.slice(versionStart + 1, versionEnd).map(line => line.replace(/^5G全网通\s*/, '').trim()).filter(line => /\d+GB\+\d+GB/.test(line))
      : []
    const skuPrices = versions.map(version => {
      const skuPrice = honorSkuPrices.find(item => item.version === version)
      return { version, price: formatHonorPrice(skuPrice?.price) || price }
    })
    if (!skuPrices.length) {
      for (const item of honorSkuPrices) {
        const formatted = formatHonorPrice(item.price)
        if (formatted) skuPrices.push({ version: item.version, price: formatted })
      }
    }
    if (!skuPrices.length) {
      for (const m of pageText.matchAll(/(\d+GB\+\d+(?:GB|TB))\s*[¥￥]\s*(\d{4,5})/g)) {
        skuPrices.push({ version: m[1], price: formatHonorPrice(m[2]) })
      }
    }
    if (skuPrices[0]?.price) price = skuPrices[0].price

    const batteryTech = /青海湖电池/.test(pageText) ? '荣耀青海湖电池' : ''
    const cameraFeature = (() => {
      const collect = (segment) => {
        const items = []
        for (const m of segment.matchAll(/(\d+(?:\.\d+)?)\s*亿\s*像素([^\n。]{0,40})/g)) {
          items.push({ pixels: Number(m[1]) * 10000, label: `${m[1]}亿像素`, tail: m[2] })
        }
        for (const m of segment.matchAll(/(\d{4,5})\s*万像素([^\n。]{0,40})/g)) {
          items.push({ pixels: Number(m[1]), label: `${m[1]}万像素`, tail: m[2] })
        }
        return items
      }
      const segIdx = pageText.indexOf('后置摄像头')
      const frontIdx = pageText.indexOf('前置摄像头')
      const segment = segIdx >= 0 ? pageText.slice(segIdx, frontIdx > segIdx ? frontIdx : segIdx + 1000) : ''
      const candidates = collect(segment).length ? collect(segment) : collect(pageText)
      if (!candidates.length) return ''
      candidates.sort((a, b) => b.pixels - a.pixels)
      const best = candidates[0]
      let tail = best.tail.replace(/\(f\/[^)]*\)/, '').replace(/\s+/g, ' ').trim()
      tail = tail.split(/[+＋，,。；;]/)[0].trim().slice(0, 14)
      return `${best.label}${tail ? ' ' + tail : ''}`.trim()
    })()
    const featureTexts = [
      batteryVal ? `${batteryVal}mAh${batteryTech ? ' ' + batteryTech : ''}${chargeVal ? ` ${chargeVal}W荣耀超快充` : ''}` : '',
      chipMatch ? `${chipMatch} 芯片` : '',
      [screenMatch ? `${screenMatch}英寸` : '', specs.screenTech, specs.refreshRate].filter(Boolean).join(' '),
      cameraFeature,
    ].filter(Boolean)

    const result = {
      ok: true,
      source: 'official',
      product: {
        title: title.startsWith('荣耀') ? title : `荣耀${title}`,
        price,
        skuPrices,
        careServices: [],
        colors: Array.from(colorSet),
        specs,
        features: featureTexts,
      },
    }

    vmallCache.set(`honor_${model}`, result)
    sendJson(res, 200, result)
  } catch (error) {
    sendJson(res, 200, {
      ok: false,
      source: 'official',
      message: error instanceof Error ? error.message : '荣耀官网数据获取失败。',
      product: null,
    })
  } finally {
    if (browser) await browser.close().catch(() => {})
  }
}

// ─── VIVO Local Product Cache ───────────────────────────────────
// Local cache of product specs (rarely changes). Only prices are refreshed from API.
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
const vivoCacheFile = join(process.cwd(), 'vivo-products.json')
let vivoLocalCache = {}
if (existsSync(vivoCacheFile)) {
  try { vivoLocalCache = JSON.parse(readFileSync(vivoCacheFile, 'utf8')) } catch {}
  console.log(`Loaded ${Object.keys(vivoLocalCache).length} VIVO products from local cache`)
}

function saveVivoLocalCache() {
  if (process.argv.includes('--discover-models')) return
  try { writeFileSync(vivoCacheFile, JSON.stringify(vivoLocalCache, null, 2)) } catch {}
}

// Normalize model for cache lookup
function vivoCacheKey(model) {
  const clean = normModel(model)
  const cleanNoBrand = vivoModelToken(model)
  for (const key of Object.keys(vivoLocalCache)) {
    const keyClean = normModel(key)
    const keyNoBrand = vivoModelToken(key)
    if (keyClean === clean || keyNoBrand === cleanNoBrand) return key
  }
  return null
}

// Refresh only prices from Shop API for a cached product
// Uses cached spuId directly — no need to load all shop items
async function refreshVivoPrices(model, cached) {
  const spuId = cached.spuId
  if (!spuId) return cached

  try {
    const info = await fetchJson(`https://shop.vivo.com.cn/api/v1/product/getInfo?spuId=${spuId}`).catch(() => null)
    if (!info?.data) return cached

    const skuSpecList = info.data.specItem?.skuSpecList || []
    const result = { ...cached }

    // Fetch prices for one SKU per version (use first color variant)
    const seenVersions = new Set()
    const skuIdsToFetch = []
    const versionMap = {}
    if (info.data.specItem?.specItemSeq?.['0']) {
      const vers = info.data.specItem.specItemSeq['0']
      for (let i = 0; i < vers.length; i++) {
        const vName = typeof vers[i] === 'string' ? vers[i] : vers[i].name
        versionMap[String(i + 1)] = vName
      }
    }
    for (const spec of skuSpecList) {
      const verName = versionMap[spec.sequences?.['0']]
      if (verName && !seenVersions.has(verName)) {
        seenVersions.add(verName)
        skuIdsToFetch.push({ skuId: spec.skuId, version: verName })
      }
    }

    // Fetch each SKU detail (parallel, limited)
    const priceMap = {}
    const fetches = skuIdsToFetch.slice(0, 15).map(async ({ skuId, version }) => {
      const detail = await fetchJson(`https://shop.vivo.com.cn/api/v1/product/getDetail?spuId=${spuId}&typeId=1&skuId=${skuId}&needSurfRecord=false`).catch(() => null)
      const sku = detail?.data?.[String(skuId)]
      if (sku?.salePrice) priceMap[version] = `¥${sku.salePrice}`
    })
    await Promise.all(fetches)

    // Update main price from default SKU
    if (info.data.defaultSkuId) {
      const defVer = versionMap['1'] // first version
      if (defVer && priceMap[defVer]) result.price = priceMap[defVer]
    }

    // Update SKU prices
    if (result.skuPrices?.length) {
      result.skuPrices = result.skuPrices.map(s => ({
        ...s,
        price: priceMap[s.version] || s.price,
      }))
      if (result.skuPrices[0]?.price) result.price = result.skuPrices[0].price
    }

    result.priceRefreshedAt = new Date().toISOString()
    return result
  } catch {
    return cached
  }
}

// ─── VIVO Shop API helpers ──────────────────────────────────────
let vivoShopItems = null // all items from prodList
let vivoShopItemsPromise = null

async function loadVivoShopItems() {
  if (vivoShopItems) return vivoShopItems
  if (!vivoShopItemsPromise) {
    vivoShopItemsPromise = (async () => {
      const items = []
      for (let p = 1; p <= 20; p++) {
        const page = await fetchJson(`https://shop.vivo.com.cn/api/v1/prodList/phone?pageNum=${p}&pageSize=12`)
          .then(d => d?.data?.dataList || []).catch(() => [])
        if (!items.length && !page.length) break
        items.push(...page)
        if (page.length < 12) break
      }
      vivoShopItems = items
      return items
    })()
  }
  return vivoShopItemsPromise
}

// Normalize model name for matching: lowercase, strip spaces/dashes
function normModel(s) {
  return String(s || '').toLowerCase().replace(/[\s\-]+/g, '')
}

function vivoModelToken(s) {
  const clean = normModel(s).replace(/^(?:vivo|iqoo)/, '')
  return clean.match(/^(?:[a-z]*\d+[a-z]*|\d+[a-z]*)(?:promini|pro|max|ultra|plus|mini|se)?/)?.[0] || clean
}

// Find best SPU for a given model name from shop items
function findVivoSpu(items, modelClean) {
  const target = vivoModelToken(modelClean)
  // Collect all SPU groups: spuId -> { names: [], item }
  const spuGroups = {}
  for (const item of items) {
    const name = item.skuName || ''
    // Match "vivo XXX ... NGB" or "iQOO XXX ... NGB"
    const m = name.match(/^(?:vivo|iQOO)\s+(.+?)(?:\s+\d+GB)/i)
    if (!m) continue
    const modelPart = vivoModelToken(m[1])
    const spuId = item.relaSpuId
    if (!spuGroups[spuId]) spuGroups[spuId] = { names: new Set(), item }
    spuGroups[spuId].names.add(modelPart)
    // Also add "iqoo" prefix variant for iQOO products
    if (/^iQOO/i.test(name)) {
      spuGroups[spuId].names.add('iqoo' + modelPart)
    }
  }

  // Score each SPU by how well it matches the target
  let best = null
  let bestScore = -1
  for (const [spuId, group] of Object.entries(spuGroups)) {
    for (const name of group.names) {
      let score = -1
      if (name === target) {
        score = 100 // exact match
      }
      if (score > bestScore) {
        bestScore = score
        best = { spuId: Number(spuId), matchedName: name }
      }
    }
  }
  // Require exact match
  return bestScore >= 100 ? best : null
}

// Filter versions: exclude variants not matching the searched model
// e.g., searching "S50" should exclude "S50t 16GB+512GB"
function filterVivoVersions(versions, modelClean) {
  const target = vivoModelToken(modelClean)
  return versions.filter(v => {
    const vNorm = normModel(v)
    // If version name starts with a different model prefix, exclude it
    // e.g., "S50t 16GB+512GB" when target is "S50"
    const versionModelMatch = vNorm.match(/^([a-z]\d+\w*)/)
    if (versionModelMatch) {
      const verModel = vivoModelToken(versionModelMatch[1])
      if (verModel !== target && !target.startsWith(verModel)) {
        // This version belongs to a different model variant
        // Only exclude if it's clearly a different product (S50t vs S50)
        if (verModel.length > target.length && verModel.startsWith(target)) {
          return false // "s50t" starts with "s50" but is longer → different product
        }
        if (target.length > verModel.length && target.startsWith(verModel)) {
          return true // target "s50t" starts with version "s50" → keep
        }
        if (verModel !== target) return false
      }
    }
    return true
  })
}

function splitVivoFeatureText(value) {
  return String(value || '')
    .split(/[|｜/、\n\r]+/)
    .map(v => v.replace(/\s+/g, ' ').trim())
    .filter(v => v.length >= 2 && v.length <= 32)
    .slice(0, 4)
}

async function fetchVivoShopData(modelClean) {
  const items = await loadVivoShopItems()
  const match = findVivoSpu(items, modelClean)
  if (!match) return null
  return fetchVivoShopDataBySpuId(modelClean, match.spuId)
}

async function fetchVivoShopDataBySpuId(modelClean, spuId) {
  const info = await fetchJson(`https://shop.vivo.com.cn/api/v1/product/getInfo?spuId=${spuId}`).catch(() => null)
  if (!info?.data) return null

  const result = { spuName: info.data.commoditySpu?.spuName || '', spuId, features: [] }

  // Versions and colors from getInfo
  if (info.data.specItem?.specItemSeq) {
    const seq = info.data.specItem.specItemSeq
    if (seq['0']) {
      const allVersions = seq['0'].map(v => typeof v === 'string' ? v : v.name).filter(Boolean)
      result.versions = filterVivoVersions(allVersions, modelClean)
    }
    if (seq['1']) {
      result.shopColors = seq['1'].map(v => typeof v === 'string' ? v : v.name).filter(Boolean)
    }
  }

  // Fetch ALL SKU prices from skuSpecList
  const skuPrices = []
  const skuSpecList = info.data.specItem?.skuSpecList || []
  const versionMap = {} // seq index (1-based) -> version name
  if (info.data.specItem?.specItemSeq?.['0']) {
    const vers = info.data.specItem.specItemSeq['0']
    for (let i = 0; i < vers.length; i++) {
      const vName = typeof vers[i] === 'string' ? vers[i] : vers[i].name
      versionMap[String(i + 1)] = vName
    }
  }

  // Collect unique skuIds for versions we want
  const wantedVersions = new Set(result.versions || [])
  const skuIdsToFetch = new Set()
  for (const spec of skuSpecList) {
    const verSeq = spec.sequences?.['0']
    const verName = versionMap[verSeq]
    if (verName && wantedVersions.has(verName)) {
      skuIdsToFetch.add(spec.skuId)
    }
  }

  // Also add default SKU
  if (info.data.defaultSkuId) skuIdsToFetch.add(info.data.defaultSkuId)

  // Fetch details for each unique SKU (limit to avoid too many requests)
  const skuDetails = {}
  const fetchPromises = Array.from(skuIdsToFetch).slice(0, 25).map(async skuId => {
    const detail = await fetchJson(`https://shop.vivo.com.cn/api/v1/product/getDetail?spuId=${spuId}&typeId=1&skuId=${skuId}&needSurfRecord=false`).catch(() => null)
    if (detail?.data?.[String(skuId)]) {
      skuDetails[skuId] = detail.data[String(skuId)]
    }
  })
  await Promise.all(fetchPromises)

  // Build skuPrices from fetched details, grouped by version
  const versionPrices = {} // version -> price (use first found)
  for (const [skuId, sku] of Object.entries(skuDetails)) {
    const verName = sku.skuName?.match(/\d+GB\+\d+(?:GB|TB)/)?.[0] || ''
    if (verName && !versionPrices[verName] && sku.salePrice) {
      versionPrices[verName] = sku.salePrice
    }
    // Get brief/features from any SKU
    if (!result.features.length && sku.brief) {
      result.features = splitVivoFeatureText(sku.brief)
    }
    // Get price from default SKU
    if (Number(skuId) === info.data.defaultSkuId && sku.salePrice) {
      result.price = `¥${sku.salePrice}`
    }
  }

  // Build final skuPrices array
  for (const ver of (result.versions || [])) {
    const verNorm = normModel(ver)
    let price = ''
    for (const [vKey, vPrice] of Object.entries(versionPrices)) {
      if (normModel(vKey) === verNorm || verNorm.includes(normModel(vKey)) || normModel(vKey).includes(verNorm)) {
        price = `¥${vPrice}`
        break
      }
    }
    skuPrices.push({ version: ver, price })
  }
  if (skuPrices.length) result.skuPrices = skuPrices
  if (skuPrices[0]?.price) result.price = skuPrices[0].price

  return Object.keys(result).length > 1 ? result : null
}

// Verify a list of candidate SPU IDs and return the first whose spuName token matches the requested model.
async function findVivoSpuByCandidates(spuIds, modelClean) {
  const target = vivoModelToken(modelClean)
  if (!target) return null
  for (const spuId of spuIds) {
    const info = await fetchJson(`https://shop.vivo.com.cn/api/v1/product/getInfo?spuId=${spuId}`).catch(() => null)
    const spuName = info?.data?.commoditySpu?.spuName || ''
    if (!spuName) continue
    if (vivoModelToken(spuName) === target) return spuId
  }
  return null
}

function vivoProductFromShopData(model, shopData) {
  const rawTitle = shopData.spuName || model
  const title = /^vivo\s+/i.test(rawTitle) ? rawTitle : `vivo ${rawTitle}`
  return {
    title,
    price: shopData.price || '',
    skuPrices: shopData.skuPrices || [],
    careServices: [],
    colors: shopData.shopColors || [],
    specs: shopData.specs || {},
    features: shopData.features || [],
  }
}

async function handleVivoSearch(req, res, model) {
  // Check in-memory cache
  if (vmallCache.has(`vivo_${model}`)) {
    sendJson(res, 200, vmallCache.get(`vivo_${model}`))
    return
  }

  // Check local file cache — use cached specs, only refresh prices
  const cacheKey = vivoCacheKey(model)
  if (cacheKey && vivoLocalCache[cacheKey]) {
    const cached = vivoLocalCache[cacheKey]
    const refreshed = await refreshVivoPrices(model, cached)
    const result = {
      ok: true,
      source: 'official',
      product: {
        title: refreshed.title,
        price: refreshed.price,
        skuPrices: refreshed.skuPrices || [],
        careServices: refreshed.careServices || [],
        colors: refreshed.colors || [],
        specs: refreshed.specs || {},
        features: refreshed.features || [],
      },
    }
    vmallCache.set(`vivo_${model}`, result)
    sendJson(res, 200, result)
    return
  }

  const modelCleanForShop = model.replace(/vivo|VIVO/gi, '').trim()
  const directShopData = await fetchVivoShopData(modelCleanForShop).catch(() => null)
  if (directShopData) {
    const result = {
      ok: true,
      source: 'official',
      product: vivoProductFromShopData(model, directShopData),
    }
    vmallCache.set(`vivo_${model}`, result)
    vivoLocalCache[result.product.title] = {
      title: result.product.title,
      price: result.product.price,
      skuPrices: result.product.skuPrices,
      careServices: result.product.careServices,
      colors: result.product.colors,
      specs: result.product.specs,
      features: result.product.features,
      savedAt: new Date().toISOString(),
      spuId: directShopData.spuId,
    }
    saveVivoLocalCache()
    sendJson(res, 200, result)
    return
  }

  let browser
  try {
    browser = await chromium.launch({
      executablePath: CHROME_EXECUTABLE_PATH,
      headless: true,
      args: ['--no-sandbox', '--disable-gpu'],
    })
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })

    const modelToken = vivoModelToken(model)

    // Step 1: Find the product link.
    // First try vivo.com.cn search (cheap, covers older models like Y60).
    // Then fall back to scanning series pages.
    let productUrl = null
    let productName = ''

    try {
      await page.goto(`https://www.vivo.com.cn/search?keyword=${encodeURIComponent(modelCleanForShop)}`, { waitUntil: 'domcontentloaded', timeout: 15000 })
      await page.waitForTimeout(3000)
      const searchLinks = await page.evaluate(() => {
        return Array.from(document.querySelectorAll('a[href*="/vivo/"]')).map(a => ({
          href: a.href,
          text: (a.textContent || '').trim(),
        })).filter(l => l.text && l.text.length <= 30)
      })
      const hit = searchLinks.find(l => vivoModelToken(l.text) === modelToken)
      if (hit) {
        productUrl = hit.href
        productName = hit.text
      }
    } catch {}

    if (!productUrl) {
      // VIVO products are listed on products-x.html, products-s.html etc.
      const seriesPages = [
        'https://www.vivo.com.cn/products-x.html',
        'https://www.vivo.com.cn/products-s.html',
        'https://www.vivo.com.cn/products-y.html',
        'https://www.vivo.com.cn/products-iqoo.html',
      ]

      for (const seriesUrl of seriesPages) {
        await page.goto(seriesUrl, { waitUntil: 'domcontentloaded', timeout: 20000 })
        await page.waitForTimeout(4000)

        const links = await page.evaluate(() => {
          return Array.from(document.querySelectorAll('a')).map(a => ({
            href: a.href,
            text: (a.textContent || '').trim(),
          })).filter(l =>
            l.href.includes('/vivo/') &&
            l.text.length >= 3 &&
            l.text.length <= 30 &&
            !/系列|对比|全部|了解更多|立即|购买|详情/.test(l.text)
          )
        })

        const match = links.find(l => vivoModelToken(l.text) === modelToken)

        if (match) {
          productUrl = match.href
          productName = match.text
          break
        }
      }
    }

    if (!productUrl) {
      const result = { ok: false, source: 'official', message: 'vivo 官网未找到该产品。', product: null }
      vmallCache.set(`vivo_${model}`, result)
      sendJson(res, 200, result)
      return
    }

    // Step 2: Visit product page and extract details
    await page.goto(productUrl, { waitUntil: 'domcontentloaded', timeout: 25000 })
    await page.waitForTimeout(8000)

    const pageText = await page.evaluate(() => document.body.innerText)
    const html = await page.content()

    // Step 2.5: Probe shop SPU candidates referenced on the product page.
    // Older models (e.g. Y60) are not in prodList/phone but still have a Shop SPU
    // page accessible via getInfo. If we can match one, prefer the Shop API data
    // (which has authoritative price/SKU/colors).
    const spuCandidates = [...new Set([...html.matchAll(/shop\.vivo\.com\.cn\/product\/(\d{6,8})/g)].map(m => Number(m[1])))]
    if (spuCandidates.length) {
      const matchedSpuId = await findVivoSpuByCandidates(spuCandidates, modelCleanForShop).catch(() => null)
      if (matchedSpuId) {
        const shopFromCandidate = await fetchVivoShopDataBySpuId(modelCleanForShop, matchedSpuId).catch(() => null)
        if (shopFromCandidate) {
          const result = {
            ok: true,
            source: 'official',
            product: vivoProductFromShopData(model, shopFromCandidate),
          }
          vmallCache.set(`vivo_${model}`, result)
          vivoLocalCache[result.product.title] = {
            title: result.product.title,
            price: result.product.price,
            skuPrices: result.product.skuPrices,
            careServices: result.product.careServices,
            colors: result.product.colors,
            specs: result.product.specs,
            features: result.product.features,
            savedAt: new Date().toISOString(),
            spuId: shopFromCandidate.spuId,
          }
          saveVivoLocalCache()
          sendJson(res, 200, result)
          return
        }
      }
    }

    // Extract title
    let title = productName || await page.evaluate(() => {
      return document.title.split('-')[0].trim()
    })

    // Extract colors - look for color names in product page text
    // VIVO typically lists colors near the bottom of the page as standalone words
    const colorSet = new Set()

    // Method 1: Find color names from page text patterns
    const colorPatterns = pageText.match(/[\n\r]\s*([一-鿿]{2,4}(?:\s*[一-鿿]{2,4})?)\s*[\n\r]/gm) || []
    const vivoKnownColors = ['银调', '黑Ka', '红圈', '告白', '灵感紫', '悠悠蓝', '深空黑', '钛色',
      '月影灰', '天际蓝', '雪域白', '绒黑色', '星迹黑', '落日橙', '冰蓝', '至黑', '华彩',
      '原黑', '浅金', '白月光', '星云蓝', '晴波蓝', '花似锦', '华夏红', '辰夜黑']

    for (const c of vivoKnownColors) {
      if (pageText.includes(c)) colorSet.add(c)
    }

    // Method 2: Look for colors in URL/slug or specific DOM elements
    const notColors = ['当前机型', '全部', '对比', '了解更多', '立即购买', '购买', '详情', '预约', '缺货', '新品']
    const colorEls = await page.evaluate(() => {
      const els = document.querySelectorAll('[class*="color"], [class*="sku-name"], [data-color]')
      return Array.from(els).map(el => el.textContent?.trim()).filter(c => c && c.length >= 2 && c.length <= 6 && /[一-龥]/.test(c))
    })
    for (const c of colorEls) {
      if (!notColors.includes(c)) colorSet.add(c)
    }

    // Extract specs
    const chipMatch = pageText.match(/(骁龙\s?[^\s,，。]{1,20}\s?(?:至尊版|Gen\s?\d|移动平台)|天玑\s?\d{4})/)?.[1]?.replace(/\s+/g, ' ').trim()
    // Only match battery if mAh is in same match, minimum 3000 (typical phone)
    const batteryAll = [...pageText.matchAll(/(\d{4,5})\s*mAh/gi)]
    const batteryMatch = batteryAll.map(m => Number(m[1])).filter(n => n >= 3000)?.[0]
    const screenMatch = pageText.match(/(\d\.\d+)\s*(?:英寸|″)/)?.[1]
    // Only accept realistic phone screen sizes (5.5" - 8.0")
    const screenVal = screenMatch && Number(screenMatch) >= 5.5 && Number(screenMatch) <= 8.0 ? screenMatch : ''
    const chargeAllVivo = [...pageText.matchAll(/(\d{2,3})W/g)]
    const chargeMatchVivo = chargeAllVivo.map(m => Number(m[1])).filter(n => n >= 18 && n <= 200)?.[0]
    // Refresh rate: prefer 60/90/120/144/165Hz, avoid touch sampling rates like 3200Hz
    const refreshCandidates = [...pageText.matchAll(/(\d{2,3})Hz/gi)]
      .map(m => Number(m[1]))
      .filter(n => [60, 90, 120, 144, 165, 240].includes(n))
    const refreshMatch = refreshCandidates[0] ? refreshCandidates[0] + 'Hz' : ''
    const screenTechMatch = pageText.match(/(OLED|AMOLED|LTPO|E\d)/)?.[1]

    const specs = {
      chip: chipMatch || '',
      battery: batteryMatch ? batteryMatch + 'mAh' : '',
      screen: screenVal ? screenVal + '英寸' : '',
      charge: chargeMatchVivo ? chargeMatchVivo + 'W' : '',
      refreshRate: refreshMatch || '',
      screenTech: screenTechMatch || '',
    }

    // Extract price from HTML if available
    const priceMatch = html.match(/"price"\s*:\s*(\d{4,6})/) || pageText.match(/[¥￥]\s?(\d{4,5})/)
    let price = priceMatch ? `¥ ${priceMatch[1]}` : ''

    // Extract SKU prices from HTML
    const skuMap = new Map()
    for (const m of html.matchAll(/"name"\s*:\s*"([^"]*?(\d+GB[+\dTB]*)[^"]*?)"[\s\S]{0,500}?"price"\s*:\s*(\d{4,6})/g)) {
      const version = m[2]
      const skuPrice = Number(m[3])
      if (!version || skuPrice < 1000) continue
      if (!skuMap.has(version)) {
        skuMap.set(version, { version, price: `¥ ${skuPrice}` })
      }
    }
    let skuPrices = Array.from(skuMap.values())

    // ── Enrich from VIVO Shop API (price, versions, colors, features) ──
    const modelClean2 = model.replace(/vivo|VIVO/gi, '').trim()
    const shopData = await fetchVivoShopData(modelClean2).catch(() => null)

    if (shopData) {
      // Title: prefer shop SPU name
      if (shopData.spuName) {
        const shopTitle = shopData.spuName.startsWith('vivo') ? shopData.spuName : `vivo ${shopData.spuName}`
        if (!title || title.length < shopTitle.length) title = shopTitle.replace(/^vivo\s+/i, '')
      }
      // Price from shop
      if (shopData.price) price = shopData.price
      // SKU prices with real prices from shop
      if (shopData.skuPrices?.length) {
        skuPrices = shopData.skuPrices
      }
      // Colors from shop
      if (shopData.shopColors?.length) {
        colorSet.clear() // shop colors are authoritative
        for (const c of shopData.shopColors) colorSet.add(c)
      }
      // Extract specs from shop brief (features)
      if (shopData.features?.length) {
        const brief = shopData.features.join('|')
        if (!specs.chip) {
          const chipFromBrief = brief.match(/(骁龙\s?[^\s|,，。]{1,25}\s?(?:至尊版|Gen\s?\d|移动平台)?|天玑\s?\d{4}|麒麟\s?\d{4})/)?.[1]?.replace(/\s+/g, ' ').trim()
          if (chipFromBrief) specs.chip = chipFromBrief
        }
        if (!specs.battery) {
          const battFromBrief = brief.match(/(\d{4,5})\s*mAh/)?.[1]
          if (battFromBrief && Number(battFromBrief) >= 3000) specs.battery = battFromBrief + 'mAh'
        }
        if (!specs.charge) {
          const chargeFromBrief = brief.match(/(\d{2,3})W/)?.[1]
          if (chargeFromBrief && Number(chargeFromBrief) >= 18) specs.charge = chargeFromBrief + 'W'
        }
        if (!specs.refreshRate) {
          const refreshFromBrief = brief.match(/(\d{2,3}Hz)/i)?.[1]
          if (refreshFromBrief) specs.refreshRate = refreshFromBrief
        }
        if (!specs.screenTech) {
          const techFromBrief = brief.match(/(OLED|AMOLED|LTPO|E\d|蓝海|护眼屏)/)?.[1]
          if (techFromBrief) specs.screenTech = techFromBrief
        }
      }
    }

    const result = {
      ok: true,
      source: 'official',
      product: {
        title: /^vivo\s+/i.test(title) ? title : `vivo ${title}`,
        price,
        skuPrices,
        careServices: [],
        colors: Array.from(colorSet),
        specs,
        features: shopData?.features || [],
      },
    }

    vmallCache.set(`vivo_${model}`, result)

    // Save to local file cache (specs rarely change, only prices need refresh)
    if (result.ok && result.product) {
      vivoLocalCache[model] = {
        title: result.product.title,
        price: result.product.price,
        skuPrices: result.product.skuPrices,
        careServices: result.product.careServices,
        colors: result.product.colors,
        specs: result.product.specs,
        features: result.product.features,
        savedAt: new Date().toISOString(),
      }
      saveVivoLocalCache()
    }

    sendJson(res, 200, result)
  } catch (error) {
    sendJson(res, 200, {
      ok: false,
      source: 'official',
      message: error instanceof Error ? error.message : 'vivo 官网数据获取失败。',
      product: null,
    })
  } finally {
    if (browser) await browser.close().catch(() => {})
  }
}

async function handleOfficialSearch(req, res) {
  const requestUrl = new URL(req.url ?? '/', `http://${req.headers.host}`)
  const model = requestUrl.searchParams.get('model')?.trim()
  if (!model) {
    sendJson(res, 400, { ok: false, message: 'Missing model.' })
    return
  }

  // Check cache
  if (vmallCache.has(model)) {
    sendJson(res, 200, vmallCache.get(model))
    return
  }

  const brand = /华为|huawei|mate|pura|nova/i.test(model) ? 'huawei'
    : /vivo|VIVO|iqoo/i.test(model) ? 'vivo'
    : /xiaomi|小米|redmi/i.test(model) ? 'xiaomi'
    : /apple|苹果|iphone/i.test(model) ? 'apple'
    : /荣耀|honor/i.test(model) ? 'honor'
    : /dji|大疆|mini\s*\d|air\s*\d|mavic|osmo|pocket/i.test(model) ? 'dji'
    : 'unknown'

  if (brand === 'vivo') {
    await handleVivoSearch(req, res, model)
    return
  }
  if (brand === 'honor') {
    await handleHonorSearch(req, res, model)
    return
  }
  if (brand === 'apple') {
    await handleAppleSearch(req, res, model)
    return
  }
  if (brand === 'dji') {
    await handleDjiSearch(req, res, model)
    return
  }
  if (brand !== 'huawei') {
    sendJson(res, 200, { ok: false, source: 'official', message: `${brand} 品牌暂未支持官网直采。`, product: null })
    return
  }

  let browser
  try {
    browser = await chromium.launch({
      executablePath: CHROME_EXECUTABLE_PATH,
      headless: true,
      args: ['--no-sandbox', '--disable-gpu'],
    })
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })

    // Intercept search API response
    let searchData = null
    page.on('response', async (resp) => {
      if (resp.url().includes('queryPrd')) {
        try { searchData = JSON.parse(await resp.text()) } catch {}
      }
    })

    // Visit vmall.com for cookies
    await page.goto('https://www.vmall.com', { waitUntil: 'domcontentloaded', timeout: 20000 })
    await page.waitForTimeout(2000)

    // Search
    await page.goto(`https://www.vmall.com/search?keyword=${encodeURIComponent(model)}`, { waitUntil: 'domcontentloaded', timeout: 20000 })
    await page.waitForTimeout(10000)

    if (!searchData || !searchData.resultList?.length) {
      const result = { ok: false, source: 'official', message: '华为商城未找到该产品。', product: null }
      vmallCache.set(model, result)
      sendJson(res, 200, result)
      return
    }

    // Find best matching product (exclude accessories and variants)
    const target = searchData.resultList.find(p => {
      const name = (p.name || '').toLowerCase()
      // Exclude accessories
      if (/壳|保护|贴膜|支架|充电器|数据线/.test(name)) return false
      // Exclude variants (风驰版, 典藏版, RS, 非凡大师)
      if (/风驰|典藏|rs|非凡大师/.test(name)) return false
      // Match by key tokens
      const modelLower = model.toLowerCase()
      const tokens = modelLower.replace(/华为|huawei/gi, '').trim().split(/\s+/)
      return tokens.every(t => name.includes(t.toLowerCase()))
    }) || searchData.resultList.find(p => {
      const name = (p.name || '')
      return !/壳|保护|贴膜|支架|风驰|典藏|RS|非凡大师/.test(name)
    })

    if (!target) {
      const result = { ok: false, source: 'official', message: '未找到匹配的产品。', product: null }
      vmallCache.set(model, result)
      sendJson(res, 200, result)
      return
    }

    // Navigate to product page
    const productId = target.productId
    await page.goto(`https://www.vmall.com/product/${productId}.html`, { waitUntil: 'domcontentloaded', timeout: 20000 })
    await page.waitForTimeout(8000)

    const html = await page.content()

    // Extract colors from page - look for color selector section
    const pageColors = await page.evaluate(() => {
      // Method 1: Look for color option elements
      const colorEls = document.querySelectorAll('[class*="color"] [class*="item"], [class*="sku"] [class*="color"] a, [data-color]')
      const colors1 = Array.from(colorEls).map(el => el.textContent?.trim() || el.getAttribute('data-color')).filter(c => c && /^[一-龥]{2,4}$/.test(c))

      // Method 2: Look for sbom data in script tags
      const scripts = document.querySelectorAll('script')
      const colors2 = []
      for (const s of scripts) {
        const text = s.textContent || ''
        const matches = text.matchAll(/"sbomAbbr":"[^"]*?(\d+GB[+\dTB]*)[^"]*?([一-龥]{2,4})"/g)
        for (const m of matches) {
          if (/^[一-龥]{2,4}$/.test(m[2])) colors2.push(m[2])
        }
      }

      // Method 3: Look for color names in visible text near product info
      const bodyText = document.body.innerText
      const colorSection = bodyText.match(/颜色[：:]\s*([^\n]{5,80})/)?.[1] || ''
      const colors3 = colorSection.split(/[、|｜\/\s]+/).map(c => c.trim()).filter(c => /^[一-龥]{2,4}$/.test(c))

      return { colors1, colors2, colors3, colorSection }
    })

    // Merge all color sources
    const colorSet = new Set()
    for (const c of (pageColors.colors1 || [])) colorSet.add(c)
    for (const c of (pageColors.colors2 || [])) colorSet.add(c)
    for (const c of (pageColors.colors3 || [])) colorSet.add(c)

    // Extract SKU prices (deduplicated by version)
    const skuMap = new Map()
    for (const m of html.matchAll(/"name":"([^"]+)","normalPiaPeriod"[\s\S]{0,900}?"price":(\d+)[\s\S]{0,900}?"sbomAbbr":"([^"]+)"[\s\S]{0,160}?"sbomCode":"([^"]+)"/g)) {
      const version = m[3].match(/(\d{1,2}GB\+\d{3}GB|\d{1,2}GB\+1TB|\d{1,2}GB\+2TB)/)?.[1]
      const price = Number(m[2])
      if (!version || price < 1000) continue
      if (!skuMap.has(version)) {
        skuMap.set(version, { version, price: `¥ ${price}`, sbomCode: m[4], colors: [] })
      }
      const color = m[3].replace(m[1], '').replace(version, '').trim()
      if (color && !skuMap.get(version).colors.includes(color)) {
        skuMap.get(version).colors.push(color)
      }
    }
    const skuPrices = Array.from(skuMap.values())

    // Extract Care services (deduplicated)
    const svcMap = new Map()
    for (const m of html.matchAll(/"price":(\d+)[\s\S]{0,450}?"sbomCode":"([^"]+)"[\s\S]{0,180}?"sbomName":"(HUAWEI Care\+（[^"]+）)"/g)) {
      const key = m[3]
      if (!svcMap.has(key)) {
        svcMap.set(key, { name: m[3], price: `¥ ${Number(m[1])}`, sbomCode: m[2] })
      }
    }
    const careServices = Array.from(svcMap.values())

    // Add SKU-extracted colors to the set
    for (const sku of skuPrices) {
      for (const c of sku.colors) colorSet.add(c)
    }

    // Extract specs from page text
    const pageText = await page.evaluate(() => document.body.innerText)
    const specs = {
      chip: pageText.match(/(麒麟\s?\d{4})/)?.[1]?.replace(/\s/g, '') || '',
      battery: pageText.match(/(\d{4,5})\s?mAh/i)?.[1] + 'mAh' || '',
      screen: pageText.match(/(\d\.\d)\s?英寸/)?.[1] + '英寸' || '',
      charge: pageText.match(/(\d{2,3}W)/)?.[0] || '',
      refreshRate: pageText.match(/(\d{2,4}Hz)/i)?.[1] || '',
      screenTech: pageText.match(/(OLED|LTPO|灵珑屏)/)?.[1] || '',
    }

    const result = {
      ok: true,
      source: 'official',
      product: {
        title: target.name,
        price: `¥ ${target.price}`,
        skuPrices,
        careServices,
        colors: Array.from(colorSet),
        specs,
      },
    }

    vmallCache.set(model, result)
    sendJson(res, 200, result)
  } catch (error) {
    sendJson(res, 200, {
      ok: false,
      source: 'official',
      message: error instanceof Error ? error.message : '官网数据获取失败。',
      product: null,
    })
  } finally {
    if (browser) await browser.close().catch(() => {})
  }
}

// ─── Server ───────────────────────────────────────────────────────────

const server = CLI_MODE ? null : http.createServer(async (req, res) => {
  if (req.url?.startsWith('/api/template-analysis')) {
    if (req.method !== 'POST') {
      sendJson(res, 405, { ok: false, message: '请使用 POST 请求。' })
      return
    }
    await handleAiTemplateAnalysis(req, res)
    return
  }
  if (req.url?.startsWith('/api/zhihu/global-search')) {
    await handleZhihuSearch(req, res)
    return
  }
  if (req.url?.startsWith('/api/official/search')) {
    await handleOfficialSearch(req, res)
    return
  }
  if (req.url?.startsWith('/api/vmall/product')) {
    await handleVmallProduct(req, res)
    return
  }
  if (req.url?.startsWith('/api/xiaomi/product')) {
    await handleXiaomiProduct(req, res)
    return
  }
  if (req.url?.startsWith('/api/apple/product')) {
    await handleAppleProduct(req, res)
    return
  }
  if (req.url?.startsWith('/api/product')) {
    await handleGenericProduct(req, res)
    return
  }

  vite.middlewares(req, res)
})

if (!CLI_MODE) {
  server.listen(port, host, () => {
    console.log(`Server running at http://${host}:${port}`)
  })
} else {
  if (process.argv.includes('--discover-models')) {
    await runCliDiscoverModels()
  } else if (process.argv.includes('--build-dji-data')) {
    await runCliBuildDjiData()
  } else {
    await runCliBuild()
  }
}

// ─── CLI Batch Build ──────────────────────────────────────────────────
//
// Reads a model list (default: data/models.txt — one model per line, blank /
// `#` lines ignored), runs handleOfficialSearch for each via a stub response,
// merges Zhihu results for Honor models, and writes a single JSON file the
// frontend can read directly. Failures are recorded so we can see them in CI
// logs without aborting the whole batch.
async function runCliDiscoverModels() {
  const fs = await import('node:fs')
  const path = await import('node:path')

  const argv = process.argv
  const modelsArgIdx = argv.indexOf('--models')
  const maxNewArgIdx = argv.indexOf('--max-new')
  const candidateLimitArgIdx = argv.indexOf('--candidate-limit')
  const modelsFile = modelsArgIdx >= 0 ? argv[modelsArgIdx + 1] : 'data/models.txt'
  const maxNew = maxNewArgIdx >= 0 ? Number(argv[maxNewArgIdx + 1]) : 12
  const candidateLimit = candidateLimitArgIdx >= 0 ? Number(argv[candidateLimitArgIdx + 1]) : 18
  const dryRun = argv.includes('--dry-run')
  const validate = !argv.includes('--skip-validate')

  const existingText = fs.existsSync(modelsFile) ? fs.readFileSync(modelsFile, 'utf8') : ''
  const existingModels = readModelLines(existingText)
  console.log(`[discover-models] ${existingModels.length} existing models from ${modelsFile}`)

  const discovered = await discoverOfficialModels()
  const existingKeys = new Set(existingModels.map(modelKey))
  const candidates = balanceDiscoveredCandidates(discovered
    .filter(model => !existingKeys.has(modelKey(model))))
  const maxNewCount = Number.isFinite(maxNew) && maxNew > 0 ? maxNew : candidates.length
  const candidateCount = Number.isFinite(candidateLimit) && candidateLimit > 0 ? candidateLimit : candidates.length
  const newModels = validate
    ? await validateDiscoveredModels(candidates.slice(0, candidateCount), maxNewCount)
    : candidates.slice(0, maxNewCount)

  console.log(`[discover-models] discovered ${discovered.length} models, ${candidates.length} candidates, ${newModels.length} new`)
  for (const model of newModels) console.log(`[discover-models] + ${model}`)

  if (!newModels.length || dryRun) {
    if (dryRun) console.log('[discover-models] dry run, models file not changed')
    process.exit(0)
  }

  const nextText = appendModelsToList(existingText, newModels)
  fs.mkdirSync(path.dirname(modelsFile), { recursive: true })
  fs.writeFileSync(modelsFile, nextText)
  console.log(`[discover-models] wrote ${modelsFile}`)
  process.exit(0)
}

function readModelLines(text) {
  return text
    .split(/\r?\n/)
    .map(s => s.trim())
    .filter(s => s && !s.startsWith('#'))
}

function balanceDiscoveredCandidates(candidates) {
  const groups = {
    huawei: [],
    honor: [],
    vivo: [],
    other: [],
  }
  for (const model of candidates) {
    groups[discoveredBrandKey(model)].push(model)
  }

  const result = []
  const keys = ['huawei', 'honor', 'vivo', 'other']
  while (keys.some(key => groups[key].length)) {
    for (const key of keys) {
      const next = groups[key].shift()
      if (next) result.push(next)
    }
  }
  return result
}

function discoveredBrandKey(model) {
  if (/^\u534e\u4e3a|^huawei|^mate|^pura|^nova|^\u7545\u4eab/i.test(model)) return 'huawei'
  if (/^\u8363\u8000|^honor/i.test(model)) return 'honor'
  if (/^vivo|^iqoo/i.test(model)) return 'vivo'
  return 'other'
}

async function validateDiscoveredModels(candidates, maxNew) {
  const accepted = []
  for (let i = 0; i < candidates.length && accepted.length < maxNew; i++) {
    const model = candidates[i]
    const t0 = Date.now()
    const data = await invokeOfficialSearch(model)
    if (data?.ok && data.product) {
      accepted.push(model)
      console.log(`[discover-models] verified ${model} (${Date.now() - t0}ms)`)
    } else {
      console.log(`[discover-models] skipped ${model}: ${data?.message || 'not supported'} (${Date.now() - t0}ms)`)
    }
  }
  return accepted
}

function appendModelsToList(text, models) {
  const prefix = text.endsWith('\n') ? text : `${text}\n`
  return `${prefix}\n# Auto-discovered by node server.mjs --discover-models.\n${models.join('\n')}\n`
}

function modelKey(model) {
  return model
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[\-_/()（）[\]【】]/g, '')
}

function hasPublishedPrice(product) {
  if (!product) return false
  const values = [
    product.price,
    ...(product.skuPrices || []).map(sku => sku?.price),
  ]
  return values.some(value => {
    const text = String(value || '')
    return /\d{3,6}/.test(text) && !/--|\u5f85\u516c\u5e03|\u6682\u65e0/.test(text)
  })
}

function markProductPriceStatus(data) {
  if (!data?.ok || !data.product) return data
  return {
    ...data,
    product: {
      ...data.product,
      priceStatus: hasPublishedPrice(data.product) ? 'available' : 'pending',
    },
  }
}

async function discoverOfficialModels() {
  const browser = await chromium.launch({
    executablePath: CHROME_EXECUTABLE_PATH,
    headless: true,
    args: ['--no-sandbox', '--disable-gpu'],
  })
  const sources = [
    { brand: 'huawei', url: 'https://consumer.huawei.com/cn/phones/' },
    { brand: 'honor', url: 'https://www.honor.com/cn/phones/' },
    { brand: 'vivo', url: 'https://www.vivo.com.cn/products-x.html' },
    { brand: 'vivo', url: 'https://www.vivo.com.cn/products-s.html' },
    { brand: 'vivo', url: 'https://www.vivo.com.cn/products-y.html' },
    { brand: 'vivo', url: 'https://www.vivo.com.cn/products-iqoo.html' },
  ]

  const all = []
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1200 } })
    for (const source of sources) {
      const t0 = Date.now()
      try {
        await page.goto(source.url, { waitUntil: 'domcontentloaded', timeout: 30000 })
        await page.waitForTimeout(2500)
        const text = await page.evaluate(() => {
          const attrs = Array.from(document.querySelectorAll('a, img, [title], [aria-label]'))
            .flatMap(el => [
              el.textContent,
              el.getAttribute('title'),
              el.getAttribute('alt'),
              el.getAttribute('aria-label'),
            ])
          return [document.body?.innerText || '', ...attrs].filter(Boolean).join('\n')
        })
        const models = extractModelsFromText(source.brand, text)
        console.log(`[discover-models] ${source.brand} ${models.length} models (${Date.now() - t0}ms)`)
        all.push(...models)
      } catch (err) {
        console.warn(`[discover-models] ${source.url} failed: ${err?.message || err}`)
      }
    }
  } finally {
    await browser.close().catch(() => {})
  }

  const seen = new Set()
  return all.filter(model => {
    const key = modelKey(model)
    if (!key || seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function extractModelsFromText(brand, text) {
  const patterns = brand === 'huawei' ? [
    /(?:\u534e\u4e3a\s*)?Mate\s*(?:X\s*)?\d{1,3}\s*(?:RS\s*)?(?:Pro\s*\+?|Pro\s*Max|Ultra|Max|Air|SE)?(?:\s*(?:\u5178\u85cf\u7248|\u98ce\u9a70\u7248|\u4f18\u4eab\u7248))?/gi,
    /(?:\u534e\u4e3a\s*)?Pura\s*(?:X|\d{1,3})\s*(?:Pro\s*\+?|Pro|Ultra)?(?:\s*(?:\u5178\u85cf\u7248))?/gi,
    /(?:\u534e\u4e3a\s*)?nova\s*\d{1,3}\s*(?:Pro|Ultra|SE)?/gi,
    /(?:\u534e\u4e3a\s*)?\u7545\u4eab\s*\d{1,3}[A-Za-z]?\s*(?:Plus|Pro|Max)?/gi,
  ] : brand === 'honor' ? [
    /(?:\u8363\u8000\s*)?Magic\s*(?:V\s*)?\d{1,2}\s*(?:Pro|Lite|RSR|Ultimate)?/gi,
    /(?:\u8363\u8000\s*)?(?:\d{2,3}|X\d{2,3}|GT|Power\d?|WIN)\s*(?:Pro|Plus|Max|Ultra|GT)?/gi,
  ] : [
    /vivo\s*(?:X|S|Y|T)\s*\d{2,3}[A-Za-z]?\s*(?:Pro\s*mini|Pro|Ultra|mini|s|e|i|t|Turbo)?/gi,
    /iQOO\s*(?:Neo\s*)?(?:Z\s*)?\d{1,2}[A-Za-z]?\s*(?:Pro|Turbo|x|Max|Plus)?/gi,
  ]

  return patterns
    .flatMap(pattern => Array.from(text.matchAll(pattern), m => normalizeDiscoveredModel(brand, m[0])))
    .filter(Boolean)
}

function normalizeDiscoveredModel(brand, raw) {
  let model = raw
    .replace(/\s+/g, ' ')
    .replace(/\bNEW\b/gi, '')
    .replace(/[\u3000]/g, ' ')
    .trim()

  model = model
    .replace(/^(?:\u624b\u673a|\u7cfb\u5217|\u4ea7\u54c1)\s*/g, '')
    .replace(/\s*(?:\u624b\u673a|\u7cfb\u5217|\u4ea7\u54c1|\u5b98\u7f51|\u5546\u57ce)$/g, '')
    .trim()

  if (brand === 'huawei' && !/^\u534e\u4e3a|^huawei/i.test(model)) {
    model = `\u534e\u4e3a ${model}`
  }
  if (brand === 'honor' && !/^\u8363\u8000|^honor/i.test(model)) {
    model = `\u8363\u8000 ${model}`
  }
  model = model
    .replace(/^\u534e\u4e3a(?=\S)/, '\u534e\u4e3a ')
    .replace(/^\u8363\u8000(?=\S)/, '\u8363\u8000 ')
    .replace(/^vivo\s+/i, 'vivo ')
    .replace(/^iqoo\s+/i, 'iQOO ')
    .replace(/\bpro\b/gi, 'Pro')
    .replace(/\bultra\b/gi, 'Ultra')
    .replace(/\bmax\b/gi, 'Max')
    .replace(/\bplus\b/gi, 'Plus')
    .replace(/\bmini\b/gi, 'mini')
    .replace(/\s+/g, ' ')
    .trim()

  if (model.length < 5 || model.length > 40) return ''
  if (/(?:\u8033\u673a|\u5e73\u677f|\u624b\u8868|\u8def\u7531|\u7535\u8111|\u4fdd\u62a4|\u5145\u7535|\u914d\u4ef6|\u670d\u52a1|\u4e13\u9898|\u6d3b\u52a8|\u56fe\u5e93|\u65b0\u95fb)/.test(model)) return ''
  return model
}

function extractPreloadedState(html) {
  const marker = 'window.__PRELOADED_STATE__ = '
  const start = html.indexOf(marker)
  if (start < 0) return null
  const jsonStart = start + marker.length
  const jsonEnd = html.indexOf(';\nwindow.__ENABLE_HYDRATE__', jsonStart)
  if (jsonEnd < 0) return null
  try {
    return JSON.parse(html.slice(jsonStart, jsonEnd))
  } catch {
    return null
  }
}

function normalizeDjiKey(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '')
    .replace(/^dji/, '')
    .replace(/^大疆/, '')
}

function cleanDjiLines(html) {
  return Array.from(new Set(html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, '\n')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .split(/\n+/)
    .map(line => line.trim())
    .filter(line => line.length > 1 && line.length < 140)))
}

function djiTitleFromHtml(html) {
  return (html.match(/<title[^>]*>([^<]+)/i)?.[1] || '')
    .replace(/^购买\s*/i, '')
    .replace(/\s*-\s*DJI.*$/i, '')
    .replace(/\s*-\s*大疆.*$/i, '')
    .trim()
}

function djiModelSlugFromInput(input) {
  const raw = String(input || '').trim()
  if (/^[a-z0-9-]+$/i.test(raw)) return raw.toLowerCase()
  const key = normalizeDjiKey(raw)
  const known = {
    djimini4pro: 'dji-mini-4-pro',
    mini4pro: 'dji-mini-4-pro',
    djiair3s: 'dji-air-3s',
    air3s: 'dji-air-3s',
    djimavic4pro: 'dji-mavic-4-pro',
    mavic4pro: 'dji-mavic-4-pro',
    osmopocket3: 'osmo-pocket-3',
    pocket3: 'osmo-pocket-3',
  }
  return known[key] || ''
}

function djiVariantPrice(variants, slug) {
  return variants.find(v => v.product === slug) || variants.find(v => v.slug === slug) || null
}

function isDjiUsablePrice(value) {
  const price = Number(value)
  return Number.isFinite(price) && price > 0 && price < 50000
}

function djiIncludedItems(product) {
  return (product?.inTheBoxes || [])
    .filter(item => Number(item.quantity) > 0)
    .map(item => ({
      name: String(item.name || '').trim(),
      quantity: Number(item.quantity),
      slug: item.slug || '',
    }))
}

function djiControllerFromTitle(title) {
  if (/RC Pro 2/i.test(title)) return 'DJI RC Pro 2'
  if (/RC 2/i.test(title)) return 'DJI RC 2'
  if (/RC-N3/i.test(title)) return 'DJI RC-N3'
  if (/RC-N2/i.test(title)) return 'DJI RC-N2'
  if (/带屏遥控器/.test(title)) return '带屏遥控器'
  if (/普通遥控器/.test(title)) return '普通遥控器'
  return ''
}

function djiBundleKind(title) {
  if (/创作者|Creator/i.test(title)) return '创作者套装'
  if (/全能/.test(title)) return '全能套装'
  if (/Vlog/i.test(title)) return 'Vlog 套装'
  if (/长续航/.test(title)) return '长续航畅飞'
  if (/畅飞|Fly More/i.test(title)) return '畅飞套装'
  if (/即刻开拍/.test(title)) return '即刻开拍'
  return '标准套装'
}

function extractDjiHighlights(html, title) {
  const lines = cleanDjiLines(html)
  const scoreLine = (line) => {
    let score = 0
    if (/(4K|6K|HDR|CMOS|哈苏|像素|D-Log|云台|长焦|一英寸|1 英寸|1英寸)/i.test(line)) score += 4
    if (/(避障|图传|飞行时间|续航|全向|LiDAR|夜景|fps|克|249)/i.test(line)) score += 4
    if (line.includes(title)) score -= 4
    if (/套装|购买|选择|服务|增值|配件|DJI Care/.test(line)) score -= 3
    if (line.length > 48) score -= 1
    return score
  }
  return lines
    .map(line => ({ line, score: scoreLine(line) }))
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .map(item => item.line)
    .filter((line, index, arr) => arr.findIndex(other => normalizeDjiKey(other) === normalizeDjiKey(line)) === index)
    .slice(0, 8)
}

function extractDjiSpecsFromHighlights(highlights) {
  const text = highlights.join('。')
  return {
    camera: highlights.find(line => /(CMOS|哈苏|像素|一英寸|1 英寸|1英寸|长焦)/i.test(line)) || '',
    video: highlights.find(line => /(4K|6K|HDR|fps|D-Log)/i.test(line)) || '',
    safety: highlights.find(line => /(避障|全向|LiDAR|夜景)/i.test(line)) || '',
    transmission: highlights.find(line => /(图传|公里)/i.test(line)) || '',
    endurance: highlights.find(line => /(续航|飞行时间|\d+\s*分钟)/i.test(line)) || '',
    weight: text.match(/(?:轻于\s*)?\d+\s*克/)?.[0] || '',
  }
}

async function fetchDjiProductBySlug(slug) {
  const url = `https://store.dji.com/cn/product/${encodeURIComponent(slug)}?set_region=CN`
  const response = await fetch(url, { headers: COMMON_HEADERS, redirect: 'follow' })
  const html = await response.text()
  const data = extractPreloadedState(html)
  if (!response.ok || !data?.products) {
    return { ok: false, source: 'dji', message: `DJI 商品页读取失败：${response.status}`, product: null }
  }

  const variants = data.products.variants || []
  const products = data.products.products || []
  const rootProduct = products.find(product => product.slug === slug)
  const pageTitle = djiTitleFromHtml(html) || rootProduct?.title || slug
  const baseTitle = (rootProduct?.title || pageTitle)
    .replace(/[（(].*?[）)]/g, '')
    .replace(/\s*-\s*.*$/g, '')
    .trim()
  const titleKey = normalizeDjiKey(baseTitle).slice(0, Math.min(12, normalizeDjiKey(baseTitle).length))
  const productRows = products
    .filter(product => product?.inTheBoxes?.length && (product.slug === slug || normalizeDjiKey(product.title).includes(titleKey)))
    .map(product => {
      const variant = djiVariantPrice(variants, product.slug)
      const usablePrice = isDjiUsablePrice(variant?.price)
      return {
        title: product.title,
        slug: product.slug,
        type: product.type,
        price: usablePrice ? (variant?.priceLabel || `¥${variant.price}`) : '',
        priceValue: usablePrice ? variant.price : null,
        controller: djiControllerFromTitle(product.title),
        bundleKind: djiBundleKind(product.title),
        includedItems: djiIncludedItems(product),
      }
    })
    .filter(bundle => bundle.price)

  const seenBundles = new Set()
  const bundles = productRows.filter(bundle => {
    const key = `${bundle.title}|${bundle.price}`
    if (seenBundles.has(key)) return false
    seenBundles.add(key)
    return true
  })

  const careServices = variants
    .filter(variant => /DJI Care|随心换/i.test(variant.title || '') && normalizeDjiKey(variant.title).includes(normalizeDjiKey(baseTitle).slice(0, 10)))
    .map(variant => ({
      name: variant.title,
      price: isDjiUsablePrice(variant.price) ? (variant.priceLabel || `¥${variant.price}`) : '',
      slug: variant.slug,
    }))
    .filter(service => service.price)
    .slice(0, 4)

  const highlights = extractDjiHighlights(html, pageTitle)
  const specs = extractDjiSpecsFromHighlights(highlights)
  const mainPrice = bundles[0]?.price || ''
  const result = {
    ok: Boolean(bundles.length),
    source: 'dji',
    product: bundles.length ? {
      brand: 'DJI',
      title: baseTitle,
      slug,
      url,
      price: mainPrice,
      priceStatus: mainPrice ? 'available' : 'pending',
      bundles,
      careServices,
      highlights,
      specs,
      fetchedFrom: response.url,
    } : null,
    message: bundles.length ? '' : 'DJI 商城未找到可用套装价格。',
  }
  return result
}

async function handleDjiSearch(req, res, model) {
  const slug = djiModelSlugFromInput(model)
  if (!slug) {
    sendJson(res, 200, { ok: false, source: 'dji', message: '暂未识别该 DJI 型号。', product: null })
    return
  }
  const result = await fetchDjiProductBySlug(slug).catch(error => ({
    ok: false,
    source: 'dji',
    message: error?.message || String(error),
    product: null,
  }))
  sendJson(res, 200, result)
}

async function runCliBuildDjiData() {
  const fs = await import('node:fs')
  const path = await import('node:path')
  const argv = process.argv
  const modelsArgIdx = argv.indexOf('--models')
  const outArgIdx = argv.indexOf('--out')
  const delayMinArgIdx = argv.indexOf('--delay-min-ms')
  const delayMaxArgIdx = argv.indexOf('--delay-max-ms')
  const modelsFile = modelsArgIdx >= 0 ? argv[modelsArgIdx + 1] : 'data/dji-products.txt'
  const outFile = outArgIdx >= 0 ? argv[outArgIdx + 1] : 'public/data/dji-products.json'
  const delayMinMs = delayMinArgIdx >= 0 ? Number(argv[delayMinArgIdx + 1]) : 2000
  const delayMaxMs = delayMaxArgIdx >= 0 ? Number(argv[delayMaxArgIdx + 1]) : 5000

  if (!fs.existsSync(modelsFile)) {
    console.error(`DJI models file not found: ${modelsFile}`)
    process.exit(1)
  }

  let prevResults = {}
  if (fs.existsSync(outFile)) {
    try { prevResults = JSON.parse(fs.readFileSync(outFile, 'utf8')) } catch {}
  }

  const slugs = readModelLines(fs.readFileSync(modelsFile, 'utf8'))
  const results = {}
  console.log(`[build-dji-data] ${slugs.length} DJI product pages from ${modelsFile}`)
  for (let i = 0; i < slugs.length; i++) {
    const slug = slugs[i]
    const t0 = Date.now()
    if (i > 0) await sleep(randomInt(delayMinMs, delayMaxMs))
    try {
      const data = await fetchDjiProductBySlug(slug)
      results[slug] = { ...data, fetchedAt: new Date().toISOString() }
      console.log(`[${i + 1}/${slugs.length}] ${slug} -> ${data.ok ? 'OK' : 'MISS'} (${Date.now() - t0}ms)`)
    } catch (err) {
      const fallback = prevResults[slug]
      if (fallback) {
        results[slug] = { ...fallback, error: err?.message || String(err), errorAt: new Date().toISOString() }
        console.warn(`[${i + 1}/${slugs.length}] ${slug} -> FAIL, kept previous (${err?.message || err})`)
      } else {
        results[slug] = { ok: false, source: 'dji', message: err?.message || String(err), fetchedAt: new Date().toISOString() }
        console.warn(`[${i + 1}/${slugs.length}] ${slug} -> FAIL (${err?.message || err})`)
      }
    }
  }

  fs.mkdirSync(path.dirname(outFile), { recursive: true })
  fs.writeFileSync(outFile, JSON.stringify(results, null, 2))
  const okCount = Object.values(results).filter(item => item?.ok).length
  console.log(`[build-dji-data] wrote ${Object.keys(results).length} entries (${okCount} OK) -> ${outFile}`)
  process.exit(0)
}

async function runCliBuild() {
  const fs = await import('node:fs')
  const path = await import('node:path')

  const argv = process.argv
  const modelsArgIdx = argv.indexOf('--models')
  const outArgIdx = argv.indexOf('--out')
  const refreshLimitArgIdx = argv.indexOf('--refresh-limit')
  const staleDaysArgIdx = argv.indexOf('--stale-days')
  const delayMinArgIdx = argv.indexOf('--delay-min-ms')
  const delayMaxArgIdx = argv.indexOf('--delay-max-ms')
  const modelsFile = modelsArgIdx >= 0 ? argv[modelsArgIdx + 1] : 'data/models.txt'
  const outFile = outArgIdx >= 0 ? argv[outArgIdx + 1] : 'public/data/products.json'
  const fullRefresh = argv.includes('--full-refresh')
  const refreshLimit = refreshLimitArgIdx >= 0 ? Number(argv[refreshLimitArgIdx + 1]) : 20
  const staleDays = staleDaysArgIdx >= 0 ? Number(argv[staleDaysArgIdx + 1]) : 5
  const delayMinMs = delayMinArgIdx >= 0 ? Number(argv[delayMinArgIdx + 1]) : 3000
  const delayMaxMs = delayMaxArgIdx >= 0 ? Number(argv[delayMaxArgIdx + 1]) : 8000

  if (!fs.existsSync(modelsFile)) {
    console.error(`models file not found: ${modelsFile}`)
    process.exit(1)
  }

  const models = fs.readFileSync(modelsFile, 'utf8')
    .split(/\r?\n/)
    .map(s => s.trim())
    .filter(s => s && !s.startsWith('#'))

  console.log(`[build-data] ${models.length} models from ${modelsFile}`)

  let prevResults = {}
  if (fs.existsSync(outFile)) {
    try { prevResults = JSON.parse(fs.readFileSync(outFile, 'utf8')) } catch {}
  }

  const refreshPlan = buildRefreshPlan(models, prevResults, {
    fullRefresh,
    refreshLimit,
    staleDays,
  })
  console.log(`[build-data] refresh ${refreshPlan.refreshModels.size}/${models.length} models (${refreshPlan.reasonCounts.join(', ')})`)

  const results = {}
  let refreshedCount = 0
  for (let i = 0; i < models.length; i++) {
    const model = models[i]
    const tag = `[${i + 1}/${models.length}] ${model}`
    const prev = prevResults[model]

    if (!refreshPlan.refreshModels.has(model) && prev) {
      results[model] = prev
      console.log(`${tag} -> KEEP (${refreshPlan.reasons.get(model) || 'fresh'})`)
      continue
    }

    if (refreshedCount > 0) {
      await sleep(randomInt(delayMinMs, delayMaxMs))
    }

    const t0 = Date.now()
    try {
      const data = await invokeOfficialSearch(model)
      const normalizedData = markProductPriceStatus(data)
      let zhihuItems = []
      if (normalizedData?.ok && /\u8363\u8000|honor/i.test(model)) {
        const z = await invokeZhihuSearch(`${model} \u5356\u70b9 \u53c2\u6570 \u8bc4\u6d4b`, 8)
        zhihuItems = z.items || []
      }
      results[model] = { ...normalizedData, zhihuItems, fetchedAt: new Date().toISOString() }
      const okFlag = normalizedData?.ok ? 'OK' : 'MISS'
      refreshedCount += 1
      console.log(`${tag} -> ${okFlag} ${refreshPlan.reasons.get(model) || 'refresh'} (${Date.now() - t0}ms)`)
    } catch (err) {
      // Keep last good entry on failure to avoid losing data on transient errors.
      const fallback = prev
      if (fallback) {
        results[model] = { ...fallback, error: err?.message || String(err), errorAt: new Date().toISOString() }
        console.warn(`${tag} -> FAIL, kept previous (${err?.message || err})`)
      } else {
        results[model] = { ok: false, message: err?.message || String(err), fetchedAt: new Date().toISOString() }
        console.warn(`${tag} -> FAIL (${err?.message || err})`)
      }
    }
  }

  fs.mkdirSync(path.dirname(outFile), { recursive: true })
  fs.writeFileSync(outFile, JSON.stringify(results, null, 2))
  const okCount = Object.values(results).filter(r => r?.ok).length
  console.log(`[build-data] wrote ${Object.keys(results).length} entries (${okCount} OK, ${refreshedCount} refreshed) -> ${outFile}`)
  process.exit(0)
}

function buildRefreshPlan(models, prevResults, options) {
  const refreshModels = new Set()
  const reasons = new Map()
  const staleModels = []
  const counts = new Map()

  const add = (model, reason) => {
    refreshModels.add(model)
    reasons.set(model, reason)
    counts.set(reason, (counts.get(reason) || 0) + 1)
  }

  for (const model of models) {
    const prev = prevResults[model]
    if (options.fullRefresh) {
      add(model, 'full-refresh')
      continue
    }
    if (!prev) {
      add(model, 'new')
      continue
    }
    if (isPendingPriceEntry(prev)) {
      add(model, 'pending-price')
      continue
    }
    if (isStaleEntry(prev, options.staleDays)) {
      staleModels.push(model)
    }
  }

  const limit = Number.isFinite(options.refreshLimit) && options.refreshLimit >= 0 ? options.refreshLimit : staleModels.length
  for (const model of staleModels.slice(0, limit)) {
    add(model, 'stale')
  }
  for (const model of staleModels.slice(limit)) {
    reasons.set(model, 'stale-deferred')
  }

  return {
    refreshModels,
    reasons,
    reasonCounts: Array.from(counts.entries()).map(([reason, count]) => `${reason}:${count}`),
  }
}

function isPendingPriceEntry(entry) {
  return entry?.ok && entry.product && (entry.product.priceStatus === 'pending' || !hasPublishedPrice(entry.product))
}

function isStaleEntry(entry, staleDays) {
  const timestamp = Date.parse(entry?.fetchedAt || entry?.errorAt || '')
  if (!Number.isFinite(timestamp)) return true
  const maxAgeMs = Math.max(1, Number(staleDays) || 5) * 24 * 60 * 60 * 1000
  return Date.now() - timestamp >= maxAgeMs
}

function randomInt(min, max) {
  const safeMin = Math.max(0, Number.isFinite(min) ? min : 0)
  const safeMax = Math.max(safeMin, Number.isFinite(max) ? max : safeMin)
  return Math.floor(safeMin + Math.random() * (safeMax - safeMin + 1))
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

// Adapter: invoke the existing HTTP-style handlers with a stub req/res to
// capture the JSON they would have sent. Avoids any handler refactor.
function invokeOfficialSearch(model) {
  return invokeHandler(handleOfficialSearch, `/api/official/search?model=${encodeURIComponent(model)}`)
}
function invokeZhihuSearch(query, count = 8) {
  return invokeHandler(handleZhihuSearch, `/api/zhihu/global-search?count=${count}&query=${encodeURIComponent(query)}`)
}
function invokeHandler(handler, urlPath) {
  return new Promise((resolve) => {
    const req = { url: urlPath, headers: { host: 'localhost' } }
    const res = {
      writeHead() {},
      end(payload) {
        try { resolve(JSON.parse(String(payload || ''))) }
        catch { resolve({ ok: false, message: 'invalid handler payload' }) }
      },
    }
    Promise.resolve(handler(req, res)).catch(err => resolve({ ok: false, message: err?.message || String(err) }))
  })
}
