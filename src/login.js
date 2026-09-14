import {
  launchBrowser,
  closeBrowser,
  sleep,
} from "./common.js";

const browser = await launchBrowser({
  headless: false,
});

let shuttingDown = false;

async function shutdown() {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;
  await closeBrowser(browser);
  process.exit(0);
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

try {
  const pages = await browser.pages();

  const managerPage =
    pages[0] ?? await browser.newPage();

  await managerPage.goto(
    "https://manager.line.biz/",
    {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    }
  );

  console.log("");
  console.log("請完成 LINE 登入。");
  console.log(
    "登入後先不要關 CMD，接著手動按「聊天」。"
  );
  console.log("");

  browser.on(
    "targetcreated",
    async (target) => {
      if (target.type() !== "page") {
        return;
      }

      const newPage =
        await target.page();

      if (!newPage) {
        return;
      }

      console.log("");
      console.log(
        `偵測到新分頁：${newPage.url()}`
      );

      // LINE 通常一開始是 about:blank
      for (
        let i = 0;
        i < 30;
        i++
      ) {
        const url =
          newPage.url();

        console.log(
          `等待聊天頁：${url}`
        );

        if (
          url !== "about:blank" &&
          url.startsWith(
            "https://chat.line.biz/"
          )
        ) {
          console.log("");
          console.log(
            "✅ LINE Chat 已載入"
          );
          console.log(
            `URL: ${url}`
          );

          await newPage
            .bringToFront();

          return;
        }

        await sleep(500);
      }

      console.log(
        "⚠ 新分頁一直停在 about:blank"
      );
    }
  );

  while (browser.connected) {
    await sleep(1000);
  }
} catch (error) {
  console.error(error);
  await closeBrowser(browser);
}
