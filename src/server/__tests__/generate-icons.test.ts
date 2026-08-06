import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

function expectedHallOfBlamersIcon() {
  const size = 512;
  const r1 = size * 0.39;
  const r2 = size * 0.29;
  const fontSize = size * 0.21;
  const cy = size / 2;
  const textY = cy + fontSize * 0.34;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <rect width="${size}" height="${size}" fill="#0b2018"/>
  <circle cx="${size / 2}" cy="${cy}" r="${r1}" fill="none" stroke="#d9a61c" stroke-width="${size * 0.043}"/>
  <circle cx="${size / 2}" cy="${cy}" r="${r2}" fill="#16382c" stroke="#d9a61c" stroke-width="${size * 0.008}"/>
  <text x="${size / 2}" y="${textY}" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-weight="800" font-size="${fontSize}" letter-spacing="${size * 0.004}" fill="#f2f1ec">HOB</text>
</svg>`;
}

function expectedHallOfBlamersMaskableIcon() {
  const size = 512;
  const r1 = size * 0.29;
  const r2 = size * 0.215;
  const fontSize = size * 0.152;
  const cy = size / 2;
  const textY = cy + fontSize * 0.34;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <rect width="${size}" height="${size}" fill="#0b2018"/>
  <circle cx="${size / 2}" cy="${cy}" r="${r1}" fill="none" stroke="#d9a61c" stroke-width="${size * 0.031}"/>
  <circle cx="${size / 2}" cy="${cy}" r="${r2}" fill="#16382c" stroke="#d9a61c" stroke-width="${size * 0.006}"/>
  <text x="${size / 2}" y="${textY}" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-weight="800" font-size="${fontSize}" letter-spacing="${size * 0.003}" fill="#f2f1ec">HOB</text>
</svg>`;
}

function expectedHallOfBlamersSquareIcon() {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <rect width="64" height="64" rx="12" fill="#102b21" />
  <text x="32" y="40" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-weight="800" font-size="21" letter-spacing="0.5" fill="#eef5f0">HOB</text>
</svg>`;
}

describe("generate-icons", () => {
  it("generates the Hall of Blamers HOB monogram", async () => {
    execFileSync(process.execPath, ["scripts/generate-icons.mjs"], {
      cwd: repoRoot,
      stdio: "pipe",
    });

    const [actual, expected, actualMaskable, expectedMaskable] = await Promise.all([
      sharp(path.join(repoRoot, "src", "app", "icon.png")).raw().toBuffer(),
      sharp(Buffer.from(expectedHallOfBlamersIcon())).resize(512, 512).png().raw().toBuffer(),
      sharp(path.join(repoRoot, "public", "icons", "icon-maskable-512.png")).raw().toBuffer(),
      sharp(Buffer.from(expectedHallOfBlamersMaskableIcon())).resize(512, 512).png().raw().toBuffer(),
    ]);

    expect(actual.equals(expected)).toBe(true);
    expect(actualMaskable.equals(expectedMaskable)).toBe(true);
  }, 15_000);

  it("ships Hall of Blamers square SVG icons", async () => {
    const expected = await sharp(Buffer.from(expectedHallOfBlamersSquareIcon()))
      .resize(64, 64)
      .png()
      .raw()
      .toBuffer();

    for (const iconPath of ["src/app/icon.svg", "public/icon.svg"]) {
      const actual = await sharp(path.join(repoRoot, iconPath)).resize(64, 64).png().raw().toBuffer();
      expect(actual.equals(expected), iconPath).toBe(true);
    }
  });
});
