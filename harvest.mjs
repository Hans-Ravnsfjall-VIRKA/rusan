// harvest.mjs — fetch ALL wines from rusan.fo and generate fictive taste data.
//
// Run locally (network unrestricted), Node 18+:
//     node harvest.mjs
// Produces:
//     wines.json   — array of wine objects
//     wines.js     — `window.RUSAN_WINES = [...]`  (load before vinleidarin's script)
//
// In vinleidarin.html, add before the main <script>:
//     <script src="wines.js"></script>
// and the app automatically uses the full catalogue.
//
// NOTE: the field extractors below target the patterns visible on the live pages
// (image/ShopItem/flag/icon URLs + the labelled fields). If Rúsan's markup differs,
// run once, eyeball the first-page count + a couple of objects, and nudge the regexes.

import { writeFileSync } from "node:fs";

const BASE = "https://rusan.fo/ShopCategoryItemPictureList/VIN/";
const OFFSETS = Array.from({ length: 30 }, (_, i) => i * 18); // 0,18,…,522
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- food taxonomy (Rúsan's own icon keys) ---------- */
const FOOD_KEYS = ["dessertir","fiskur","flogfenadur","fordrykkir","kalvakjot",
  "lambskjot","neytakjot","ostur","skeljadjor","svinakjot","villinidjor"];

/* derive food pairings mentioned in the Faroese tasting note (our enrichment) */
const FOOD_RE = {
  fiskur:/fisk|laks|royktan laks/i,
  skeljadjor:/skeljadj|skeldj|hummar|krækl|krækl|sushi|sjógæt|sjogaet|reki|ostrur/i,
  flogfenadur:/flogfena|høsn|hoesn|dunn|kalkun|fugl|gás|\bgas\b|and\b/i,
  neytakjot:/neyta|oksa|biff|reytt kjøt|reytt kjot|grillað kjøt/i,
  kalvakjot:/kálva|kalva/i,
  lambskjot:/lamb/i,
  svinakjot:/svín|\bsvin|grís|\bgris|fleskast|skinku|bacon/i,
  villinidjor:/villin|villini dj/i,
  ostur:/ost\b|ostar|ostur|blámu|blamu|stilton/i,
  dessertir:/dessert|sjokolát|sjokolat|kak[ua]|berjatopp|frukt og/i,
  fordrykkir:/fordrykk|vælkomst|vaelkomst|aperitif|drekka bert|omaná|omana/i,
};

/* ---------- fictive taste-profile rules ---------- */
function deriveColor(sku, txt) {
  const p = sku.slice(0, 2);
  if (/orange wine|orangevín|orangevin|maceration|amber wine/i.test(txt)) return "orange";
  if (/champagne|crémant|cremant|\bcava\b|prosecco|spumante|\bbrut\b|brúsandi|brusandi|\basti\b|brachetto|spritz|lambrusco|\bsekt\b/i.test(txt)) return "sparkling";
  if (/gløgg|gloegg|gl[uü]hwein|banyuls|tokaji|moscatel|moscato|sjerry|sherry|portví|\bport\b|dessertví|sauternes|dolce|eiswein|íssvín/i.test(txt)) return "sweet";
  if (/rosé|\brose\b|rosado|rósuv|rosuv/i.test(txt)) return "rose";
  if (p === "01") return "red";
  if (p === "02") return "white";
  if (p === "04") return "sparkling";
  if (/reyðv|reydv|\bred\b|rosso|rouge|tinto|noir|merlot|malbec|cabernet|syrah|shiraz|zinfandel|rioja|nebbiolo|sangiovese|tempranillo/i.test(txt)) return "red";
  if (/hvítv|hvitv|white|blanc|bianco|blanco|chardonnay|riesling|sauvignon|albari|grigio|verdejo|gewürz|gewurz/i.test(txt)) return "white";
  return "red";
}
function deriveBody(txt) {
  if (/kraftig|kraftmik|fyll|intens|rúgvumik|rugvumik|búgvi|bugvi|tannin|amarone|reserva|gran reserva|barbaresco|barolo/i.test(txt)) return 3;
  if (/\blætt|\blaett|bleyt|\bmild|frísk|\bfrisk|elegant|silkibleyt|leskilig/i.test(txt)) return 1;
  return 2;
}
function deriveSweet(txt) {
  if (/søt|\bsoet|sætt|saett|dolce|dessert|gløgg|gloegg|gl[uü]hwein|sweet|moscato|moscatel|tokaji|banyuls|dolç/i.test(txt)) return "sott";
  if (/hálvtur|halvtur|hálvsøt|halvsoet|off-dry/i.test(txt)) return "halvturt";
  return "turt";
}
const TYPE_NAME = { red:"Reyðvín", white:"Hvítvín", sparkling:"Brúsandi vín",
  sweet:"Søtt / dessertvín", orange:"Orangevín", rose:"Rósuvín" };

/* deterministic fictive rating from the SKU so it's stable across runs */
function seeded(sku) {
  let h = 2166136261;
  for (const ch of sku) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); }
  const u = ((h >>> 0) % 1000) / 1000;            // 0..1
  const r = Math.round((3.5 + u * 1.3) * 10) / 10; // 3.5..4.8
  const vo = 6 + Math.floor(((h >>> 7) % 1000) / 1000 * 115); // 6..120
  return { r, vo };
}

