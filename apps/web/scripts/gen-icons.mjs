// Génère les icônes PNG (iOS exige du PNG pour l'écran d'accueil) à partir du même dessin que favicon.svg.
import { writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";

const BG = [0x0b, 0x0f, 0x14], FG = [0x5c, 0xc8, 0xff];

function crc32(buf) {
  let c, crc = ~0;
  for (const b of buf) { c = (crc ^ b) & 0xff; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crc = (crc >>> 8) ^ c; }
  return ~crc >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

function icon(size) {
  const S = 4; // suréchantillonnage pour l'anticrénelage
  const raw = Buffer.alloc(size * (size * 3 + 1));
  const c = size / 2, ringR = size * 17 / 64, ringW = size * 5 / 64, dotR = size * 6 / 64;
  for (let y = 0; y < size; y++) {
    raw[y * (size * 3 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      let hit = 0;
      for (let sy = 0; sy < S; sy++) for (let sx = 0; sx < S; sx++) {
        const d = Math.hypot(x + (sx + 0.5) / S - c, y + (sy + 0.5) / S - c);
        if (Math.abs(d - ringR) <= ringW / 2 || d <= dotR) hit++;
      }
      const t = hit / (S * S), o = y * (size * 3 + 1) + 1 + x * 3;
      for (let i = 0; i < 3; i++) raw[o + i] = Math.round(BG[i] + (FG[i] - BG[i]) * t);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

for (const s of [180, 192, 512]) writeFileSync(new URL(`../public/icon-${s}.png`, import.meta.url), icon(s));
// Source des icônes de l'app de bureau (npx tauri icon apps/desktop/src-tauri/app-icon.png).
writeFileSync(new URL("../../desktop/src-tauri/app-icon.png", import.meta.url), icon(1024));
console.log("icônes générées");
