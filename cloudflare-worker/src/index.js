import puppeteer from "@cloudflare/puppeteer";

import {
  DEFAULT_PAIRUP_CSV_URL,
  formatPairResult,
  pairupCsv,
  summarizeWorksheet,
} from "./pairup.js";

const AUTH_STATE_KEY =
  "line-auth-state";

const PENDING_CLEAR_NOTIFICATION_KEY =
  "pending-notification:clear";

// Cloudflare cron uses UTC. These are 07:00 and 17:05 in Asia/Taipei.
const CLEAR_CRON =
  "0 23 * * *";

const PAIR_CRON =
  "5 9 * * *";

const DEFAULT_SHEET_EDIT_URL =
  "https://docs.google.com/spreadsheets/d/19s78tQZO6-g5ph2sOiKDf1whIAt3fITZpoo5QeRf62A/edit";

const DEFAULT_SHEET_GID =
  "458839323";

const CLEAR_NOTIFICATION_MESSAGE = [
  "Hi everyone, 小企鵝 just updated the sheet, please fill it out before 17:00.😊",
  "https://docs.google.com/spreadsheets/d/19s78tQZO6-g5ph2sOiKDf1whIAt3fITZpoo5QeRf62A/edit",
].join("\n");

const CRON_ACTIONS =
  new Map([
    [CLEAR_CRON, "clear"],
    [PAIR_CRON, "pair"],
  ]);

function jsonResponse(
  body,
  status = 200
) {
  return Response.json(body, {
    status,
    headers: {
      "cache-control":
        "no-store",
    },
  });
}

function errorMessage(error) {
  return error instanceof Error
    ? error.message
    : String(error);
}

function wait(milliseconds) {
  return new Promise((resolve) =>
    setTimeout(resolve, milliseconds)
  );
}

async function closeBrowserAndPages(
  browser
) {
  if (!browser) {
    return;
  }

  try {
    const pages =
      await browser.pages();

    await Promise.allSettled(
      pages.map(async (page) => {
        if (!page.isClosed()) {
          await page.close({
            runBeforeUnload: false,
          });
        }
      })
    );
  } catch {}

  await browser
    .close()
    .catch(() => {});
}

function pageHostname(page) {
  try {
    return new URL(page.url())
      .hostname;
  } catch {
    return "";
  }
}

