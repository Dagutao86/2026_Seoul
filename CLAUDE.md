# 首爾行程 App — 專案說明

單頁 PWA，記錄 2026/8/20–8/26 首爾行程。純靜態網站，沒有 build step，GitHub Pages 直接讀檔案就能跑。

**repo 已從 `Dagutao86.github.io` 改名為 `2026_Seoul`**，網址因此變成 `https://dagutao86.github.io/2026_Seoul/`（舊網址已失效，舊的主畫面捷徑要重新加入）。

## 檔案結構

- `index.html` — 主體，所有內容、樣式、邏輯都在這一個檔案裡
- `manifest.json` — PWA 設定
- `sw.js` — service worker，離線快取
- `icon-*.png` / `apple-touch-icon.png` — App icon
- `fonts/ChenYuluoyan-2.0-Thin.woff2` — 自訂字體（辰宇落雁體 2.0 Thin）

## 四個分頁

底部有一條固定的玻璃質感膠囊切換列（`.dock`），切換 `#viewTrip` / `#viewBag` / `#viewCalc` / `#viewLog` 四個區塊：

1. **行程** — 頁首（大標、當日天氣、未來 12 小時預報條）+ 日期列 + 時間軸卡片 + 頁尾備忘
2. **行李** — 可勾選的行李清單
3. **計算** — 韓元計算機，即時顯示台幣
4. **記帳** — 分日／分類記帳，含小算盤

`.dock` 的 `bottom` 用 `calc(env(safe-area-inset-bottom,0px) + 24px)`，是為了避開 Android 的手勢列與返回鍵，**不要改小**。

## 資料變數（都在 `<script>` 開頭）

- **`DAYS`** — 每天一個物件，`events` 是時間軸項目：
  `{ when:"時間", h:"標題", p:"說明", spots:["韓文關鍵字"], key:true/false }`
  - `key:true` 是強調樣式（紅點、紅色左框），只給真正重要的預約或航班
  - `spots` 一律**韓文**，會生成 Naver Map 連結
  - `memo` 是當天結尾提醒框，可有可無
  - 航班那筆寫成 `{ flight:"out"|"in", key:true, when:"時間" }`
- **`FLIGHTS`** — 去回程航班（`out` / `in`），含航班號、起降、航廈、PNR、座位
- **`LOC`** — 各區座標。**每天的天氣抓當天主要行程地點**，不是首爾市中心
- **`BAG`** — 行李清單，`{ t:"分類", i:["項目"] }`
- **`CATS`** — 記帳分類清單
- **`LOG_DAYS`** — 記帳用的日期，比 `DAYS` 多一個 Day 0（行前花費）

## localStorage 鍵

`bagChecked`（行李勾選）、`expenses`（記帳）、`fxKRWTWD`（最後一次匯率）。
**各裝置獨立，不會同步**——同行的人各自勾各自的。

## 外部 API

- 天氣 `api.open-meteo.com`、匯率 `open.er-api.com`
- 兩者在 `sw.js` 的 fetch handler 裡**直接 return 走網路**，不進快取。新增類似 API 要記得加進那個例外，否則會被鎖在舊資料
- 匯率抓不到時退回 `localStorage` 的舊值並標示日期；完全沒有時，記帳的台幣選項會自動鎖住

## 重要規則：改動後一定要做的事

1. **改完 `index.html` 就把 `sw.js` 的 `VERSION` 加一**（`seoul-v38` → `seoul-v39`）。沒加的話手機會卡在舊版。這是最容易漏、也最重要的一步
2. 直接 commit 並 push 到 `main`（個人小工具，不開 PR）
3. commit message 用簡短中文
4. push 完提醒一句：手機上按天氣卡右下角的更新圖示，或離開 app 重開

## 語言與風格

- 所有文字（行程、備忘、commit message）用**繁體中文**
- `spots` 關鍵字一律**韓文**
- 設計語彙：米色／白色韓紙（한지）質感，青／赤／黃只作重點強調，登機證造型的航班卡，**直角不用圓角**（唯一例外是底部切換列的膠囊）。除非明確要求，不要動配色與版面結構
- 字體：`--f-title` 辰宇落雁體用於標題**與內文說明**（使用者要求過，內文確實要用手寫體）；`--f-mono` Space Mono 給數字與英文標籤；`--f-cjk` 霞鶩文楷為 fallback
- 時間、地點、金額這類事實資訊，優先確認使用者提供的原始資料，**不要自己推測填入**。真的需要推算（例如車程）要講明是推算的

## 待處理

- **Day 4 中午沒有午餐項目**（原本的午餐是已刪除的益善洞）。使用者還在考慮要排什麼，之後會指定，先不要自己補上

## 踩過的坑（別再犯）

- **class 命名衝突**：`.k` 已經被 `.live .k`、`.bp-pnr .k`、`.bp-cell .k` 用掉，新增全域 class 前先 grep
- **CSS `transform` 會蓋掉 SVG 的 `transform` 屬性**：登機證的飛機動畫因此把縮放吃掉了，解法是把動畫掛在外層 `<g>`，各自作用在不同層級
- **滑動手勢後會補一個 `click`**：記帳左滑刪除要用旗標吃掉那次 click，否則剛滑開就被收起來
- **橫向拖曳會被判定成選字**並發出 `pointercancel`：可滑動的列需要 `touch-action:pan-y` + `user-select:none`
- `html` 有 `touch-action:manipulation` 關掉雙擊放大（計算機連按數字用），**雙指縮放要保留**，不要改成 `user-scalable=no`
