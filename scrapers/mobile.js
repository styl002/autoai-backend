"use strict";
const puppeteer = require("puppeteer-extra");
const Stealth   = require("puppeteer-extra-plugin-stealth");
puppeteer.use(Stealth());

const MAKE_IDS = {
  "Audi":"1900","BMW":"3500","Mercedes-Benz":"17200","Volkswagen":"25200","Ford":"9000","Toyota":"24100","Tesla":"23603","Porsche":"20000","Opel":"19000","Skoda":"21700","Seat":"21500","Hyundai":"12100","Kia":"13300","Renault":"20900","Peugeot":"19700","Volvo":"25100","Mazda":"16700","Honda":"11600","Nissan":"18700","Dacia":"6050","Fiat":"8600","Alfa Romeo":"100","Jeep":"12900","Land Rover":"14100","Mini":"18000","Ferrari":"8800","Lamborghini":"13400","Maserati":"16200","BYD":"3000","Genesis":"9340","Cupra":"5765","MG":"17100","Polestar":"20050","Mitsubishi":"18400","Subaru":"22700","Suzuki":"22900","Smart":"22300","Jaguar":"12500",
};
const BODY_MAP = { "SUV":"SUV/Gelaendewagen/Pickup","Limousine":"Limousine","Kombi":"Kombi","Coupé":"Sportwagen/Coupe","Cabriolet":"Cabrio/Roadster","Kleinwagen":"Kleinwagen","Van":"Van/Minibus","Minivan":"Van/Minibus","Pickup":"SUV/Gelaendewagen/Pickup","Geländewagen":"SUV/Gelaendewagen/Pickup","Sportwagen":"Sportwagen/Coupe","Transporter":"Transporter" };
const FUEL_MAP = { "Benzin":"PETROL","Diesel":"DIESEL","Elektro":"ELECTRICITY","Hybrid":"HYBRID","Plug-in-Hybrid":"PLUG_IN_HYBRID","Mild-Hybrid":"MILD_HYBRID","Erdgas (CNG)":"NATURAL_GAS","LPG":"LPG","Wasserstoff":"HYDROGEN" };
const GEAR_MAP = { "Automatik":"AUTOMATIC_GEAR","Schaltgetriebe":"MANUAL_GEAR","DSG/DCT":"SEMIAUTOMATIC_GEAR","CVT":"AUTOMATIC_GEAR" };

async function scrapeMobile(f) {
  const p = new URLSearchParams({ lang:"de", pageNumber:"1" });
  const id = MAKE_IDS[f.make]; if (id) p.set("makeModelVariant1.makeId", id);
  if (f.model)                       p.set("makeModelVariant1.modelDescription", f.model);
  if (f.body  && f.body  !=="Alle")  p.set("categories",   BODY_MAP[f.body]  || "");
  if (f.fuel  && f.fuel  !=="Alle")  p.set("fuels",         FUEL_MAP[f.fuel]  || "");
  if (f.gear  && f.gear  !=="Alle")  p.set("transmissions", GEAR_MAP[f.gear]  || "");
  if (f.minP)  p.set("minPrice",   f.minP);
  if (f.maxP)  p.set("maxPrice",   f.maxP);
  if (f.minKm) p.set("minMileage", f.minKm);
  if (f.maxKm) p.set("maxMileage", f.maxKm);
  if (f.minY)  p.set("minFirstRegistrationDate", `${f.minY}-01-01`);
  if (f.maxY)  p.set("maxFirstRegistrationDate", `${f.maxY}-12-31`);
  if (f.minPS) p.set("minPowerAsKw", Math.round(+f.minPS * 0.7355));
  if (f.maxPS) p.set("maxPowerAsKw", Math.round(+f.maxPS * 0.7355));
  const url = `https://suchen.mobile.de/fahrzeuge/search.html?${p}`;
  console.log("[mobile.de]", url);

  const browser = await puppeteer.launch({ headless:true, args:["--no-sandbox","--disable-setuid-sandbox","--disable-dev-shm-usage","--disable-gpu",...(process.env.PROXY_URL?[`--proxy-server=${process.env.PROXY_URL}`]:[])] });
  try {
    const page = await browser.newPage();
    await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36");
    await page.setExtraHTTPHeaders({ "Accept-Language":"de-DE,de;q=0.9" });
    await page.goto(url, { waitUntil:"domcontentloaded", timeout:30000 });
    try { await page.waitForSelector('[data-testid="mde-consent-accept-btn"]',{timeout:3000}); await page.click('[data-testid="mde-consent-accept-btn"]'); await new Promise(r=>setTimeout(r,800)); } catch(_){}
    try { await page.waitForSelector('[data-testid="result-list-item"]',{timeout:12000}); } catch(_){ return []; }

    return await page.evaluate(() => {
      const num=t=>parseInt((t||"").replace(/\D/g,""))||0;
      const yr=t=>{const m=(t||"").match(/(\d{4})/);return m?+m[1]:0;};
      const ps=t=>{const m1=(t||"").match(/(\d+)\s*PS/i);if(m1)return+m1[1];const m2=(t||"").match(/(\d+)\s*kW/i);return m2?Math.round(+m2[1]*1.3596):0;};
      const q=(el,s)=>el.querySelector(s)?.textContent?.trim()||"";
      return [...document.querySelectorAll('[data-testid="result-list-item"]')].slice(0,20).map((card,i)=>{
        const title=q(card,"h2")||q(card,'[data-testid="ad-title"]');
        const parts=title.split(" ");
        return { id:`mob-${i}-${Date.now()}`,source:"mobile.de",make:parts[0]||"–",model:parts.slice(1,3).join(" ")||"–",variant:parts.slice(3).join(" ")||"",price:num(q(card,'[data-testid="price-label"]')),km:num(q(card,'[data-testid="mileage"]')),year:yr(q(card,'[data-testid="first-registration"]')),fuel:q(card,'[data-testid="fuel-type"]')||"–",power:ps(q(card,'[data-testid="power"]')),gearbox:q(card,'[data-testid="transmission"]')||"–",location:q(card,'[data-testid="seller-info-location"]')||"Deutschland",seller:q(card,'[data-testid="seller-name"]')||"–",url:card.querySelector("a")?.href||"",img:card.querySelector("img")?.src||"",body:"–",color:"–",drive:"–",doors:4,seats:5,owners:1,consumption:"–",co2:"–",emission:"–",inspected:false,guarantee:false,financing:false,features:[],marketAvg:0,valueRating:"ok",valueNote:"",description:"" };
      });
    });
  } finally { await browser.close(); }
}
module.exports = { scrapeMobile };
