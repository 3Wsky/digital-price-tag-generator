# 长任务规划 —— 价签生成器

更新时间：2026-05-24

---

## 三条铁律（每阶段必须核对）

> **每完成一个阶段，必须对照以下三条逐项检查，全部通过才能进入下一阶段。**

| # | 铁律 | 核对方法 |
|---|------|----------|
| 1 | **不改动页面视图编辑器代码** — 只修改价签卡片编辑器（viewMode='card'）相关逻辑 | 检查 `viewMode === 'page'` 分支的 JSX 和逻辑零改动 |
| 2 | **卖点以外全部以官网为主** — 价格/SKU/颜色/Care+/规格必须来自官网爬虫，知乎仅用于提炼最佳卖点 | 检查 `buildDraftFromOfficial` 中 price/sku/colors/services 全部取自 `product` 参数而非 `zhihuItems` |
| 3 | **每个阶段完成后截图验证** — 用 Playwright 截图确认前端渲染正常 | 截图保存到项目根目录，人工确认排版无错位 |
| 4 | **额外要求**：搜联网搜索， 华为2026年的手机  还有VIVO 2026年的手机 大疆2026年的手机  苹果2026年的手机 来验证测试正确性
，写好开发日志---   

## 项目现状

- **前端：** `src/App.tsx`（~1600行），React 19 + TypeScript + Vite 8
- **后端：** `server.mjs`（~690行），Node.js HTTP Server
- **数据源架构：**
  - 官网爬虫 → 价格/SKU/颜色/Care+/规格（华为已实现，其他品牌待做）
  - 知乎搜索 → 仅提炼卖点（芯片亮点/影像亮点/通信亮点等）
  - 本地模板 → 最终兜底
- **当前品牌覆盖：** 华为（官网）/ VIVO/苹果/小米/荣耀（仅知乎，数据不完整）
- **需新增官网爬虫：** VIVO、荣耀、苹果

---

## 第一阶段：回归测试 + 数据质量修补

> 阶段目标：确认现有功能基线，修补知乎搜索的数据质量问题（为后续官网爬虫接入做准备）。

### 任务 1：回归测试 — 多品牌搜索生成

```
/goal 回归测试：
1. 启动 node server.mjs
2. 用 curl 分别测试以下接口：
   - 华为 Mate 80 Pro Max：/api/official/search + /api/zhihu/global-search
   - VIVO S50：/api/zhihu/global-search
   - 苹果 iPhone 17：/api/zhihu/global-search
3. 记录每个品牌返回数据质量：标题/价格/SKU数量/颜色数量/卖点数量
4. 用 Playwright 截图 http://127.0.0.1:5173/ 确认前端渲染正常
5. 输出一份测试报告，列出每个品牌的数据问题
```

**验证清单：**
| 品牌 | 标题 | 价格 | SKU | 颜色 | 卖点 | 来源 |
|------|------|------|-----|------|------|------|
| 华为 Mate 80 Pro Max | 正确 | 官网价 | ≥3 | ≥3 | ≥3 | official |
| VIVO S50 | 有标题 | 有价格 | ≥1 | ≥1 | ≥2 | zhihu（临时） |
| 苹果 iPhone 17 | 有标题 | 有价格 | ≥1 | ≥1 | ≥2 | zhihu（临时） |

**阶段审核：**
- [ ] 铁律 1：页面视图代码零改动
- [ ] 铁律 2：华为官网数据完整（价格/SKU/颜色/Care+）
- [ ] 铁律 3：截图确认前端渲染正常

---

### 任务 2：知乎搜索词优化（临时方案，为非华为品牌兜底）

> 注意：知乎搜索仅作为官网爬虫上线前的临时兜底。一旦对应品牌官网爬虫完成，知乎将只用于提炼卖点，不再承担价格/SKU/颜色的提取。

```
/goal 知乎搜索词优化：
1. 修改 src/App.tsx searchModel 函数（L1014），按品牌生成差异化 query：
   - VIVO：增加 "骁龙" "天玑" "芯片" "售价" "颜色" 关键词
   - 苹果：增加 "A19" "颜色" "存储" "AppleCare" 关键词
   - 荣耀：增加 "骁龙" "天玑" "MagicOS" 关键词
2. 修改 buildDraftFromSearch 颜色正则，增加各品牌颜色库：
   - VIVO：告白/灵感紫/悠悠蓝/深空黑/钛色
   - 小米：钛银/亮黑/远山蓝/橄榄绿/月影白
   - 苹果：原色钛金属/沙漠钛金属/白色钛金属/黑色钛金属
   - 荣耀：流光金/冰霜蓝/星空黑/晨曦金
3. 测试各品牌搜索结果改善情况
```

