import fs from "node:fs";
import path from "node:path";
import puppeteer from "puppeteer";

const ROOT = path.resolve(process.cwd());
export const PROFILE_DIR = path.join(ROOT, "line-profile");
export const SCREENSHOT_DIR = path.join(ROOT, "screenshots");
export const CONFIG_PATH = path.join(ROOT, "config.json");

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function pageHostname(page) {
  try {
    return new URL(page.url()).hostname;
  } catch {
    return "";
  }
}

function pageMatchesTarget(page, targetUrl) {
  try {
    const current = new URL(page.url());
    const target = new URL(targetUrl);

    if (current.hostname !== target.hostname) {
      return false;
    }

    if (target.hostname === "chat.line.biz") {
      return current.pathname.includes("/chat/");
    }

    return true;
  } catch {
    return false;
  }
}

async function waitForTargetPage(
  page,
  targetUrl,
  timeout = 30000
) {
  const deadline = Date.now() + timeout;

  while (Date.now() < deadline) {
    if (pageMatchesTarget(page, targetUrl)) {
      return true;
    }

    await sleep(250);
  }

  return false;
}

async function waitForHostnameChange(
  page,
  previousHostname,
  timeout = 30000
) {
  const deadline = Date.now() + timeout;

  while (Date.now() < deadline) {
    const hostname = pageHostname(page);

    if (hostname && hostname !== previousHostname) {
      return hostname;
    }

    await sleep(250);
  }

  throw new Error(
    `點擊 LINE 登入後仍停在 ${previousHostname}。`
  );
}

export async function recoverLineLogin(
  page,
  targetUrl
) {
  const targetHostname = new URL(targetUrl).hostname;
  let clicks = 0;

  for (
    let transition = 0;
    transition < 5 && clicks < 2;
    transition += 1
  ) {
    const hostname = pageHostname(page);

    if (pageMatchesTarget(page, targetUrl)) {
      return clicks;
    }

    if (hostname === targetHostname) {
      if (await waitForTargetPage(page, targetUrl, 10000)) {
        return clicks;
      }

      await page.goto(targetUrl, {
        waitUntil: "domcontentloaded",
        timeout: 60000,
      });

      continue;
    }

    let selector;

    if (hostname === "account.line.biz") {
      selector = "#login-btn-line button";
    } else if (hostname === "access.line.me") {
      const rememberedAccount = await page.$(
        'a[href*="/oauth2/v2.1/relogin"]'
      );

      if (!rememberedAccount) {
        throw new Error(
          "LINE 沒有保留上次登入帳號，需要人工重新登入。"
        );
      }

      selector = 'button.c-button--allow[type="submit"]';
    } else {
      throw new Error(
        `LINE 登入跳到未預期的網域：${hostname || page.url()}`
      );
    }

    const button = await page.waitForSelector(selector, {
      timeout: 20000,
    });

    if (!button) {
      throw new Error(
        `找不到 LINE 自動登入按鈕：${selector}`
      );
    }

    await button.evaluate((element) => element.click());
    clicks += 1;
    await waitForHostnameChange(page, hostname);
  }

  if (await waitForTargetPage(page, targetUrl, 30000)) {
    return clicks;
  }

  if (pageHostname(page) === targetHostname) {
    await page.goto(targetUrl, {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });

    if (await waitForTargetPage(page, targetUrl, 15000)) {
      return clicks;
    }
  }

  throw new Error(
    `LINE 自動登入兩步完成後未回到 ${targetHostname} 的聊天室頁面。`
  );
}

export function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    throw new Error(
      [
        "找不到 config.json。",
        "請先把 config.example.json 複製成 config.json，",
        "再把 chatUrl 改成你的目標聊天室網址。",
      ].join("\n")
    );
  }

  const config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));

  return {
    accountName:
      config.accountName ||
      "ice cream",

    conversationName:
      config.conversationName ||
      "Ram",

    chatUrl:
      String(
        config.chatUrl || ""
      ).trim(),

    headless:
      Boolean(
        config.headless
      ),

    waitAfterOpenMs:
      Number(
        config.waitAfterOpenMs ??
        4000
      ),

    waitAfterSendMs:
      Number(
        config.waitAfterSendMs ??
        1500
      ),
  };
}

export async function launchBrowser(config = {}) {
  return await puppeteer.launch({
    headless: config.headless ?? false,
    userDataDir: PROFILE_DIR,
    defaultViewport: null,
    args: ["--start-maximized"],
  });
}

