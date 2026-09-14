import fs from "node:fs";
import path from "node:path";
import {
  closeBrowser,
  launchBrowser,
  loadConfig,
  recoverLineLogin,
  sleep,
} from "./common.js";

const config = loadConfig();

if (!config.chatUrl) {
  throw new Error(
    "config.json 缺少 chatUrl。"
  );
}

const chatUrl =
  new URL(config.chatUrl);

if (
  chatUrl.protocol !== "https:" ||
  chatUrl.hostname !== "chat.line.biz"
) {
  throw new Error(
    "config.json 的 chatUrl 必須是 https://chat.line.biz/..."
  );
}

const outputPath = path.resolve(
  process.cwd(),
  "cloudflare-worker",
  ".line-auth-state.json"
);

const browser = await launchBrowser({
  headless: true,
});

try {
  const pages =
    await browser.pages();

  const page =
    pages[0] ??
    await browser.newPage();

  await page.goto(chatUrl.href, {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });

  await recoverLineLogin(
    page,
    chatUrl.href
  );

  await sleep(4000);

  const composer =
    await page.$(
      "textarea-ex#editor"
    );

  if (!composer) {
    throw new Error(
      [
        "目前本機 LINE profile 未登入，無法匯出。",
        "請先執行 npm run login，登入並進入聊天室。",
      ].join("\n")
    );
  }

  const cookies =
    await browser
      .defaultBrowserContext()
      .cookies();

  if (cookies.length === 0) {
    throw new Error(
      "沒有取得任何 LINE cookies。"
    );
  }

  const authState = {
    version: 1,
    exportedAt:
      new Date().toISOString(),
    chatUrl: chatUrl.href,
    cookies,
  };

  fs.mkdirSync(
    path.dirname(outputPath),
    { recursive: true }
  );

  fs.writeFileSync(
    outputPath,
    JSON.stringify(
      authState,
      null,
      2
    ),
    {
      encoding: "utf8",
      mode: 0o600,
    }
  );

  console.log(
    `已匯出 ${cookies.length} 個 cookies。`
  );
  console.log(
    `檔案：${outputPath}`
  );
  console.log(
    "此檔含有 LINE 登入狀態，請勿分享或提交版本控制。"
  );
} finally {
  await closeBrowser(browser);
}
