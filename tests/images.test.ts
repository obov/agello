import { expect, test } from "bun:test";
import { readFile, rm } from "node:fs/promises";
import { formatPrompt, saveImages } from "../src/server";

const png = Buffer.from("89504e470d0a1a0a", "hex").toString("base64");

test("saves chat images to files the agent can open", async () => {
  const [path] = (await saveImages([{ type: "image/png", data: png }]))!;
  expect(path).toMatch(/agello-uploads\/[\w-]+\.png$/);
  expect((await readFile(path)).toString("hex")).toBe("89504e470d0a1a0a");
  await rm(path);
  expect(await saveImages(undefined)).toEqual([]);
});

test("rejects non-images, empty data, and too many images", async () => {
  expect(await saveImages([{ type: "text/html", data: png }])).toBeNull();
  expect(await saveImages([{ type: "image/png", data: "" }])).toBeNull();
  expect(await saveImages(Array(6).fill({ type: "image/png", data: png }))).toBeNull();
  expect(await saveImages("x")).toBeNull();
});

test("image paths stay within the 3-line prompt", () => {
  const out = formatPrompt("message", ["이거 봐줘", "[image: /t/a.png]", "[image: /t/b.png]", "[image: /t/c.png]"].join("\n"));
  expect(out.split("\n")).toHaveLength(3);
  expect(out).toContain("/t/c.png");
});
