/*
 * JavaScript port of the pairing and text-formatting behavior from pairup.c.
 * pairup.c is Copyright its contributors and licensed under GPL-3.0.
 * The unmodified source supplied for this project is kept in vendor/pairup.c-master.
 */

export const DEFAULT_PAIRUP_CSV_URL =
  "https://docs.google.com/spreadsheets/d/19s78tQZO6-g5ph2sOiKDf1whIAt3fITZpoo5QeRf62A/export?format=csv&id=19s78tQZO6-g5ph2sOiKDf1whIAt3fITZpoo5QeRf62A&gid=458839323";

const FIELD_COL_NAME = 0;
const FIELD_COL_START = 2;
const FIELD_COL_END = 16;
const FIELD_COL_FLEX = 17;

const ONCE_SIGNS = new Set([
  "1",
  "１",
  "v",
  "ｖ",
  "x",
  "ｘ",
  "once",
]);

const TWICE_SIGNS = new Set([
  "2",
  "２",
  "twice",
]);

const ALGORITHMS = [
  ["LEAST_AVAILABILITY_PRIORITY", (a, b) => a.member.availability - b.member.availability],
  ["MOST_AVAILABILITY_PRIORITY", (a, b) => b.member.availability - a.member.availability],
  ["SMALLEST_ROW_ID_PRIORITY", (a, b) => a.member.id - b.member.id],
  ["LARGEST_ROW_ID_PRIORITY", (a, b) => b.member.id - a.member.id],
  ["EARLIEST_AVAILABLE_SLOT_PRIORITY", (a, b) => a.member.earliestSlot - b.member.earliestSlot],
  ["LEAST_REQUEST_PRIORITY", (a, b) => a.member.requests - b.member.requests],
  ["LATEST_AVAILABLE_SLOT_PRIORITY", (a, b) => b.member.earliestSlot - a.member.earliestSlot],
  ["LEAST_PARTNER_PRIORITY", (a, b) => a.count - b.count],
  ["MOST_PARTNER_PRIORITY", (a, b) => b.count - a.count],
  ["MOST_REQUEST_PRIORITY", (a, b) => b.member.requests - a.member.requests],
];

const NO_PAIRS_MESSAGE =
  "Dear all, there were no successful pairs today.💤 Maybe you can review your available time again!";

const ALTERNATIVES_MESSAGE = [
  " ",
  "You can choose to ",
  "👉 Take a day off (count out) ",
  "👉 Requesting for partners ",
  "👉 Leave a 4-minute up voice message and answer questions related to weekly topic. ONLY on Monday can talk about your last weekend or sharing something interesting.",
].join("\n");

function normalizeSign(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase();
}

function isOnce(value) {
  return ONCE_SIGNS.has(
    normalizeSign(value)
  );
}

function isTwice(value) {
  return TWICE_SIGNS.has(
    normalizeSign(value)
  );
}

function isAvailable(value) {
  return isOnce(value) ||
    isTwice(value);
}

export function parseCsv(source) {
  const text = String(source ?? "")
    .replace(/^\uFEFF/, "");

  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;

  for (let i = 0; i < text.length; i += 1) {
    const character = text[i];

    if (quoted) {
      if (character === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        cell += character;
      }

      continue;
    }

    if (character === '"') {
      quoted = true;
    } else if (character === ",") {
      row.push(cell);
      cell = "";
    } else if (character === "\n") {
      row.push(cell.replace(/\r$/, ""));
      rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += character;
    }
  }

  if (quoted) {
    throw new Error(
      "Google Sheet CSV 含有未結束的引號。"
    );
  }

  if (
    cell.length > 0 ||
    row.length > 0
  ) {
    row.push(cell.replace(/\r$/, ""));
    rows.push(row);
  }

  return rows;
}

function validateRows(rows) {
  if (rows.length < 3) {
    throw new Error(
      "Google Sheet CSV 至少需要標題列、會員列及統計列。"
    );
  }

  if (
    rows[0].length <=
      FIELD_COL_FLEX
  ) {
    throw new Error(
      "Google Sheet CSV 缺少 C～R 的時段欄位。"
    );
  }

  const memberRows =
    rows.slice(1, -1);

  if (memberRows.length > 64) {
    throw new Error(
      "會員數超過 pairup.c 支援的 64 人上限。"
    );
  }

  for (
    let index = 0;
    index < memberRows.length;
    index += 1
  ) {
    if (
      !String(
        memberRows[index][FIELD_COL_NAME] ?? ""
      ).trim()
    ) {
      throw new Error(
        `Google Sheet 第 ${index + 2} 列缺少會員名稱。`
      );
    }
  }
}

