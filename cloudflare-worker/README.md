# Cloudflare LINE Pairup Worker

Worker 使用 Cloudflare Browser Rendering 操作 `chat.line.biz` 和公開可編輯的 Google Sheet，不使用 LINE Messaging API。

## 排程（Asia/Taipei）

- 17:05：下載當下的 Google Sheet CSV、執行 pairup 配對、傳送完整配對資訊。
- 07:00：清除 Sheet 的 C～R 會員填答區、重新下載 CSV 驗證已清空、傳送清除摘要。

Cloudflare cron 使用 UTC，因此設定是：

```text
5 9 * * *   # 17:05 Asia/Taipei，pair
0 23 * * *  # 07:00 Asia/Taipei，clear
```

`clear` 不提供手動執行端點，避免誤刪仍在使用的當日資料。

## 驗證與部署

```powershell
cd C:\Users\user\Desktop\project\line-local-puppeteer\cloudflare-worker
npm install
npm test
npm run check
npm run deploy
```

Worker 需要下列 Cloudflare bindings：

- `BROWSER`：Browser Rendering
- `LINE_STATE`：保存 LINE cookies 和最後執行結果的 KV namespace
- `ADMIN_TOKEN`：保護管理端點的 Worker secret

重新上傳 LINE 登入狀態：

```powershell
cd C:\Users\user\Desktop\project\line-local-puppeteer
npm run cloudflare:auth:export
cd cloudflare-worker
npm run auth:upload
```

## 端點

公開健康檢查：

```powershell
Invoke-RestMethod https://line-oa-scheduler.clearbot-user-2026.workers.dev/health
```

需要 `ADMIN_TOKEN` 的 LINE 登入檢查：

```powershell
$token = Read-Host "ADMIN_TOKEN"
$headers = @{ Authorization = "Bearer $token" }
Invoke-RestMethod https://line-oa-scheduler.clearbot-user-2026.workers.dev/check -Headers $headers
```

手動計算並送出 pair：

```powershell
Invoke-RestMethod -Method Post https://line-oa-scheduler.clearbot-user-2026.workers.dev/run/pair -Headers $headers
```

`POST /run/clear` 不存在；clear 只能由 21:00 排程觸發。

## 可選環境變數

- `PAIRUP_CSV_URL`：覆寫 Google Sheet CSV 網址。
- `PAIRUP_SHEET_EDIT_URL`：覆寫要清除的 Google Sheet 編輯網址。
- `PAIRUP_SHEET_GID`：覆寫工作表 gid。
- `PAIRUP_ENABLE_FLEX=true`：啟用 pairup.c 的額外 flex 二人配對行為；預設為 `false`，與原 CLI 相同。

配對邏輯在 `src/pairup.js`，純函式測試在 `test/pairup.test.js`。原始 GPL-3.0 `pairup.c` 放在上一層的 `vendor/pairup.c-master/`。