**涉及文件：**
- `src/App.tsx` L1014 — `searchModel` query 拼接
- `src/App.tsx` L427 — `buildDraftFromSearch` 颜色提取

**阶段审核：**
- [ ] 铁律 1：页面视图代码零改动
- [ ] 铁律 2：知乎搜索仅用于临时补充，不影响已有华为官网数据链路
- [ ] 铁律 3：截图确认各品牌卡片渲染正常

---

## 第二阶段：官网爬虫（核心功能）

> 阶段目标：为 VIVO、荣耀、苹果实现官网数据爬虫，使价格/SKU/颜色/Care+/规格全部来自官网。知乎在这些品牌中退化为仅提供卖点。

### 数据源架构（目标状态）

```
用户输入型号
    │
    ├──→ 官网 API (/api/official/search)
    │       │
    │       ├── 华为  → Playwright → vmall.com（已实现）
    │       ├── VIVO  → Playwright → vivo.com.cn（本阶段新增）
    │       ├── 荣耀  → Playwright → honor.com（本阶段新增）
    │       └── 苹果  → fetch SSR → apple.com.cn（本阶段新增）
    │       │
    │       └── 返回: 标题/价格/SKU/颜色/Care+/规格
    │
    ├──→ 知乎 API (/api/zhihu/global-search)
    │       → 仅用于提炼卖点（芯片/影像/通信/耐摔亮点）
    │
    └──→ 前端合并 (buildDraftFromOfficial)
            │
            ├── 官网: 价格/SKU/颜色/服务/规格 ← 必须来自官网
            ├── 知乎: 卖点提炼 ← 仅卖点用知乎
            └── 如果官网不可用 → 知乎全量兜底 + 标记"建议复核"
```

### 任务 3：VIVO 官网爬虫

```
/goal VIVO 官网爬虫：
1. 在 server.mjs 新增 handleVivoSearch 函数（~80行）
2. 实现逻辑：
   a. Playwright 启动，访问 https://www.vivo.com.cn/search?keyword={model}
   b. 等待搜索结果渲染，提取产品链接
   c. 排除配件/非手机产品（如耳机、手表、平板）
   d. 跳转产品页，提取：
      - 标题：从页面 <title> 或 h1
      - 价格：匹配 "¥xxx" 或 "xxxx元" 格式
      - SKU：从规格选择器提取存储+内存组合
      - 颜色：从颜色选择器 DOM 提取
      - 规格：芯片/电池/屏幕/充电
   e. 返回格式与华为 handleOfficialSearch 一致
3. 路由：在 handleOfficialSearch 品牌判断中，vivo 品牌调用 handleVivoSearch
4. 缓存：复用 vmallCache，key 为 vivo_{model}
5. 回退：Playwright 失败返回 { ok: false }，前端走知乎兜底
6. 测试：搜索 VIVO S50，验证价格/颜色/SKU 来自官网

注意：不修改页面视图编辑器任何代码（铁律1）
```

**涉及文件：**
- `server.mjs` — 新增 `handleVivoSearch`，路由注册
- `src/App.tsx` — `searchModel` 品牌判断增加 vivo（如需改的话）

**阶段审核：**
- [ ] 铁律 1：页面视图代码零改动
- [ ] 铁律 2：VIVO 价格/SKU/颜色来自官网，知乎仅提供卖点
- [ ] 铁律 3：截图验证 VIVO S50 卡片渲染正常

---

### 任务 4：荣耀官网爬虫

```
/goal 荣耀官网爬虫：
1. 在 server.mjs 新增 handleHonorSearch 函数（~80行）
2. 实现逻辑：
   a. 荣耀官网 www.honor.com/cn/ 支持部分 SSR
   b. 先尝试 fetch 搜索页 https://www.honor.com/cn/search/?keyword={model}
   c. 如果 fetch 拿不到数据，改用 Playwright
   d. 提取：标题/价格/SKU/颜色/规格（芯片/电池/屏幕/充电）
   e. 返回格式与华为一致
3. 路由：在 handleOfficialSearch 品牌判断中，honor 品牌调用 handleHonorSearch
4. 缓存：key 为 honor_{model}
5. 测试：搜索荣耀 Magic7 Pro，验证数据完整

注意：不修改页面视图编辑器任何代码（铁律1）
```