function shuffledCopy(values, random) {
  const copy = [...values];

  for (
    let index = copy.length - 1;
    index > 0;
    index -= 1
  ) {
    const target = Math.floor(
      random() * (index + 1)
    );

    [copy[index], copy[target]] =
      [copy[target], copy[index]];
  }

  return copy;
}

function getRequests(row) {
  for (
    let column = FIELD_COL_START;
    column <= FIELD_COL_END;
    column += 1
  ) {
    if (isOnce(row[column])) {
      return 1;
    }

    if (isTwice(row[column])) {
      return 2;
    }
  }

  return 0;
}

function availableSlots(
  row,
  endColumn
) {
  const result = [];

  for (
    let column = FIELD_COL_START;
    column <= endColumn;
    column += 1
  ) {
    if (isAvailable(row[column])) {
      result.push(column);
    }
  }

  return result;
}

function createMembers(
  rows,
  random
) {
  return shuffledCopy(
    rows.slice(1, -1),
    random
  ).map((row, index) => {
    const fixedSlots =
      availableSlots(
        row,
        FIELD_COL_END
      );

    return {
      id: index + 1,
      name: String(
        row[FIELD_COL_NAME]
      ),
      requests:
        getRequests(row),
      availability:
        fixedSlots.length,
      earliestSlot:
        fixedSlots[0] ?? -1,
      fixedSlots,
      allSlots:
        availableSlots(
          row,
          FIELD_COL_FLEX
        ),
      flex:
        isAvailable(
          row[FIELD_COL_FLEX]
        ),
      row,
    };
  });
}

function createRelations(members) {
  const relations = [];

  for (const member of members) {
    if (
      member.allSlots.length === 0
    ) {
      continue;
    }

    const candidates = [];

    for (const slot of member.allSlots) {
      for (const candidate of members) {
        if (
          candidate !== member &&
          candidate.allSlots.includes(slot)
        ) {
          candidates.push({
            member: candidate,
            slot,
          });

          if (candidates.length >= 63) {
            break;
          }
        }
      }

      if (candidates.length >= 63) {
        break;
      }
    }

    relations.push({
      member,
      candidates,
      count:
        candidates.length + 1,
    });
  }

  return relations;
}

function pairWithPriority(
  relations,
  compare
) {
  const ordered = [...relations]
    .sort(compare);

  const remain = new Map(
    ordered.map((relation) => [
      relation.member,
      relation.member.requests,
    ])
  );

  const available = new Map(
    ordered.map((relation) => [
      relation.member,
      new Set(
        relation.member.allSlots
      ),
    ])
  );

  const pairs = [];
  const pairedKeys = new Set();

  for (const relation of ordered) {
    const memberA = relation.member;

    if ((remain.get(memberA) ?? 0) === 0) {
      continue;
    }

    for (
      const candidate of
        relation.candidates
    ) {
      const memberB =
        candidate.member;

      if (
        (remain.get(memberB) ?? 0) <= 0 ||
        !available.get(memberA)
          ?.has(candidate.slot) ||
        !available.get(memberB)
          ?.has(candidate.slot)
      ) {
        continue;
      }

      const key = [
        memberA.id,
        memberB.id,
      ].sort((a, b) => a - b)
        .join(":");

      if (pairedKeys.has(key)) {
        continue;
      }

      remain.set(
        memberA,
        remain.get(memberA) - 1
      );

      remain.set(
        memberB,
        remain.get(memberB) - 1
      );

      available.get(memberA)
        .delete(candidate.slot);

      available.get(memberB)
        .delete(candidate.slot);

      pairedKeys.add(key);
      pairs.push({
        memberA,
        memberB,
        slot: candidate.slot,
      });

      break;
    }
  }

  return {
    pairs,
    singles: ordered
      .filter(
        ({ member }) =>
          (remain.get(member) ?? 0) !== 0
      )
      .map(({ member }) => member),
    totalRequests: ordered.reduce(
      (total, { member }) =>
        total + member.requests,
      0
    ),
  };
}

function applyFlexPairs(
  result,
  members
) {
  const flexMembers =
    members.filter(
      (member) => member.flex
    );

  for (
    let index = 0;
    index + 1 < flexMembers.length;
    index += 2
  ) {
    result.pairs.push({
      memberA: flexMembers[index],
      memberB: flexMembers[index + 1],
      slot: -1,
    });
  }

  if (flexMembers.length % 2 === 1) {
    const odd =
      flexMembers.at(-1);

    if (!result.singles.includes(odd)) {
      result.singles.push(odd);
    }
  }
}

