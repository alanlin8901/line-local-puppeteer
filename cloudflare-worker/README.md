# LINE OA Cloudflare 排程

這個 Worker 不使用 LINE Messaging API。它透過 Cloudflare Browser Run 開啟 `chat.line.biz`，恢復本機匯出的登入 cookies，然後操作 LINE 網頁輸入框送出指令。

## 排程（Asia/Taipei）

- 每天 07:00：`clear`（Cloudflare UTC cron：`0 23 * * *`）
- 每天 17:05：`pair`（Cloudflare UTC cron：`5 9 * * *`）

Cloudflare Cron 一律使用 UTC，因此早上 07:00 對應前一天 23:00 UTC。

## 初次部署

先確認上一層 `config.json` 具有目前 Ram 聊天室的 `chatUrl`，而且 `npm run check` 能正常登入。

```powershell
cd C:\Users\user\Desktop\project\line-local-puppeteer\cloudflare-worker
npm install
npx wrangler login
npm run deploy
```

第一次部署時 Wrangler 會自動建立 `LINE_STATE` KV namespace，並把 namespace ID 寫回 `wrangler.jsonc`。

接著回到上一層，匯出本機登入狀態：

```powershell
cd C:\Users\user\Desktop\project\line-local-puppeteer
npm run cloudflare:auth:export
```

再上傳到 Cloudflare KV：

```powershell
cd cloudflare-worker
npm run auth:upload
```

`.line-auth-state.json` 含有 LINE 登入 cookies，已加入 `.gitignore`，請勿分享。

## 設定手動操作權杖

排程本身不需要 `ADMIN_TOKEN`。若要使用狀態查詢或手動測試端點，執行：

```powershell
npx wrangler secret put ADMIN_TOKEN
```

輸入一段足夠長且隨機的字串。

## 手動驗證

健康檢查：

```powershell
Invoke-RestMethod https://你的-worker.workers.dev/health
```

查詢登入狀態：

```powershell
$token = Read-Host "ADMIN_TOKEN"
$headers = @{ Authorization = "Bearer $token" }
Invoke-RestMethod https://你的-worker.workers.dev/auth/status -Headers $headers
```

實際啟動 Cloudflare Browser Run 並確認 LINE 登入與輸入框，但不送訊息：

```powershell
Invoke-RestMethod https://你的-worker.workers.dev/check -Headers $headers
```

以下指令會真的在 LINE 群組送出訊息：

```powershell
Invoke-RestMethod -Method Post https://你的-worker.workers.dev/run/clear -Headers $headers
Invoke-RestMethod -Method Post https://你的-worker.workers.dev/run/pair -Headers $headers
```

查看線上日誌：

```powershell
npm run tail
```

## 登入失效時

重新在本機登入 LINE，然後再執行：

```powershell
cd C:\Users\user\Desktop\project\line-local-puppeteer
npm run cloudflare:auth:export
cd cloudflare-worker
npm run auth:upload
```

每次成功執行後，Worker 會把更新後的 cookies 寫回 KV，盡量延長登入狀態。
