import fs from "node:fs";
import path from "node:path";

const DEFAULT_WORKER_URL =
  "https://line-oa-scheduler.clearbot-user-2026.workers.dev";

function readDevVariables() {
  const filepath = path.resolve(
    "cloudflare-worker",
    ".dev.vars"
  );

  if (!fs.existsSync(filepath)) {
    return {};
  }

  const variables = {};

  for (
    const sourceLine of
      fs.readFileSync(filepath, "utf8")
        .split(/\r?\n/)
  ) {
    const line = sourceLine.trim();

    if (
      !line ||
      line.startsWith("#")
    ) {
      continue;
    }

    const separator =
      line.indexOf("=");

    if (separator < 1) {
      continue;
    }

    const key = line.slice(
      0,
      separator
    ).trim();

    let value = line.slice(
      separator + 1
    ).trim();

    if (
      (value.startsWith('"') &&
        value.endsWith('"')) ||
      (value.startsWith("'") &&
        value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    variables[key] = value;
  }

  return variables;
}

const devVariables =
  readDevVariables();

const adminToken =
  process.env.ADMIN_TOKEN ||
  devVariables.ADMIN_TOKEN;

if (!adminToken) {
  throw new Error(
    "找不到 ADMIN_TOKEN，請在 cloudflare-worker/.dev.vars 設定。"
  );
}

const workerUrl = String(
  process.env.WORKER_URL ||
    DEFAULT_WORKER_URL
).replace(/\/$/, "");

console.log(
  "正在計算 Google Sheet 配對結果並透過 LINE Chat 傳送……"
);

const response = await fetch(
  `${workerUrl}/run/pair`,
  {
    method: "POST",
    headers: {
      authorization:
        `Bearer ${adminToken}`,
    },
  }
);

const text = await response.text();
let result;

try {
  result = JSON.parse(text);
} catch {
  result = {
    response: text,
  };
}

if (!response.ok) {
  throw new Error(
    `手動 pair 失敗（HTTP ${response.status}）：${result.error || text}`
  );
}

console.log(
  JSON.stringify(result, null, 2)
);