export async function closeBrowser(browser) {
  if (!browser) {
    return;
  }

  // 先明確關閉所有 Manager / Chat 分頁，避免 Chrome
  // 將它們保留到下一次啟動。
  try {
    const pages =
      await browser.pages();

    await Promise.allSettled(
      pages.map((page) =>
        Promise.race([
          page.close({
            runBeforeUnload: false,
          }),
          sleep(2000),
        ])
      )
    );
  } catch {}

  if (!browser.connected) {
    return;
  }

  const browserProcess =
    browser.process();

  let closed = false;

  try {
    await Promise.race([
      browser.close().then(() => {
        closed = true;
      }),
      sleep(5000),
    ]);
  } catch {}

  // 正常關閉若被頁面或 Chrome 卡住，只終止這次由
  // Puppeteer 啟動的瀏覽器程序。
  if (
    !closed &&
    browser.connected &&
    browserProcess &&
    !browserProcess.killed
  ) {
    browserProcess.kill();
  }
}

export async function saveDebugScreenshot(page, prefix = "debug") {
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

  const stamp = new Date()
    .toISOString()
    .replaceAll(":", "-")
    .replaceAll(".", "-");

  const filepath = path.join(
    SCREENSHOT_DIR,
    `${prefix}-${stamp}.png`
  );

  await page.screenshot({
    path: filepath,
    fullPage: false,
  });

  return filepath;
}

export async function findComposer(page) {
  const selectors = [
    "textarea-ex",
    "textarea",
    '[contenteditable="true"]',
    '[role="textbox"]',
    '[contenteditable="plaintext-only"]',
  ];

  const frames = page.frames();

  console.log(`偵測到 ${frames.length} 個 frame`);

  let best = null;
  let bestScore = -Infinity;

  for (const frame of frames) {
    console.log(`檢查 frame: ${frame.url()}`);

    for (const selector of selectors) {
      const candidates =
        await frame.$$(selector);

      for (const handle of candidates) {
        try {
          const info =
            await handle.evaluate((el) => {
              const rect =
                el.getBoundingClientRect();

              const style =
                window.getComputedStyle(el);

              const placeholder = (
                el.getAttribute("placeholder") ||
                el.getAttribute("aria-label") ||
                ""
              ).toLowerCase();

              const text = (
                el.textContent || ""
              ).toLowerCase();

              const visible =
                rect.width > 30 &&
                rect.height > 5 &&
                style.visibility !== "hidden" &&
                style.display !== "none";

              return {
                visible,
                x: rect.x,
                y: rect.y,
                width: rect.width,
                height: rect.height,
                placeholder,
                text,
                tag:
                  el.tagName.toLowerCase(),
                role:
                  el.getAttribute("role"),
                contenteditable:
                  el.getAttribute(
                    "contenteditable"
                  ),
              };
            });

          if (!info.visible) {
            continue;
          }

          console.log(
            "候選輸入框:",
            selector,
            info
          );

          let score = info.y;

          // 越靠頁面底部越像聊天輸入框
          score += info.y * 2;

          if (
            info.placeholder.includes(
              "message"
            ) ||
            info.placeholder.includes(
              "訊息"
            ) ||
            info.placeholder.includes(
              "メッセージ"
            ) ||
            info.placeholder.includes(
              "輸入"
            )
          ) {
            score += 10000;
          }

          if (
            info.role === "textbox"
          ) {
            score += 2000;
          }

          if (
            info.contenteditable ===
              "true" ||
            info.contenteditable ===
              "plaintext-only"
          ) {
            score += 2000;
          }

          if (
            info.tag === "textarea"
          ) {
            score += 1000;
          }

          // LINE OA Manager 目前使用帶有 shadow DOM 的
          // <textarea-ex> 自訂元件作為訊息輸入框。
          if (
            info.tag ===
            "textarea-ex"
          ) {
            score += 4000;
          }

          if (
            score > bestScore
          ) {
            bestScore = score;
            best = handle;
          }
        } catch {}
      }
    }
  }

  return best;
}

export async function getComposerText(handle) {
  return await handle.evaluate((el) => {
    const input =
      el.shadowRoot?.querySelector(
        `
        textarea,
        input,
        [contenteditable="true"],
        [contenteditable="plaintext-only"]
        `
      ) || el;

    if ("value" in input) {
      return String(input.value || "");
    }

    return String(input.textContent || "");
  });
}

export async function setComposerText(
  page,
  handle,
  text
) {
  await handle.evaluate((el) => {
    const input =
      el.shadowRoot?.querySelector(
        `
        textarea,
        input,
        [contenteditable="true"],
        [contenteditable="plaintext-only"]
        `
      ) || el;

    input.click();
    input.focus();
  });

  const selectAllModifier =
    process.platform === "darwin"
      ? "Meta"
      : "Control";

  await page.keyboard.down(
    selectAllModifier
  );

  try {
    await page.keyboard.press(
      "KeyA"
    );
  } finally {
    await page.keyboard.up(
      selectAllModifier
    );
  }

  await page.keyboard.press(
    "Backspace"
  );

  await page.keyboard.type(
    text,
    {
      delay: 35,
    }
  );
}