function pageMatchesTarget(
  page,
  targetUrl
) {
  try {
    const current =
      new URL(page.url());

    const target =
      new URL(targetUrl);

    if (
      current.hostname !==
        target.hostname
    ) {
      return false;
    }

    if (
      target.hostname ===
        "chat.line.biz"
    ) {
      return current.pathname
        .includes("/chat/");
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
  const deadline =
    Date.now() + timeout;

  while (Date.now() < deadline) {
    if (
      pageMatchesTarget(
        page,
        targetUrl
      )
    ) {
      return true;
    }

    await wait(250);
  }

  return false;
}

async function waitForHostnameChange(
  page,
  previousHostname,
  timeout = 30000
) {
  const deadline =
    Date.now() + timeout;

  while (Date.now() < deadline) {
    const hostname =
      pageHostname(page);

    if (
      hostname &&
      hostname !== previousHostname
    ) {
      return hostname;
    }

    await wait(250);
  }

  throw new Error(
    `點擊 LINE 登入後仍停在 ${previousHostname}。`
  );
}

async function recoverLineLogin(
  page,
  targetUrl
) {
  const targetHostname =
    new URL(targetUrl).hostname;

  let clicks = 0;

  for (
    let transition = 0;
    transition < 5 && clicks < 2;
    transition += 1
  ) {
    const hostname =
      pageHostname(page);

    if (
      pageMatchesTarget(
        page,
        targetUrl
      )
    ) {
      return clicks;
    }

    if (hostname === targetHostname) {
      if (
        await waitForTargetPage(
          page,
          targetUrl,
          10000
        )
      ) {
        return clicks;
      }

      await page.goto(targetUrl, {
        waitUntil:
          "domcontentloaded",
        timeout: 60000,
      });

      continue;
    }

    let selector;

    if (hostname === "account.line.biz") {
      // First click: the green LINE account button marked as the last login method.
      selector =
        "#login-btn-line button";
    } else if (
      hostname === "access.line.me"
    ) {
      // Second click: the remembered LINE account's Login button.
      const rememberedAccount =
        await page.$(
          'a[href*="/oauth2/v2.1/relogin"]'
        );

      if (!rememberedAccount) {
        throw new Error(
          "LINE 沒有保留上次登入帳號，需要人工重新登入。"
        );
      }

      selector =
        'button.c-button--allow[type="submit"]';
    } else {
      throw new Error(
        `LINE 登入跳到未預期的網域：${hostname || page.url()}`
      );
    }

    const button =
      await page.waitForSelector(
        selector,
        {
          timeout: 20000,
        }
      );

    if (!button) {
      throw new Error(
        `找不到 LINE 自動登入按鈕：${selector}`
      );
    }

    await button.evaluate(
      (element) => element.click()
    );

    clicks += 1;

    await waitForHostnameChange(
      page,
      hostname
    );
  }

  if (
    await waitForTargetPage(
      page,
      targetUrl,
      30000
    )
  ) {
    return clicks;
  }

  if (
    pageHostname(page) ===
      targetHostname
  ) {
    await page.goto(targetUrl, {
      waitUntil:
        "domcontentloaded",
      timeout: 60000,
    });

    if (
      await waitForTargetPage(
        page,
        targetUrl,
        15000
      )
    ) {
      return clicks;
    }
  }

  throw new Error(
    `LINE 自動登入兩步完成後未回到 ${targetHostname} 的聊天室頁面。`
  );
}

function isAuthorized(
  request,
  env
) {
  if (!env.ADMIN_TOKEN) {
    return false;
  }

  return (
    request.headers.get(
      "authorization"
    ) ===
    `Bearer ${env.ADMIN_TOKEN}`
  );
}

function normalizeAuthState(raw) {
  let state;

  try {
    state = JSON.parse(raw);
  } catch {
    throw new Error(
      "KV 裡的 LINE 登入狀態不是有效的 JSON。"
    );
  }

  if (
    !state ||
    state.version !== 1 ||
    !Array.isArray(state.cookies) ||
    state.cookies.length === 0
  ) {
    throw new Error(
      "KV 裡的 LINE 登入狀態不完整。"
    );
  }

  let chatUrl;

  try {
    chatUrl = new URL(
      state.chatUrl
    );
  } catch {
    throw new Error(
      "KV 登入狀態中的 chatUrl 無效。"
    );
  }

  if (
    chatUrl.protocol !== "https:" ||
    chatUrl.hostname !==
      "chat.line.biz"
  ) {
    throw new Error(
      "chatUrl 必須是 https://chat.line.biz 網址。"
    );
  }

  return {
    ...state,
    chatUrl: chatUrl.href,
  };
}

async function loadAuthState(env) {
  const raw =
    await env.LINE_STATE.get(
      AUTH_STATE_KEY
    );

  if (!raw) {
    throw new Error(
      "找不到 LINE 登入狀態，請重新匯出並上傳 cookies。"
    );
  }

  return normalizeAuthState(raw);
}

function cookieParams(cookies) {
  const now =
    Date.now() / 1000;

  return cookies
    .filter((cookie) => {
      const expires =
        Number(cookie.expires);

      return !(
        Number.isFinite(expires) &&
        expires > 0 &&
        expires <= now
      );
    })
    .map((cookie) => {
      const result = {
        name: String(
          cookie.name
        ),
        value: String(
          cookie.value
        ),
        domain: String(
          cookie.domain
        ),
        path:
          String(
            cookie.path || "/"
          ),
        httpOnly:
          Boolean(
            cookie.httpOnly
          ),
        secure:
          Boolean(
            cookie.secure
          ),
      };

      const expires =
        Number(cookie.expires);

      if (
        Number.isFinite(expires) &&
        expires > now
      ) {
        result.expires = expires;
      }

      if (
        [
          "Strict",
          "Lax",
          "None",
        ].includes(
          cookie.sameSite
        )
      ) {
        result.sameSite =
          cookie.sameSite;
      }

      return result;
    });
}

function mergeCookies(
  existingCookies,
  updatedCookies
) {
  const byIdentity =
    new Map();

  for (
    const cookie of [
      ...existingCookies,
      ...updatedCookies,
    ]
  ) {
    const identity = [
      cookie.name,
      cookie.domain,
      cookie.path || "/",
    ].join("\u0000");

    byIdentity.set(
      identity,
      cookie
    );
  }

  return [
    ...byIdentity.values(),
  ];
}

function splitLineMessage(
  message,
  maximumLength = 4500
) {
  if (
    message.length <= maximumLength
  ) {
    return [message];
  }

  const chunks = [];
  let current = "";

  for (const line of message.split("\n")) {
    const next = current
      ? `${current}\n${line}`
      : line;

    if (next.length <= maximumLength) {
      current = next;
      continue;
    }

    if (current) {
      chunks.push(current);
      current = "";
    }

    for (
      let offset = 0;
      offset < line.length;
      offset += maximumLength
    ) {
      const part = line.slice(
        offset,
        offset + maximumLength
      );

      if (part.length === maximumLength) {
        chunks.push(part);
      } else {
        current = part;
      }
    }
  }

  if (current) {
    chunks.push(current);
  }

  return chunks;
}

async function focusComposer(
  composer
) {
  await composer.evaluate(
    (host) => {
      const input =
        host.shadowRoot
          ?.querySelector(
            "textarea"
          );

      if (!input) {
        throw new Error(
          "找不到 LINE shadow textarea。"
        );
      }

      input.click();
      input.focus();
    }
  );
}

async function replaceComposerText(
  page,
  composer,
  text
) {
  await focusComposer(composer);

  await page.keyboard.down(
    "Control"
  );

  try {
    await page.keyboard.press(
      "KeyA"
    );
  } finally {
    await page.keyboard.up(
      "Control"
    );
  }

  await page.keyboard.press(
    "Backspace"
  );

  // Input.insertText inserts line breaks without triggering LINE's Enter-to-send.
  await page.keyboard.sendCharacter(
    text
  );
}

async function composerText(
  composer
) {
  return composer.evaluate(
    (host) =>
      String(
        host.shadowRoot
          ?.querySelector(
            "textarea"
          )?.value || ""
      )
  );
}

async function sendLineMessage(
  env,
  message
) {
  const checkOnly =
    message === null;

  if (
    !checkOnly &&
    (
      typeof message !== "string" ||
      message.length === 0
    )
  ) {
    throw new Error(
      "要傳送的 LINE 訊息不可為空。"
    );
  }

  const authState =
    await loadAuthState(env);

  const cookies =
    cookieParams(
      authState.cookies
    );

  if (cookies.length === 0) {
    throw new Error(
      "LINE 登入 cookies 已全部過期，請重新匯出登入狀態。"
    );
  }

  const browser =
    await puppeteer.launch(
      env.BROWSER
    );

  try {
    const pages =
      await browser.pages();

    const page =
      pages[0] ??
      await browser.newPage();

    await page.setCookie(
      ...cookies
    );

    await page.setViewport({
      width: 1920,
      height: 945,
    });

    page.setDefaultTimeout(
      30000
    );

    await page.goto(
      authState.chatUrl,
      {
        waitUntil:
          "domcontentloaded",
        timeout: 60000,
      }
    );

    const autoLoginClicks =
      await recoverLineLogin(
        page,
        authState.chatUrl
      );

    const composer =
      await page.waitForSelector(
        "textarea-ex#editor",
        {
          visible: true,
          timeout: 30000,
        }
      );

    if (!composer) {
      throw new Error(
        "已開啟 LINE Chat，但找不到訊息輸入框。"
      );
    }

    let messageCount = 0;

    if (!checkOnly) {
      const chunks =
        splitLineMessage(message);

      for (const chunk of chunks) {
        await replaceComposerText(
          page,
          composer,
          chunk
        );

        const typedText =
          await composerText(
            composer
          );

        if (typedText !== chunk) {
          throw new Error(
            "LINE 訊息輸入內容驗證失敗。"
          );
        }

        await page.keyboard.press(
          "Enter"
        );

        await page.waitForFunction(
          () => {
            const host =
              document.querySelector(
                "textarea-ex#editor"
              );

            return (
              host?.shadowRoot
                ?.querySelector(
                  "textarea"
                )?.value === ""
            );
          },
          {
            timeout: 15000,
          }
        );

        messageCount += 1;
        await wait(250);
      }
    }

    const updatedCookies =
      await page.cookies(
        authState.chatUrl,
        "https://manager.line.biz/",
        "https://account.line.biz/",
        "https://access.line.me/"
      );

    await env.LINE_STATE.put(
      AUTH_STATE_KEY,
      JSON.stringify({
        ...authState,
        refreshedAt:
          new Date()
            .toISOString(),
        cookies:
          mergeCookies(
            authState.cookies,
            updatedCookies
          ),
      })
    );

    if (checkOnly) {
      return {
        ok: true,
        loggedIn: true,
        composerFound: true,
        autoLoginClicks,
        checkedAt:
          new Date().toISOString(),
      };
    }

    return {
      ok: true,
      messageCount,
      autoLoginClicks,
      sentAt:
        new Date().toISOString(),
    };
  } catch (error) {
    if (
      errorMessage(error)
        .toLowerCase()
        .includes(
          "waiting for selector"
        )
    ) {
      throw new Error(
        "LINE 登入狀態可能已失效，無法載入訊息輸入框。"
      );
    }

    throw error;
  } finally {
    await closeBrowserAndPages(
      browser
    );
  }
}

function pairupCsvUrl(env) {
  return String(
    env.PAIRUP_CSV_URL ||
      DEFAULT_PAIRUP_CSV_URL
  );
}

async function fetchWorksheetCsv(env) {
  const url =
    new URL(pairupCsvUrl(env));

  url.searchParams.set(
    "pairup_cache_bust",
    String(Date.now())
  );

  const response = await fetch(
    url.href,
    {
      headers: {
        accept: "text/csv",
      },
      redirect: "follow",
    }
  );

  if (!response.ok) {
    throw new Error(
      `下載 Google Sheet CSV 失敗（HTTP ${response.status}）。`
    );
  }

  const source =
    await response.text();

  if (!source.trim()) {
    throw new Error(
      "下載到的 Google Sheet CSV 是空的。"
    );
  }

  return source;
}

async function sendPendingClearNotification(
  env
) {
  const raw =
    await env.LINE_STATE.get(
      PENDING_CLEAR_NOTIFICATION_KEY
    );

  if (!raw) {
    return null;
  }

  let notification;

  try {
    notification = JSON.parse(raw);
  } catch {
    throw new Error(
      "待補送的 clear 通知不是有效的 JSON。"
    );
  }

  if (
    !notification ||
    typeof notification.message !==
      "string" ||
    !notification.message
  ) {
    throw new Error(
      "待補送的 clear 通知內容不完整。"
    );
  }

  const sent =
    await sendLineMessage(
      env,
      notification.message
    );

  await env.LINE_STATE.delete(
    PENDING_CLEAR_NOTIFICATION_KEY
  );

  return {
    ...sent,
    notification,
  };
}

async function runPair(env) {
  const recoveredClearNotification =
    await sendPendingClearNotification(
      env
    );

  const source =
    await fetchWorksheetCsv(env);

  const result = pairupCsv(
    source,
    {
      enableFlex:
        String(
          env.PAIRUP_ENABLE_FLEX ||
            "false"
        ).toLowerCase() === "true",
    }
  );

  const message =
    formatPairResult(result);

  const sent =
    await sendLineMessage(
      env,
      message
    );

  return {
    ...sent,
    action: "pair",
    algorithm:
      result.algorithm,
    successfulRequests:
      result.successfulRequests,
    failedRequests:
      result.failedRequests,
    pairCount:
      result.pairs.length,
    singleCount:
      result.singles.length,
    recoveredClearNotification:
      Boolean(
        recoveredClearNotification
      ),
    message,
  };
}

function sheetEditUrl(
  env,
  range
) {
  const url = new URL(
    String(
      env.PAIRUP_SHEET_EDIT_URL ||
        DEFAULT_SHEET_EDIT_URL
    )
  );

  const gid = String(
    env.PAIRUP_SHEET_GID ||
      DEFAULT_SHEET_GID
  );

  url.search = "";
  url.hash =
    `gid=${encodeURIComponent(gid)}` +
    `&range=${encodeURIComponent(range)}`;

  return url.href;
}

async function clearGoogleSheet(
  env,
  snapshot
) {
  if (snapshot.filledCellCount === 0) {
    return snapshot;
  }

  const browser =
    await puppeteer.launch(
      env.BROWSER
    );

  try {
    const pages =
      await browser.pages();

    const page =
      pages[0] ??
      await browser.newPage();

    await page.setViewport({
      width: 1920,
      height: 945,
    });

    page.setDefaultTimeout(
      30000
    );

    await page.goto(
      sheetEditUrl(
        env,
        snapshot.clearRange
      ),
      {
        waitUntil:
          "domcontentloaded",
        timeout: 60000,
      }
    );

    const nameBox =
      await page.waitForSelector(
        "#t-name-box",
        {
          visible: true,
          timeout: 30000,
        }
      );

    if (!nameBox) {
      throw new Error(
        "Google Sheet 已開啟，但找不到範圍選擇框。"
      );
    }

    const selectedRange =
      await nameBox.evaluate(
        (element) =>
          String(element.value || "")
      );

    if (
      selectedRange !==
        snapshot.clearRange
    ) {
      await nameBox.click({
        clickCount: 3,
      });

      await page.keyboard.down(
        "Control"
      );

      try {
        await page.keyboard.press(
          "KeyA"
        );
      } finally {
        await page.keyboard.up(
          "Control"
        );
      }

      await page.keyboard.type(
        snapshot.clearRange
      );

      await page.keyboard.press(
        "Enter"
      );

      await page.waitForFunction(
        (expected) =>
          document.querySelector(
            "#t-name-box"
          )?.value === expected,
        {},
        snapshot.clearRange
      );
    }

    await page.keyboard.press(
      "Backspace"
    );

    // Give Google Sheets time to apply and save the anonymous edit.
    await wait(3000);
  } finally {
    await closeBrowserAndPages(
      browser
    );
  }

  let latest = snapshot;

  for (
    let attempt = 0;
    attempt < 8;
    attempt += 1
  ) {
    const source =
      await fetchWorksheetCsv(env);

    latest =
      summarizeWorksheet(source);

    if (latest.filledCellCount === 0) {
      return latest;
    }

    await wait(1500);
  }

  throw new Error(
    `Google Sheet 清除後驗證失敗，C～R 還有 ${latest.filledCellCount} 格資料。`
  );
}

async function runClear(env) {
  const source =
    await fetchWorksheetCsv(env);

  const snapshot =
    summarizeWorksheet(source);

  await clearGoogleSheet(
    env,
    snapshot
  );

  const message =
    CLEAR_NOTIFICATION_MESSAGE;

  await env.LINE_STATE.put(
    PENDING_CLEAR_NOTIFICATION_KEY,
    JSON.stringify({
      action: "clear",
      createdAt:
        new Date().toISOString(),
      participantCount:
        snapshot.participantCount,
      clearedCellCount:
        snapshot.filledCellCount,
      clearedRange:
        snapshot.clearRange,
      message,
    }),
    {
      expirationTtl: 86400,
    }
  );

  const sent =
    await sendPendingClearNotification(
      env,
    );

  return {
    ...sent,
    action: "clear",
    participantCount:
      snapshot.participantCount,
    clearedCellCount:
      snapshot.filledCellCount,
    clearedRange:
      snapshot.clearRange,
    message,
  };
}

async function runAction(
  env,
  action
) {
  if (action === "pair") {
    return runPair(env);
  }

  if (action === "clear") {
    return runClear(env);
  }

  throw new Error(
    `不支援的動作：${action}`
  );
}

async function runAndRecord(
  env,
  action,
  source
) {
  const startedAt =
    new Date().toISOString();

  try {
    const result =
      await runAction(
        env,
        action
      );

    const record = {
      ...result,
      source,
      startedAt,
    };

    await env.LINE_STATE.put(
      `last-run:${action}`,
      JSON.stringify(record)
    );

    console.log(
      JSON.stringify(record)
    );

    return record;
  } catch (error) {
    const record = {
      ok: false,
      action,
      source,
      startedAt,
      failedAt:
        new Date().toISOString(),
      error:
        errorMessage(error),
    };

    await env.LINE_STATE.put(
      `last-run:${action}`,
      JSON.stringify(record)
    );

    console.error(
      JSON.stringify(record)
    );

    throw error;
  }
}

async function authStatus(env) {
  const raw =
    await env.LINE_STATE.get(
      AUTH_STATE_KEY
    );

  if (!raw) {
    return {
      configured: false,
    };
  }

  try {
    const state =
      normalizeAuthState(raw);

    return {
      configured: true,
      cookieCount:
        state.cookies.length,
      exportedAt:
        state.exportedAt,
      refreshedAt:
        state.refreshedAt,
    };
  } catch (error) {
    return {
      configured: false,
      error:
        errorMessage(error),
    };
  }
}

export default {
  async scheduled(
    controller,
    env
  ) {
    const action =
      CRON_ACTIONS.get(
        controller.cron
      );

    if (!action) {
      console.warn(
        `未知排程：${controller.cron}`
      );
      return;
    }

    await runAndRecord(
      env,
      action,
      `cron:${controller.cron}`
    );
  },

  async fetch(request, env) {
    const url =
      new URL(request.url);

    if (
      request.method === "GET" &&
      (url.pathname === "/" ||
        url.pathname ===
          "/health")
    ) {
      return jsonResponse({
        ok: true,
        service:
          "line-oa-scheduler",
        timezone:
          "Asia/Taipei",
        schedules: [
          {
            localTime: "07:00",
            cronUtc: CLEAR_CRON,
            action: "clear",
            enabled: true,
            behavior:
              "清除 Google Sheet C～R 會員填答區並傳送結果；不可手動執行",
          },
          {
            localTime: "17:05",
            cronUtc: PAIR_CRON,
            action: "pair",
            enabled: true,
            behavior:
              "計算配對結果並傳送；可手動測試",
          },
        ],
      });
    }

    if (!isAuthorized(
      request,
      env
    )) {
      return jsonResponse(
        {
          ok: false,
          error:
            env.ADMIN_TOKEN
              ? "Unauthorized"
              : "ADMIN_TOKEN 尚未設定",
        },
        env.ADMIN_TOKEN
          ? 401
          : 503
      );
    }

    if (
      request.method === "GET" &&
      url.pathname ===
        "/auth/status"
    ) {
      return jsonResponse(
        await authStatus(env)
      );
    }

    if (
      request.method === "GET" &&
      url.pathname === "/check"
    ) {
      try {
        return jsonResponse(
          await sendLineMessage(
            env,
            null
          )
        );
      } catch (error) {
        return jsonResponse(
          {
            ok: false,
            error:
              errorMessage(error),
          },
          500
        );
      }
    }

    if (
      request.method === "POST" &&
      url.pathname === "/run/pair"
    ) {
      try {
        return jsonResponse(
          await runAndRecord(
            env,
            "pair",
            "manual"
          )
        );
      } catch (error) {
        return jsonResponse(
          {
            ok: false,
            error:
              errorMessage(error),
          },
          500
        );
      }
    }

    return jsonResponse(
      {
        ok: false,
        error: "Not found",
      },
      404
    );
  },
};
