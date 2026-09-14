import {
  loadConfig,
  launchBrowser,
  closeBrowser,
  sleep,
  saveDebugScreenshot,
  recoverLineLogin,
} from "./common.js";

const message =
  process.argv.slice(2).join(" ").trim();

if (!message) {
  console.error(
    "請指定訊息，例如：node src/send.js pair"
  );
  process.exit(1);
}

const config = loadConfig();

const accountName =
  config.accountName || "ice cream";

const conversationName =
  config.conversationName || "Ram";

const browser = await launchBrowser({
  ...config,
  headless: false,
});


async function getManagerPage() {
  for (let i = 0; i < 20; i++) {
    const pages = await browser.pages();

    const page =
      pages.find((p) =>
        p.url().includes("manager.line.biz")
      );

    if (page) {
      return page;
    }

    await sleep(500);
  }

  return null;
}


async function clickVisibleText(
  page,
  text,
  timeout = 20000,
  options = {}
) {
  const {
    ignoreTrailingCount = false,
    rootSelector = null,
  } = options;

  const start = Date.now();

  while (
    Date.now() - start <
    timeout
  ) {
    try {
      const result =
        await page.evaluate(
          ({
            wantedText,
            ignoreTrailingCount,
            rootSelector,
          }) => {
            const normalize = (value) =>
              String(value || "")
                .replace(/\s+/g, " ")
                .trim();

            const comparableText =
              (value) => {
                const normalized =
                  normalize(value);

                if (
                  !ignoreTrailingCount
                ) {
                  return normalized;
                }

                // 未讀數可能顯示為 Ram(2)、Ram (2)
                // 或 Ram(2) (2)，比對時只保留名稱本體。
                return normalized
                  .replace(
                    /(?:\s*[\(（]\s*\d+\s*[\)）])+\s*$/,
                    ""
                  )
                  .trim();
              };

            const root =
              rootSelector
                ? document.querySelector(
                    rootSelector
                  )
                : document;

            if (!root) {
              return false;
            }

            const elements = [
              ...root.querySelectorAll(
                `
                a,
                button,
                [role="button"],
                [tabindex],
                div,
                span,
                h1,
                h2,
                h3,
                h4,
                h5,
                h6
                `
              ),
            ];

            const candidates =
              elements.filter((el) => {
                const rect =
                  el.getBoundingClientRect();

                const style =
                  getComputedStyle(el);

                const visible =
                  rect.width > 0 &&
                  rect.height > 0 &&
                  style.display !== "none" &&
                  style.visibility !==
                    "hidden";

                return (
                  visible &&
                  comparableText(
                    el.textContent
                  ) ===
                    comparableText(
                      wantedText
                    )
                );
              });

            if (
              candidates.length === 0
            ) {
              return false;
            }

            // 優先選尺寸最小、文字最精確的元素
            candidates.sort(
              (a, b) => {
                const ra =
                  a.getBoundingClientRect();

                const rb =
                  b.getBoundingClientRect();

                return (
                  ra.width *
                    ra.height -
                  rb.width *
                    rb.height
                );
              }
            );

            let target =
              candidates[0];

            const clickable =
              target.closest(
                `
                a,
                button,
                [role="button"]
                `
              );

            if (clickable) {
              target = clickable;
            }

            target.scrollIntoView({
              block: "center",
              inline: "center",
            });

            target.click();

            return true;
          },
          {
            wantedText: text,
            ignoreTrailingCount,
            rootSelector,
          }
        );

      if (result) {
        return true;
      }
    } catch (error) {
      const msg =
        error instanceof Error
          ? error.message
          : String(error);

      if (
        !msg.includes(
          "detached Frame"
        ) &&
        !msg.includes(
          "Execution context was destroyed"
        )
      ) {
        throw error;
      }
    }

    await sleep(500);
  }

  return false;
}


