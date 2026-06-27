"use strict";
const puppeteer = require("puppeteer-extra");
const Stealth   = require("puppeteer-extra-plugin-stealth");
puppeteer.use(Stealth());

const BODY_MAP = {
  "SUV":"9","Limousine":"1","Kombi":"3","Coupé":"2","Cabriolet":"4",
  "Kleinwagen":"6","Van":"7","Minivan":"7","Pickup":"8",
  "Geländewagen":"9","Sportwagen":"2","Transporter":"10",
};
const FUEL_MAP = {
  "Benzin":"B","Diesel":"D","Elektro":"E","Hybrid":"M",
  "Plug-in-Hybrid":"P","Mild-Hybrid":"M","Erdgas (CNG)":"L","LPG":"U","Wasserstoff":"H",
};
const GEAR_MAP = { "Automatik":"A","Schaltgetriebe":"M","DSG/DCT":"S","CVT":"A" };
const LAND_MAP = {
  "Deutschland":"D","Österreich":"A","Schweiz":"CH","Niederlande":"NL",
  "Belgien":"B","Frankreich":"F","Italien":"I","Spanien":"E","Polen":"PL",
};

function buildUrl(f) {
  const slug = [f.make, f.model]
    .filter(Boolean)
    .map(s => s.toLowerCase()
      .replace(/\s+/g, "-")
      .replace(/ä/g,"ae").replace(/ö/g,"oe").replace(/ü/g,"ue")
    ).join("/");

  const p = new URLSearchParams({
    atype: "C", cy: LAND_MAP[f.country] || "D",
    sort: "standard", ustate: "N,U",
  });
  if (f.body  && f.body  !=="Alle") p.set("body",      BODY_MAP[f.body]  || "");
  if (f.fuel  && f.fuel  !=="Alle") p.set("fuel",      FUEL_MAP[f.fuel]  || "");
  if (f.gear  && f.gear  !=="Alle") p.set("gear",      GEAR_MAP[f.gear]  || "");
  if (f.minP)  p.set("pricefrom", f.minP);
  if (f.maxP)  p.set("priceto",   f.maxP);
  if (f.minKm) p.set("kmfrom",    f.minKm);
  if (f.maxKm) p.set("kmto",      f.maxKm);
  if (f.minY)  p.set("fregfrom",  f.minY);
  if (f.maxY)  p.set("fregto",    f.maxY);
  if (f.minPS) p.set("powerfrom", f.minPS);
  if (f.maxPS) p.set("powerto",   f.maxPS);
  return `https://www.autoscout24.de/lst/${slug};?${p}`;
}

async function scrapeAutoScout(filters) {
  const url = buildUrl(filters);
  console.log("[AutoScout24]", url);

  const browser = await puppeteer.launch({
    headless: "new",
    args: [
      "--no-sandbox","--disable-setuid-sandbox",
      "--disable-dev-shm-usage","--disable-gpu",
      "--window-size=1366,768",
      ...(process.env.PROXY_URL ? [`--proxy-server=${process.env.PROXY_URL}`] : []),
    ],
  });

  try {
    const page = await browser.newPage();
    await page.setUserAgent(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    );
    await page.setExtraHTTPHeaders({ "Accept-Language": "de-DE,de;q=0.9" });
    await page.goto(url, { waitUntil: "networkidle2", timeout: 30000 });

    // Cookie-Banner
    try {
      await page.waitForSelector('[data-testid="consent-accept-btn"]', { timeout: 4000 });
      await page.click('[data-testid="consent-accept-btn"]');
      await new Promise(r => setTimeout(r, 1000));
    } catch (_) {}

    // Warte auf Ergebnisse
    try {
      await page.waitForSelector('article[data-item-name="result-item"]', { timeout: 12000 });
    } catch (_) {
      console.warn("[AutoScout24] Keine Ergebnisse oder blockiert");
      return [];
    }

    const items = await page.evaluate(() => {
      const num  = t => parseInt((t || "").replace(/\D/g, "")) || 0;
      const yr   = t => { const m = (t || "").match(/(\d{4})/); return m ? +m[1] : 0; };
      const ps   = t => {
        const m1 = (t || "").match(/(\d+)\s*PS/i); if (m1) return +m1[1];
        const m2 = (t || "").match(/(\d+)\s*kW/i); return m2 ? Math.round(+m2[1] * 1.3596) : 0;
      };

      return [...document.querySelectorAll('article[data-item-name="result-item"]')]
        .slice(0, 20)
        .map((card, i) => {
          const q     = s => card.querySelector(s)?.textContent?.trim() || "";
          const title = q('[data-testid="ad-title"]') || q("h2");
          const dets  = [...card.querySelectorAll('[data-testid="vehicle-detail-item"] span')]
                          .map(e => e.textContent.trim());
          const parts = title.split(" ");
          const href  = card.querySelector("a")?.href || "";

          return {
            id:       `as24-${i}-${Date.now()}`,
            source:   "AutoScout24",
            make:     parts[0] || "–",
            model:    parts.slice(1, 3).join(" ") || "–",
            variant:  parts.slice(3).join(" ") || "",
            price:    num(q('[data-testid="price-label"]')),
            km:       num(dets.find(d => d.includes("km")) || ""),
            year:     yr(dets.find(d => /\d{4}/.test(d) && d.length < 12) || ""),
            fuel:     dets.find(d => /benzin|diesel|elektro|hybrid|gas/i.test(d)) || "–",
            power:    ps(dets.find(d => /PS|kW/i.test(d)) || ""),
            gearbox:  dets.find(d => /automatik|schalt/i.test(d)) || "–",
            location: q('[data-testid="location-with-distance-seller-info"]') || "Deutschland",
            seller:   "Händler",
            url:      href.startsWith("http") ? href : `https://www.autoscout24.de${href}`,
            img:      card.querySelector("img")?.src || "",
            body: "–", color: "–", drive: "–", doors: 4, seats: 5, owners: 1,
            consumption: "–", co2: "–", emission: "–",
            inspected: false, guarantee: false, financing: false, features: [],
            marketAvg: 0, valueRating: "ok", valueNote: "", description: "",
          };
        });
    });

    console.log(`[AutoScout24] ${items.length} Inserate`);
    return items;
  } finally {
    await browser.close();
  }
}

module.exports = { scrapeAutoScout };