**涉及文件：**
- `server.mjs` — 新增 `handleHonorSearch`，路由注册

**阶段审核：**
- [ ] 铁律 1：页面视图代码零改动
- [ ] 铁律 2：荣耀价格/SKU/颜色来自官网，知乎仅提供卖点
- [ ] 铁律 3：截图验证荣耀卡片渲染正常

---

### 任务 5：苹果官网数据抓取

```
/goal 苹果官网数据抓取：
1. 在 server.mjs 新增 handleAppleSearch 函数（~60行）
2. 苹果官网支持 SSR，不需要 Playwright，用 fetch 即可
3. 实现逻辑：
   a. URL 构造：https://www.apple.com.cn/shop/buy-iphone/{slug}
      slug 转换函数：iPhone 17 Pro Max → iphone-17-pro-max
   b. fetch 页面 HTML
   c. 解析 <script type="application/ld+json"> 获取结构化数据：
      - name → 标题
      - offers → 价格
      - color → 颜色选项
   d. 提取存储规格（128GB/256GB/512GB/1TB）
   e. AppleCare+ 价格从页面文字提取
   f. 返回格式与华为一致
4. 路由：在 handleOfficialSearch 品牌判断中，apple 品牌调用 handleAppleSearch
5. 缓存：key 为 apple_{model}
6. 测试：搜索 iPhone 17，验证价格/颜色/存储来自官网

注意：不修改页面视图编辑器任何代码（铁律1）
```

**涉及文件：**
- `server.mjs` — 新增 `handleAppleSearch`，路由注册

**阶段审核：**
- [ ] 铁律 1：页面视图代码零改动
- [ ] 铁律 2：苹果价格/存储/颜色来自官网，知乎仅提供卖点
- [ ] 铁律 3：截图验证苹果卡片渲染正常

---

### 任务 6：统一官方搜索路由 + 数据源架构调整

```
/goal 统一搜索路由重构：
1. 重构 server.mjs handleOfficialSearch（L472），改为品牌路由器：
   - 华为 → handleHuaweiSearch（现有逻辑提取为函数）
   - VIVO → handleVivoSearch
   - 荣耀 → handleHonorSearch
   - 苹果 → handleAppleSearch
   - 其他 → 返回 ok:false

2. 重构 src/App.tsx searchModel（L1014），确保数据源架构符合铁律2：
   - 官网数据（price/sku/colors/services/specs）→ 直接使用，不经知乎
   - 知乎数据 → 仅用于 features（卖点提炼）
   - 如果官网不可用 → 知乎全量兜底 + source 标记为 'zhihu' + 显示复核标记
   - 如果都没有 → fallback 模板 + source 标记为 'fallback'

3. buildDraftFromOfficial（L498）核对：
   - price 取自 product.price ✓
   - skuPrices 取自 product.skuPrices ✓
   - colors 取自 product.colors ✓
   - careServices 取自 product.careServices ✓
   - specs 取自 product.specs ✓
   - features 取自 zhihuItems（仅卖点）✓

4. 测试所有品牌路由正常分发

注意：不修改页面视图编辑器任何代码（铁律1）
```

**涉及文件：**
- `server.mjs` — L472 `handleOfficialSearch` 重构为路由器
- `src/App.tsx` — L1014 `searchModel`、L498 `buildDraftFromOfficial`

**阶段审核：**
- [ ] 铁律 1：页面视图代码零改动
- [ ] 铁律 2：所有已实现官网的品牌，价格/SKU/颜色/Care+ 100% 来自官网，知乎仅提供卖点
- [ ] 铁律 3：截图验证华为/VIVO/荣耀/苹果卡片渲染正常

---

## 第三阶段：批量功能

> 阶段目标：支持门店批量操作，提高效率。仅修改卡片编辑器相关逻辑。

### 任务 8：Excel/CSV 批量导入