async function waitForChatPage() {
  for (
    let i = 0;
    i < 40;
    i++
  ) {
    const pages =
      await browser.pages();

    for (const page of pages) {
      const url =
        page.url();

      try {
        const parsed = new URL(url);

        if (
          parsed.hostname ===
            "chat.line.biz" &&
          parsed.pathname.includes(
            "/chat/"
          )
        ) {
          return page;
        }
      } catch {}
    }

    await sleep(500);
  }

  return null;
}


async function findComposer(page) {
  const selectors = [
    "textarea-ex",
    "textarea",
    '[contenteditable="true"]',
    '[contenteditable="plaintext-only"]',
    '[role="textbox"]',
  ];

  let best = null;
  let bestScore =
    -Infinity;

  for (
    const frame of page.frames()
  ) {
    for (
      const selector of selectors
    ) {
      const elements =
        await frame.$$(selector);

      for (
        const el of elements
      ) {
        try {
          const info =
            await el.evaluate(
              (node) => {
                const rect =
                  node
                    .getBoundingClientRect();

                const style =
                  getComputedStyle(
                    node
                  );

                return {
                  visible:
                    rect.width >
                      80 &&
                    rect.height >
                      10 &&
                    style.display !==
                      "none" &&
                    style.visibility !==
                      "hidden",

                  y: rect.y,

                  width:
                    rect.width,

                  placeholder:
                    (
                      node.getAttribute(
                        "placeholder"
                      ) ||
                      node.getAttribute(
                        "aria-label"
                      ) ||
                      ""
                    ).toLowerCase(),

                  contenteditable:
                    node.getAttribute(
                      "contenteditable"
                    ),

                  role:
                    node.getAttribute(
                      "role"
                    ),

                  tag:
                    node.tagName
                      .toLowerCase(),
                };
              }
            );

          if (
            !info.visible
          ) {
            continue;
          }

          let score =
            info.y * 2;

          if (
            info.placeholder.includes(
              "message"
            ) ||
            info.placeholder.includes(
              "訊息"
            ) ||
            info.placeholder.includes(
              "輸入"
            ) ||
            info.placeholder.includes(
              "メッセージ"
            )
          ) {
            score += 10000;
          }

          if (
            info.role ===
            "textbox"
          ) {
            score += 3000;
          }

          if (
            info.contenteditable ===
              "true" ||
            info.contenteditable ===
              "plaintext-only"
          ) {
            score += 3000;
          }

          if (
            info.tag ===
            "textarea"
          ) {
            score += 2000;
          }

          // LINE OA Manager 目前使用帶有 shadow DOM 的
          // <textarea-ex> 自訂元件作為訊息輸入框。
          if (
            info.tag ===
            "textarea-ex"
          ) {
            score += 4000;
          }

          // 聊天輸入框通常很寬
          score +=
            info.width;

          if (
            score >
            bestScore
          ) {
            bestScore =
              score;

            best = el;
          }
        } catch {}
      }
    }
  }

  return best;
}


async function inputMessage(
  page,
  composer,
  text
) {
  await composer.evaluate(
    (el) => {
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
    }
  );

  // 用真實鍵盤事件清空，讓原生 textarea、contenteditable
  // 與 LINE 的 textarea-ex 都能收到框架所需的事件。
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
      delay: 50,
    }
  );
}


