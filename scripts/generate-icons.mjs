// Regenerates the PWA/favicon icon PNGs from the Hall of Blamers monogram.
// Run with: npm run icons:generate
import sharp from "sharp";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, "..");

// Hall of Blamers' light-theme design tokens (src/app/globals.css).
const CHROME_DEEP = "#0b2018";
const CHROME = "#16382c";
const GOLD = "#d9a61c";
const CREAM = "#f2f1ec";

function regularSvg(size) {
  const r1 = size * 0.39;
  const r2 = size * 0.29;
  const fontSize = size * 0.21;
  const cy = size / 2;
  const textY = cy + fontSize * 0.34;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <rect width="${size}" height="${size}" fill="${CHROME_DEEP}"/>
  <circle cx="${size / 2}" cy="${cy}" r="${r1}" fill="none" stroke="${GOLD}" stroke-width="${size * 0.043}"/>
  <circle cx="${size / 2}" cy="${cy}" r="${r2}" fill="${CHROME}" stroke="${GOLD}" stroke-width="${size * 0.008}"/>
  <text x="${size / 2}" y="${textY}" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-weight="800" font-size="${fontSize}" letter-spacing="${size * 0.004}" fill="${CREAM}">HOB</text>
</svg>`;
}

function maskableSvg(size) {
  const r1 = size * 0.29;
  const r2 = size * 0.215;
  const fontSize = size * 0.152;
  const cy = size / 2;
  const textY = cy + fontSize * 0.34;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <rect width="${size}" height="${size}" fill="${CHROME_DEEP}"/>
  <circle cx="${size / 2}" cy="${cy}" r="${r1}" fill="none" stroke="${GOLD}" stroke-width="${size * 0.031}"/>
  <circle cx="${size / 2}" cy="${cy}" r="${r2}" fill="${CHROME}" stroke="${GOLD}" stroke-width="${size * 0.006}"/>
  <text x="${size / 2}" y="${textY}" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-weight="800" font-size="${fontSize}" letter-spacing="${size * 0.003}" fill="${CREAM}">HOB</text>
</svg>`;
}

async function main() {
  const iconsDir = path.join(REPO_ROOT, "public", "icons");
  fs.mkdirSync(iconsDir, { recursive: true });

  const jobs = [
    { svg: regularSvg(192), out: path.join(iconsDir, "icon-192.png"), size: 192 },
    { svg: regularSvg(512), out: path.join(iconsDir, "icon-512.png"), size: 512 },
    { svg: maskableSvg(192), out: path.join(iconsDir, "icon-maskable-192.png"), size: 192 },
    { svg: maskableSvg(512), out: path.join(iconsDir, "icon-maskable-512.png"), size: 512 },
    { svg: regularSvg(512), out: path.join(REPO_ROOT, "src", "app", "icon.png"), size: 512 },
    {
      svg: regularSvg(180),
      out: path.join(REPO_ROOT, "src", "app", "apple-icon.png"),
      size: 180,
      flatten: true,
    },
  ];

  for (const job of jobs) {
    let pipeline = sharp(Buffer.from(job.svg)).resize(job.size, job.size);
    if (job.flatten) pipeline = pipeline.flatten({ background: CHROME_DEEP });
    await pipeline.png().toFile(job.out);
    console.log("wrote", path.relative(REPO_ROOT, job.out));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
