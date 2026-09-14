import {
  loadConfig,
  launchBrowser,
  closeBrowser,
  sleep,
  saveDebugScreenshot,
  findComposer,
  recoverLineLogin,
} from "./common.js";

const config = loadConfig();
const browser = await launchBrowser(config);

try {
  const pages = await browser.pages();
  const page = pages[0] ?? await browser.newPage();

  console.log(`開啟聊天室：${config.chatUrl}`);

  await page.goto(config.chatUrl, {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });

  const autoLoginClicks = await recoverLineLogin(
    page,
    config.chatUrl
  );

  await sleep(config.waitAfterOpenMs);

  if (autoLoginClicks > 0) {
    console.log(`已自動完成 ${autoLoginClicks} 個 LINE 登入步驟`);
  }

  console.log(`目前 URL：${page.url()}`);

  if (!page.url().includes("/chat/")) {
    const screenshot = await saveDebugScreenshot(
      page,
      "chat-open-failed"
    );

    throw new Error(
      [
        "沒有停在目標聊天室。",
        `目前 URL: ${page.url()}`,
        `截圖: ${screenshot}`,
        "請先執行 npm run login，手動進入一次目標聊天室。",
      ].join("\n")
    );
  }

  const composer = await findComposer(page);

  if (!composer) {
    const screenshot = await saveDebugScreenshot(
      page,
      "composer-not-found"
    );

    throw new Error(
      [
        "已進入聊天室，但找不到訊息輸入框。",
        `截圖: ${screenshot}`,
      ].join("\n")
    );
  }

  console.log("✅ 已保持登入");
  console.log("✅ 已停在目標聊天室");
  console.log("✅ 找到訊息輸入框");
} catch (error) {
  console.error("");
  console.error(
    error instanceof Error ? error.stack || error.message : String(error)
  );
  process.exitCode = 1;
} finally {
  await closeBrowser(browser);
}