/* ---------- parse one page of HTML into wine objects ---------- */
function parsePage(html) {
  const out = [];
  const chunks = html.split(/\/Images\/Items\/W50\//).slice(1); // each chunk starts at "<id>.jpg…"
  for (const ch of chunks) {
    const im = (ch.match(/^(\d+)\.jpg/) || [])[1];
    const sku = (ch.match(/\/ShopItem\/VIN\/\d+\/([0-9][0-9-]+)\/STK/) || [])[1];
    if (!im || !sku) continue;
    const flag = (ch.match(/\/Flagg\/([A-Z]{2})\.jpg/) || [])[1] || "";
    // name: text of the (first) ShopItem anchor
    const nameRe = new RegExp("ShopItem\\/VIN\\/\\d+\\/" + sku.replace(/[-]/g, "\\-") + "\\/STK[^>]*>\\s*#?\\s*([^<]+?)\\s*<", "i");
    const n = (ch.match(nameRe) || [])[1]?.trim() || "(ónevnt)";
    // food icons present on the card
    const pr = [...new Set([...ch.matchAll(/\/Ikonir\/([a-zA-Z]+)\.jpg/g)]
      .map((m) => m[1].toLowerCase()))].filter((k) => FOOD_KEYS.includes(k));
    // tasting note: text after the name block, before "Vørunr"
    let no = "";
    const noteSlice = ch.split(/Vørunr/i)[0];
    const noteM = noteSlice.match(/STK[^>]*>[^<]*<\/a>\s*<\/h\d>([\s\S]*)$/i) || noteSlice.match(/<\/h\d>([\s\S]*)$/i);
    if (noteM) no = noteM[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    if (no.length > 320) no = no.slice(0, 317) + "…";
    const a = parseFloat(((ch.match(/Styrki[\s\S]{0,90}?([\d]+[.,]?\d*)\s*%/i) || [])[1] || "0").replace(",", "."));
    const volRaw = (ch.match(/Innihald[\s\S]{0,90}?([\d]+[.,]?\d*)\s*litrar/i) || [])[1] || "";
    const v = volRaw ? volRaw.replace(".", ",") + " l" : "";
    const priceRaw = (ch.match(/Prísur[\s\S]{0,120}?([\d.]+,\d{2})/i) || [])[1] || "0,00";
    const p = parseFloat(priceRaw.replace(/\./g, "").replace(",", "."));

    const txt = (n + " " + no).toLowerCase();
    const k = deriveColor(sku, txt);
    const dv = FOOD_KEYS.filter((key) => FOOD_RE[key] && FOOD_RE[key].test(no) && !pr.includes(key));
    const { r, vo } = seeded(sku);
    const obj = { id: sku, im: +im, n, c: flag, t: TYPE_NAME[k] || "Vín", k,
      b: deriveBody(txt), s: deriveSweet(txt), a, v, p, pr, dv, r, vo, no };
    if (a === 0 || /alkoholfrí|alkoholfri|alcohol-free/i.test(txt)) obj.af = 1;
    out.push(obj);
  }
  return out;
}

/* ---------- run ---------- */
const seen = new Set();
const all = [];
for (const off of OFFSETS) {
  process.stdout.write(`page offset ${off} … `);
  try {
    const res = await fetch(BASE + off, { headers: { "User-Agent": "Mozilla/5.0 (taste-finder harvester)" } });
    const html = await res.text();
    const wines = parsePage(html);
    let added = 0;
    for (const w of wines) if (!seen.has(w.id)) { seen.add(w.id); all.push(w); added++; }
    console.log(`${wines.length} found, ${added} new (total ${all.length})`);
  } catch (e) {
    console.log("FAILED:", e.message);
  }
  await sleep(400); // be polite
}

writeFileSync("wines.json", JSON.stringify(all, null, 1));
writeFileSync("wines.js", "window.RUSAN_WINES = " + JSON.stringify(all) + ";\n");
console.log(`\nDone. ${all.length} wines → wines.json + wines.js`);
