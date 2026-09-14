# LINE Pairup 自動排程

這個專案使用 Puppeteer 操作 LINE Official Account Chat，不使用 LINE Messaging API。

Cloudflare Worker 會直接讀取英文讀書會的 Google Sheet：

- 每天 17:05（Asia/Taipei）計算配對並把完整結果送到 `Ram`。
- 每天 07:00（Asia/Taipei）清除 Google Sheet 的會員填答區，再把清除結果送到 `Ram`。
- `pair` 可手動執行；`clear` 刻意只允許排程執行。
- 每次操作完成後會關閉整個 Puppeteer browser，所有分頁都會一併關閉。
- LINE 登入過期時會自動點選上次使用的 LINE 帳號及保留帳號登入。
- clear 通知若暫時送不出去，會保存在 KV，下一次 pair 前先補送。

clear 完成後固定傳送：

```text
Hi everyone, 小企鵝 just updated the sheet, please fill it out before 17:00.😊
https://docs.google.com/spreadsheets/d/19s78tQZO6-g5ph2sOiKDf1whIAt3fITZpoo5QeRf62A/edit
```

## 本機 LINE 登入與檢查

```powershell
npm install
npm run login
npm run check
```

登入資料保存在 `line-profile/`。目前帳號名稱是 `小企鵝 notify`，聊天室依 `config.json` 裡的固定 `chatUrl` 開啟，因此更名後不用重新取得網址。

## 手動測試 pair

以下命令會呼叫已部署的 Worker、即時計算 Sheet，並真的送出配對結果：

```powershell
npm run pair
```

管理 token 由 `cloudflare-worker/.dev.vars` 的 `ADMIN_TOKEN` 讀取，不會顯示在命令列。

## Cloudflare Worker

詳細部署與端點說明請看 [cloudflare-worker/README.md](cloudflare-worker/README.md)。

## pairup.c 原始碼

配對演算法與訊息格式移植自使用者提供的 `pairup.c-master.zip`。原始 GPL-3.0 程式與授權文字保留在 `vendor/pairup.c-master/`。