```
/goal 批量导入功能：
1. 在左栏卡片视图（viewMode='card'）的「自动生成」section 下方增加「批量导入」按钮
2. 点击按钮弹出文件选择器（accept=".csv,.xlsx,.xls"）
3. 解析文件内容：
   - CSV：用 split(',') 解析第一列作为型号
   - Excel：npm install xlsx，用 xlsx 库解析第一列
4. 过滤空行和表头行
5. 逐个调用 searchModel，进度显示 "正在搜索 3/10: VIVO S50"
6. 每完成一个自动创建新卡片并填充草稿
7. 全部完成显示汇总 "成功 8/10，失败 2 个"
8. 失败的用 fallback 草稿代替，不中断流程

注意：只在 viewMode='card' 分支添加 UI，不修改 viewMode='page' 分支（铁律1）
```

**涉及文件：**
- `src/App.tsx` — `viewMode === 'card'` 分支新增导入 UI
- `package.json` — 新增 `xlsx` 依赖

**阶段审核：**
- [ ] 铁律 1：页面视图代码零改动
- [ ] 铁律 2：批量导入的卡片，价格/SKU/颜色来自官网，知乎仅提供卖点
- [ ] 铁律 3：截图验证批量导入后卡片渲染正常

---

### 任务 9：数据来源与复核标记

```
/goal 数据来源标注和复核标记：
1. 在 elementsFromDraft（L682）中，根据 draft.source 生成不同脚注：
   - 'official' → "数据来自{品牌}官网"
   - 'zhihu' → "数据来自网络搜索，建议复核"
   - 'fallback' → "本地模板生成，需人工填写"
2. 非官网数据（source !== 'official'）时：
   - 在 TagElement 类型中增加 optional 字段 reviewMark?: boolean
   - 价格元素右上角显示 "复核" 橙色小角标（CSS ::after）
   - 颜色元素右上角显示 "复核" 角标
3. 新增 CSS 类 .review-mark 样式
4. 测试：华为（官网）无标记，VIVO/苹果（知乎）有复核标记

注意：只在价签卡片元素渲染中添加，不修改页面视图（铁律1）
```

**涉及文件：**
- `src/App.tsx` — `TagElement` 类型、`elementsFromDraft`、元素渲染
- `src/App.css` — `.review-mark` 样式

**阶段审核：**
- [ ] 铁律 1：页面视图代码零改动
- [ ] 铁律 2：官网数据无复核标记，非官网数据有复核标记
- [ ] 铁律 3：截图验证复核标记显示正确

---

## 第四阶段：编辑器体验优化

> 阶段目标：提升卡片编辑器的操作效率。仅修改卡片编辑器相关逻辑。

### 任务 10：元素缩放手柄

```
/goal 元素缩放功能：
1. 在 TagElement 渲染中，选中状态时右下角显示 10x10 蓝色缩放手柄
2. 手柄上绑定 mousedown 开始缩放拖拽
3. 拖拽逻辑：记录起始鼠标和元素原始尺寸，mousemove 更新 width/height
4. 最小尺寸保护：width/height ≥ 5px
5. 与现有拖拽移动共存（元素主体 = 移动，手柄 = 缩放）

注意：只修改卡片编辑器中的元素渲染和拖拽逻辑，不修改页面视图（铁律1）
```

**涉及文件：**
- `src/App.tsx` — 元素渲染、拖拽状态管理
- `src/App.css` — `.resize-handle` 样式

---

### 任务 11：画布右键菜单

```
/goal 元素右键菜单：
1. 新增状态 contextMenu: { x, y, elementId } | null
2. TagElement onContextMenu 弹出自定义菜单
3. 菜单项：复制元素 / 删除元素 / 置顶 / 置底
4. 点击画布其他区域关闭菜单

注意：只在卡片编辑器画布中实现，不修改页面视图（铁律1）
```

**涉及文件：**
- `src/App.tsx` — 新增 ContextMenu 组件和状态
- `src/App.css` — `.context-menu` 样式

---

## 执行顺序与阶段门控

```
第一阶段 ──── 审核 1 ────→ 第二阶段 ──── 审核 2 ────→ 第三阶段 ──── 审核 3 ────→ 第四阶段
                                                       
任务1 回归测试    ║  任务3 VIVO爬虫    ║  任务7 批量导入    ║  任务9  缩放手柄
任务2 搜索词优化  ║  任务4 荣耀爬虫    ║  任务8 复核标记    ║  任务10 右键菜单
                  ║  任务5 苹果爬虫    ║                    ║
                  ║  任务6 统一路由    ║                    ║
                  
审核要点：        ║  审核要点：        ║  审核要点：        ║  审核要点：
□ 铁律1          ║  □ 铁律1          ║  □ 铁律1          ║  □ 铁律1
□ 铁律2          ║  □ 铁律2          ║  □ 铁律2          ║  □ 铁律2
□ 铁律3          ║  □ 铁律3          ║  □ 铁律3          ║  □ 铁律3
```

