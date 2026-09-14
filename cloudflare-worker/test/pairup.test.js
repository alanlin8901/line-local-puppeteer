import assert from "node:assert/strict";
import test from "node:test";

import {
  formatPairResult,
  pairupCsv,
  parseCsv,
  summarizeWorksheet,
} from "../src/pairup.js";

const HEADER = [
  "",
  "",
  "1700~1730",
  "1730~1800",
  "1800~1830",
  "1830~1900",
  "1900~1930",
  "1930~2000",
  "2000~2030",
  "2030~2100",
  "2100~2130",
  "2130~2200",
  "2200~2230",
  "2230~2300",
  "2300~2330",
  "2330~2400",
  "2400~2430",
  "FLEX",
  "",
];

function memberRow(
  name,
  cells = {}
) {
  const row =
    Array(19).fill("");

  row[0] = name;
  row[18] = name;

  for (
    const [column, value] of
      Object.entries(cells)
  ) {
    row[Number(column)] = value;
  }

  return row;
}

function csv(...members) {
  return [
    HEADER,
    ...members,
    memberRow("填答數"),
  ].map((row) => row.join(","))
    .join("\n");
}

const noShuffle = () => 0.999;

test("parses quoted CSV cells", () => {
  assert.deepEqual(
    parseCsv('"A, B","He said ""hi"""\n'),
    [["A, B", 'He said "hi"']]
  );
});

test("formats a successful pair", () => {
  const result = pairupCsv(
    csv(
      memberRow("Alice", { 2: "1" }),
      memberRow("Bob", { 2: "V" })
    ),
    { random: noShuffle }
  );

  assert.deepEqual(result.pairs, [
    {
      memberA: "Alice",
      memberB: "Bob",
      matchedTime: "1700~1730",
    },
  ]);

  assert.equal(
    formatPairResult(result)
      .includes(
        "@Alice -- @Bob (1700~1730)"
      ),
    true
  );
});

test("honors a two-session request", () => {
  const result = pairupCsv(
    csv(
      memberRow("Alice", {
        2: "2",
        3: "2",
      }),
      memberRow("Bob", { 2: "1" }),
      memberRow("Cara", { 3: "1" })
    ),
    { random: noShuffle }
  );

  assert.equal(result.pairs.length, 2);
  assert.equal(result.singles.length, 0);
});

test("merges a single member's consecutive time slots", () => {
  const result = pairupCsv(
    csv(
      memberRow("Lee", {
        10: "2",
        11: "2",
        12: "2",
      })
    ),
    { random: noShuffle }
  );

  assert.equal(result.pairs.length, 0);
  assert.deepEqual(result.singles, [
    {
      member: "Lee",
      availableRanges: [
        "2100~2230",
      ],
    },
  ]);
});

test("summarizes only the clearable member area", () => {
  const source = csv(
    memberRow("Alice", {
      2: "1",
      17: "1",
    }),
    memberRow("Bob")
  );

  assert.deepEqual(
    summarizeWorksheet(source),
    {
      participantCount: 1,
      filledCellCount: 2,
      memberCount: 2,
      clearRange: "C2:R3",
    }
  );
});
