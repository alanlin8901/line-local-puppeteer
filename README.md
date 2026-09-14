# LINE Local Puppeteer Test

純本機測試專案，不使用 Cloudflare Browser Run。

## 1. 安裝

```bat
npm install
```

## 2. 建立 config.json

```bat
copy config.example.json config.json
```

打開 `config.json`，把 `chatUrl` 改成真正的 LINE 群組聊天室網址：

```json
{
  "chatUrl": "https://chat.line.biz/你的OA_ID/chat/你的CHAT_ID",
  "headless": false,
  "waitAfterOpenMs": 4000,
  "waitAfterSendMs": 1500
}
```

## 3. 第一次登入

```bat
npm run login
```

Chrome 打開後手動：

```text
登入 LINE
→ 選 Official Account
→ 聊天
→ 目標群組
```

登入資料會保存在：

```text
line-profile/
```

完成後直接關瀏覽器。

## 4. 檢查

```bat
npm run check
```

成功應看到：

```text
✅ 已保持登入
✅ 已停在目標聊天室
✅ 找到訊息輸入框
```

如果失敗，截圖會放在：

```text
screenshots/
```

## 5. 傳 pair

```bat
npm run pair
```

## 6. 傳 clear

```bat
npm run clear
```

## 7. 傳任意文字

```bat
npm run send -- hello
```

## 注意

不要分享或上傳：

```text
line-profile/
config.json
```

`line-profile` 可能包含 LINE 登入狀態。

本機版可繼續用來更新登入狀態或除錯。

## Cloudflare 自動排程

不使用 LINE Messaging API 的 Cloudflare Browser Run 版本位於：

```text
cloudflare-worker/
```

部署、登入狀態更新與手動檢查方式請參考 `cloudflare-worker/README.md`。
