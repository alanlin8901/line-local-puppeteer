import puppeteer from "@cloudflare/puppeteer";

const AUTH_STATE_KEY =
  "line-auth-state";

const CLEAR_CRON =
  "0 23 * * *";

const PAIR_CRON =
  "5 9 * * *";

const CRON_COMMANDS =
  new Map([
    [CLEAR_CRON, "clear"],
    [PAIR_CRON, "pair"],
  ]);

const ALLOWED_COMMANDS =
  new Set([
    "clear",
    "pair",
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
      "KV 中的 LINE 登入狀態不是有效 JSON。"
    );
  }

  if (
    !state ||
    state.version !== 1 ||
    !Array.isArray(state.cookies) ||
    state.cookies.length === 0
  ) {
    throw new Error(
      "KV 中的 LINE 登入狀態格式不正確。"
    );
  }

  let chatUrl;

  try {
    chatUrl = new URL(
      state.chatUrl
    );
  } catch {
    throw new Error(
      "KV 登入狀態缺少有效的 chatUrl。"
    );
  }

  if (
    chatUrl.protocol !== "https:" ||
    chatUrl.hostname !==
      "chat.line.biz"
  ) {
    throw new Error(
      "chatUrl 必須指向 https://chat.line.biz。"
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
      [
        "尚未上傳 LINE 登入狀態。",
        "請先執行 npm run cloudflare:auth:export，",
        "再於 cloudflare-worker 執行 npm run auth:upload。",
      ].join(" ")
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
          "LINE shadow textarea 不存在。"
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

  await page.keyboard.type(text, {
    delay: 35,
  });
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

async function sendLineCommand(
  env,
  command
) {
  const checkOnly =
    command === null;

  if (
    !checkOnly &&
    !ALLOWED_COMMANDS.has(command)
  ) {
    throw new Error(
      `不支援的指令：${command}`
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
      "LINE 登入 cookies 已全部過期，請重新匯出。"
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

    // Cloudflare 的 Puppeteer fork 目前由 Page 提供
    // setCookie/cookies，而不是 BrowserContext。
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

    if (!checkOnly) {
      await replaceComposerText(
        page,
        composer,
        command
      );

      const typedText =
        await composerText(
          composer
        );

      if (typedText !== command) {
        throw new Error(
          "LINE 訊息輸入驗證失敗。"
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
    }

    const updatedCookies =
      await page.cookies(
        authState.chatUrl,
        "https://manager.line.biz/"
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
        checkedAt:
          new Date().toISOString(),
      };
    }

    return {
      ok: true,
      command,
      sentAt:
        new Date().toISOString(),
    };
  } catch (error) {
    if (
      errorMessage(error)
        .includes(
          "waiting for selector"
        )
    ) {
      throw new Error(
        "LINE 登入可能已失效，或聊天頁載入逾時。"
      );
    }

    throw error;
  } finally {
    await browser
      .close()
      .catch(() => {});
  }
}

async function runAndRecord(
  env,
  command,
  source
) {
  const startedAt =
    new Date().toISOString();

  try {
    const result =
      await sendLineCommand(
        env,
        command
      );

    const record = {
      ...result,
      source,
      startedAt,
    };

    await env.LINE_STATE.put(
      `last-run:${command}`,
      JSON.stringify(record)
    );

    console.log(
      JSON.stringify(record)
    );

    return record;
  } catch (error) {
    const record = {
      ok: false,
      command,
      source,
      startedAt,
      failedAt:
        new Date().toISOString(),
      error:
        errorMessage(error),
    };

    await env.LINE_STATE.put(
      `last-run:${command}`,
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
    const command =
      CRON_COMMANDS.get(
        controller.cron
      );

    if (!command) {
      console.warn(
        `忽略未知排程：${controller.cron}`
      );
      return;
    }

    await runAndRecord(
      env,
      command,
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
            command: "clear",
          },
          {
            localTime: "17:05",
            cronUtc: PAIR_CRON,
            command: "pair",
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
          await sendLineCommand(
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

    const match =
      url.pathname.match(
        /^\/run\/(clear|pair)$/
      );

    if (
      request.method === "POST" &&
      match
    ) {
      try {
        return jsonResponse(
          await runAndRecord(
            env,
            match[1],
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