try {
  //
  // 1. 開 Manager 首頁
  //

  const initialPages =
    await browser.pages();

  let managerPage =
    initialPages[0] ??
    await browser.newPage();

  console.log(
    "① 開啟 LINE Official Account Manager..."
  );

  await managerPage.goto(
    "https://manager.line.biz/",
    {
      waitUntil:
        "domcontentloaded",
      timeout: 60000,
    }
  );

  await recoverLineLogin(
    managerPage,
    "https://manager.line.biz/"
  );

  await sleep(4000);

  managerPage =
    await getManagerPage();

  if (!managerPage) {
    throw new Error(
      "找不到 LINE Manager 頁面。"
    );
  }

  console.log(
    `目前 Manager URL：${managerPage.url()}`
  );


  //
  // 2. 如果在帳號列表，點 ice cream
  //

  console.log(
    `② 尋找帳號「${accountName}」...`
  );

  const accountClicked =
    await clickVisibleText(
      managerPage,
      accountName,
      8000
    );

  if (accountClicked) {
    console.log(
      `✅ 已點擊帳號：${accountName}`
    );

    await sleep(5000);

    managerPage =
      await getManagerPage();

    if (!managerPage) {
      throw new Error(
        "進入帳號後找不到 Manager 頁面。"
      );
    }
  } else {
    console.log(
      "目前可能已經在帳號管理頁，跳過帳號選擇。"
    );
  }

  console.log(
    `Manager URL：${managerPage.url()}`
  );


  //
  // 3. 點上方「聊天」
  //

  console.log(
    "③ 點擊上方「聊天」..."
  );

  const chatClicked =
    await clickVisibleText(
      managerPage,
      "聊天",
      15000
    );

  if (!chatClicked) {
    const screenshot =
      await saveDebugScreenshot(
        managerPage,
        "manager-chat-not-found"
      );

    throw new Error(
      [
        "找不到 LINE Manager 上方的「聊天」。",
        `截圖：${screenshot}`,
      ].join("\n")
    );
  }

  console.log(
    "✅ 已點擊聊天"
  );


  //
  // 4. 等新 chat.line.biz 分頁
  //

  console.log(
    "④ 等待 LINE Chat 新分頁..."
  );

  const chatPage =
    await waitForChatPage();

  if (!chatPage) {
    throw new Error(
      "沒有偵測到 chat.line.biz 分頁。"
    );
  }

  await chatPage.bringToFront();

  console.log(
    `✅ Chat URL：${chatPage.url()}`
  );

  await sleep(5000);


  //
  // 5. 點目標聊天室（忽略名稱後面的未讀數）
  //

  console.log(
    `⑤ 點擊聊天室「${conversationName}」...`
  );

  const roomClicked =
    await clickVisibleText(
      chatPage,
      conversationName,
      20000,
      {
        ignoreTrailingCount:
          true,
        rootSelector:
          "#content-primary",
      }
    );

  if (!roomClicked) {
    const screenshot =
      await saveDebugScreenshot(
        chatPage,
        "conversation-not-found"
      );

    throw new Error(
      [
        `找不到聊天室：${conversationName}`,
        `截圖：${screenshot}`,
      ].join("\n")
    );
  }

  console.log(
    `✅ 已點擊聊天室：${conversationName}`
  );

  await sleep(4000);


  //
  // 6. 找訊息輸入框
  //

  console.log(
    "⑥ 尋找訊息輸入框..."
  );

  const composer =
    await findComposer(
      chatPage
    );

  if (!composer) {
    const screenshot =
      await saveDebugScreenshot(
        chatPage,
        "composer-not-found"
      );

    throw new Error(
      [
        "找不到 LINE 訊息輸入框。",
        `截圖：${screenshot}`,
      ].join("\n")
    );
  }

  console.log(
    "✅ 找到訊息輸入框"
  );


  //
  // 7. 輸入訊息
  //

  console.log(
    `⑦ 輸入：${message}`
  );

  await inputMessage(
    chatPage,
    composer,
    message
  );

  await sleep(500);


  //
  // 8. Enter 送出
  //

  console.log(
    `⑧ 送出：${message}`
  );

  await chatPage
    .keyboard
    .press("Enter");

  await sleep(
    config.waitAfterSendMs ??
      1500
  );

  console.log("");
  console.log(
    `✅ 完成：${message}`
  );

} catch (error) {
  console.error("");
  console.error(
    error instanceof Error
      ? error.stack ||
          error.message
      : String(error)
  );

  process.exitCode = 1;

} finally {
  await closeBrowser(browser);
}
