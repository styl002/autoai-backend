"use strict";
require("dotenv").config();

const express   = require("express");
const cors      = require("cors");
const NodeCache = require("node-cache");
const Groq      = require("groq-sdk");
const { scrapeMobile    } = require("./scrapers/mobile");
const { scrapeAutoScout } = require("./scrapers/autoscout");

const app   = express();
const cache = new NodeCache({ stdTTL: 600 });
const groq  = new Groq({ apiKey: process.env.GROQ_API_KEY });

app.use(cors());
app.use(express.json({ limit: "2mb" }));

async function groqCall(system, user, maxTokens = 800) {
  const res = await groq.chat.completions.create({
    model: "llama-3.3-70b-versatile",
    messages: [{ role: "system", content: system }, { role: "user", content: user }],
    max_tokens: maxTokens,
    temperature: 0.3,
  });
  return res.choices[0]?.message?.content?.trim() || "";
}

app.get("/health", (_, res) => res.json({ ok: true, ai: "Groq llama-3.3-70b" }));

app.post("/search", async (req, res) => {
  try {
    const f = req.body || {};
    const cacheKey = "s:" + JSON.stringify(f);
    const cached = cache.get(cacheKey);
    if (cached) return res.json({ listings: cached, cached: true });

    const [mob, as24] = await Promise.allSettled([scrapeMobile(f), scrapeAutoScout(f)]);
    const raw = [
      ...(mob.status  === "fulfilled" ? mob.value  : []),
      ...(as24.status === "fulfilled" ? as24.value : []),
    ];

    if (!raw.length) return res.status(502).json({ error: "Keine Ergebnisse von den Plattformen." });

    let listings = raw;
    try {
      const subset = raw.slice(0, 20).map(c => ({ id: c.id, make: c.make, model: c.model, year: c.year, km: c.km, price: c.price, fuel: c.fuel }));
      const text = await groqCall(
        "Automobil-Marktanalyst. Antworte NUR mit JSON-Array. Kein Text davor oder danach.",
        `Für jedes Fahrzeug marketAvg (dt. Marktpreis 2025 EUR), valueRating ("gut"|"ok"|"hoch"), valueNote kurz.\nNur Array: [{"id":"...","marketAvg":0,"valueRating":"ok","valueNote":"..."}]\n${JSON.stringify(subset)}`
      );
      const t = text.replace(/```json\s*/gi, "").replace(/```/g, "").trim();
      const s = t.indexOf("["), e = t.lastIndexOf("]");
      if (s !== -1 && e > s) {
        const enriched = JSON.parse(t.slice(s, e + 1));
        const map = Object.fromEntries(enriched.map(x => [x.id, x]));
        listings = raw.map(c => ({ ...c, ...(map[c.id] || {}) }));
      }
    } catch (e) { console.warn("Groq enrich skip:", e.message); }

    cache.set(cacheKey, listings);
    res.json({ listings, sources: { "mobile.de": mob.status === "fulfilled" ? mob.value.length : "Fehler", "AutoScout24": as24.status === "fulfilled" ? as24.value.length : "Fehler" } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/chat", async (req, res) => {
  try {
    const { message, listings = [], history = [] } = req.body;
    const summary = listings.slice(0, 8).map(c => `• ${c.make} ${c.model} ${c.variant || ""} (${c.year}, ${(c.km||0).toLocaleString("de-DE")} km, ${c.fuel}, ${c.power} PS) → ${(c.price||0).toLocaleString("de-DE")} € [${(c.valueRating||"ok").toUpperCase()}]`).join("\n");
    const system = `Du bist AutoBerater, KFZ-Experte für Deutschland. Echte Inserate:\n${summary || "Keine Suche."}\nAntworte auf Deutsch, max. 120 Wörter, kein Markdown.`;
    const messages = [{ role: "system", content: system }, ...history.slice(-6).map(m => ({ role: m.role === "ai" ? "assistant" : "user", content: m.text })), { role: "user", content: message }];
    const completion = await groq.chat.completions.create({ model: "llama-3.3-70b-versatile", messages, max_tokens: 400, temperature: 0.4 });
    res.json({ reply: completion.choices[0]?.message?.content?.trim() || "Keine Antwort." });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/verdict", async (req, res) => {
  try {
    const c = req.body;
    const text = await groqCall("KFZ-Experte. Max. 60 Wörter Preis-Leistungs-Einschätzung auf Deutsch.", `${c.make} ${c.model} ${c.variant||""}, Bj.${c.year}, ${(c.km||0).toLocaleString("de-DE")} km, ${c.fuel}, ${c.power} PS → ${(c.price||0).toLocaleString("de-DE")} €. Marktschnitt: ${(c.marketAvg||0).toLocaleString("de-DE")} €. Bewertung: ${c.valueRating}.`, 200);
    res.json({ verdict: text });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.listen(process.env.PORT || 3001, () => console.log("AutoAI Backend läuft | Groq llama-3.3-70b"));