function formatRange(
  header,
  startColumn,
  endColumn
) {
  const startLabel =
    String(header[startColumn] ?? "");

  const endLabel =
    String(header[endColumn] ?? "");

  const left =
    startLabel.split("~")[0];

  const endParts =
    endLabel.split("~");

  const right =
    endParts.length > 1
      ? endParts.slice(1).join("~")
      : endLabel;

  return left && right
    ? `${left}~${right}`
    : `${startLabel}~${endLabel}`;
}

function collectAvailableRanges(
  header,
  member
) {
  const ranges = [];
  let start = -1;
  let previous = -1;

  for (
    let column = FIELD_COL_START;
    column <= FIELD_COL_END;
    column += 1
  ) {
    if (
      member.fixedSlots.includes(column)
    ) {
      if (start === -1) {
        start = column;
      } else if (
        column !== previous + 1
      ) {
        ranges.push(
          formatRange(
            header,
            start,
            previous
          )
        );
        start = column;
      }

      previous = column;
    }
  }

  if (start !== -1) {
    ranges.push(
      formatRange(
        header,
        start,
        previous
      )
    );
  }

  return ranges;
}

export function pairupCsv(
  source,
  options = {}
) {
  const rows = parseCsv(source);
  validateRows(rows);

  const random =
    options.random ?? Math.random;

  const members =
    createMembers(rows, random);

  const relations =
    createRelations(members);

  let best = null;

  for (
    const [name, compare] of
      ALGORITHMS
  ) {
    const candidate = {
      ...pairWithPriority(
        relations,
        compare
      ),
      algorithm: name,
    };

    if (
      !best ||
      candidate.pairs.length >
        best.pairs.length ||
      (
        candidate.pairs.length ===
          best.pairs.length &&
        random() < 0.5
      )
    ) {
      best = candidate;
    }

    if (
      best.totalRequests ===
        best.pairs.length * 2
    ) {
      break;
    }
  }

  if (options.enableFlex === true) {
    applyFlexPairs(best, members);
  }

  const result = {
    algorithm: best.algorithm,
    successfulRequests:
      best.pairs.length * 2,
    failedRequests:
      best.singles.length,
    pairs: best.pairs.map((pair) => ({
      memberA: pair.memberA.name,
      memberB: pair.memberB.name,
      matchedTime:
        pair.slot === -1
          ? "flex"
          : String(
            rows[0][pair.slot] ?? ""
          ),
    })),
    singles: best.singles.map(
      (member) => {
        const availableRanges =
          collectAvailableRanges(
            rows[0],
            member
          );

        if (
          availableRanges.length === 0 &&
          member.flex &&
          options.enableFlex === true
        ) {
          availableRanges.push(
            "????~????"
          );
        }

        return {
          member: member.name,
          availableRanges,
        };
      }
    ),
  };

  return result;
}

export function formatPairResult(result) {
  const lines = [];

  if (result.pairs.length === 0) {
    lines.push(NO_PAIRS_MESSAGE);
  } else {
    lines.push(
      "Enjoy the chat with your partner!💬"
    );

    for (const pair of result.pairs) {
      lines.push(
        `@${pair.memberA} -- @${pair.memberB} (${pair.matchedTime})`
      );
    }
  }

  lines.push("", "As for");

  for (const single of result.singles) {
    lines.push(
      `@${single.member} (${single.availableRanges.join(", ")})`
    );
  }

  lines.push(ALTERNATIVES_MESSAGE);

  return lines.join("\n");
}

export function summarizeWorksheet(
  source
) {
  const rows = parseCsv(source);
  validateRows(rows);

  let participantCount = 0;
  let filledCellCount = 0;

  for (const row of rows.slice(1, -1)) {
    let participantFilled = false;

    for (
      let column = FIELD_COL_START;
      column <= FIELD_COL_FLEX;
      column += 1
    ) {
      if (
        String(row[column] ?? "")
          .trim() !== ""
      ) {
        filledCellCount += 1;
        participantFilled = true;
      }
    }

    if (participantFilled) {
      participantCount += 1;
    }
  }

  return {
    participantCount,
    filledCellCount,
    memberCount:
      rows.length - 2,
    clearRange:
      `C2:R${rows.length - 1}`,
  };
}
