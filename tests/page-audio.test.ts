import { expect, test } from "bun:test";
import { PAGE_AUDIO_JS, parsePcm } from "../src/page-audio.ts";

test("page audio script parses", () => {
  expect(() => new Function(PAGE_AUDIO_JS)).not.toThrow();
});

test("parsePcm accepts a valid chunk", () => {
  expect(parsePcm(JSON.stringify({ c: 1, r: 48000, d: "AAAAAA==" }))).toEqual({ c: 1, r: 48000, d: "AAAAAA==" });
});

test("parsePcm rejects page-forged or malformed payloads", () => {
  for (const bad of [
    "not json",
    JSON.stringify({ c: 0, r: 48000, d: "AAAA" }),
    JSON.stringify({ c: 1, r: 10, d: "AAAA" }),
    JSON.stringify({ c: 1, r: 48000, d: "AA\nAA" }),
    JSON.stringify({ c: 1, r: 48000, d: "" }),
    JSON.stringify({ c: 1, r: 48000, d: "A".repeat(600 * 1024) }),
  ])
    expect(parsePcm(bad)).toBeNull();
});