**阶段门控规则：**
- 每个阶段结束必须完成三条铁律审核
- 审核不通过则在当前阶段修复，不进入下一阶段
- 审核通过后截图存档，作为基线对比

---

## /goal 指令速查

| 阶段 | 任务 | /goal 指令 |
|------|------|-----------|
| 一 | 1 | `/goal 回归测试：启动 server.mjs，curl 测试华为/VIVO/苹果的官方搜索和知乎搜索接口，记录数据质量，截图验证前端渲染，输出测试报告` |
| 一 | 2 | `/goal 知乎搜索词优化：按品牌差异化 query（VIVO加骁龙天玑、苹果加A19颜色存储、荣耀加骁龙MagicOS），颜色正则增加各品牌颜色库，测试改善效果` |
| 二 | 3 | `/goal VIVO官网爬虫：server.mjs 新增 handleVivoSearch，Playwright 搜索 vivo.com.cn 提取价格/颜色/SKU/规格，前端searchModel接入，测试VIVO S50` |
| 二 | 4 | `/goal 荣耀官网爬虫：server.mjs 新增 handleHonorSearch，fetch或Playwright 抓取 honor.com 提取价格/颜色/SKU/规格，测试荣耀Magic7 Pro` |
| 二 | 5 | `/goal 苹果官网抓取：server.mjs 新增 handleAppleSearch，fetch apple.com.cn 解析JSON-LD提取价格/颜色/存储/AppleCare+，测试iPhone 17` |
| 二 | 6 | `/goal 统一搜索路由：将 handleOfficialSearch 拆分为品牌路由器（华为/VIVO/荣耀/苹果），确保 buildDraftFromOfficial 价格/SKU/颜色/Care+全部来自官网参数，知乎仅提供卖点，截图验证4个品牌` |
| 三 | 7 | `/goal 批量导入：viewMode='card'左栏新增导入按钮，支持CSV/Excel解析型号列，逐个搜索生成卡片+进度显示，测试5个型号` |
| 三 | 8 | `/goal 复核标记：elementsFromDraft按source生成不同脚注，非官网数据价格/颜色显示复核角标，测试华为无标记VIVO有标记` |
| 四 | 9 | `/goal 元素缩放手柄：选中元素右下角显示蓝色手柄，拖拽调整尺寸，最小5px保护，测试缩放` |
| 四 | 10 | `/goal 右键菜单：元素onContextMenu弹出菜单（复制/删除/置顶/置底），点击画布关闭，测试复制和删除` |

---

## 后续扩展（今天暂不执行）

### 任务 11：大疆官网数据抓取

```
/goal 大疆官网数据抓取：
1. 在 server.mjs 新增 handleDjiSearch 函数（~60行）
2. 大疆官网 www.dji.com/cn 支持 SSR
3. 实现逻辑：
   a. 先搜索：https://www.dji.com/cn/search?q={model}
   b. 从搜索结果中找到产品页链接
   c. fetch 产品页，提取：
      - 标题：产品名
      - 价格：匹配 "¥xxx"
      - SKU：不同配置版本（标准版/畅飞套/行业版等）
      - 规格：传感器/续航/图传距离/重量
   d. 大疆没有传统"颜色"概念，跳过颜色提取
   e. 大疆没有 Care+，跳过服务提取
   f. 返回格式与华为一致，空字段用 null
4. 路由：在 handleOfficialSearch 品牌判断中，dji 品牌调用 handleDjiSearch
5. 缓存：key 为 dji_{model}
6. 测试：搜索 DJI Mini 4 Pro，验证价格/配置来自官网

注意：不修改页面视图编辑器任何代码（铁律1）
```

**涉及文件：**
- `server.mjs` — 新增 `handleDjiSearch`，路由注册

**阶段审核：**
- [ ] 铁律 1：页面视图代码零改动
- [ ] 铁律 2：大疆价格/配置来自官网
- [ ] 铁律 3：截图验证大疆卡片渲染正常
