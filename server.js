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

// ── Groq KI Aufruf ────────────────────────────────────────────────────────────
async function ai(system, user, maxTokens = 800) {
  const res = await groq.chat.completions.create({
    model:       "llama-3.3-70b-versatile",
    messages:    [{ role: "system", content: system }, { role: "user", content: user }],
    max_tokens:  maxTokens,
    temperature: 0.3,
  });
  return res.choices[0]?.message?.content?.trim() || "";
}

// ── Health ────────────────────────────────────────────────────────────────────
app.get("/health", (_, res) => {
  res.json({ ok: true, ai: "Groq / llama-3.3-70b-versatile", version: "1.0.0" });
});

// ── Suche ─────────────────────────────────────────────────────────────────────
app.post("/search", async (req, res) => {
  try {
    const f   = req.body || {};
    const key = "s:" + JSON.stringify(f);
    const hit = cache.get(key);
    if (hit) return res.json({ listings: hit, cached: true });

    console.log("[search] Start:", JSON.stringify(f));

    const [mob, as24] = await Promise.allSettled([
      scrapeMobile(f),
      scrapeAutoScout(f),
    ]);

    const raw = [
      ...(mob.status  === "fulfilled" ? mob.value  : []),
      ...(as24.status === "fulfilled" ? as24.value : []),
    ];

    if (mob.status  === "rejected") console.error("[mobile.de]",   mob.reason?.message);
    if (as24.status === "rejected") console.error("[AutoScout24]", as24.reason?.message);

    if (!raw.length) {
      return res.status(502).json({ error: "Keine Ergebnisse. Plattformen eventuell nicht erreichbar." });
    }

    let listings = raw;
    try { listings = await enrichWithGroq(raw); }
    catch (e) { console.warn("[Groq] Anreicherung übersprungen:", e.message); }

    cache.set(key, listings);
    res.json({
      listings,
      sources: {
        "mobile.de":   mob.status  === "fulfilled" ? mob.value.length  : "Fehler",
        "AutoScout24": as24.status === "fulfilled" ? as24.value.length : "Fehler",
      },
    });
  } catch (e) {
    console.error("[search] Fehler:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Chat ──────────────────────────────────────────────────────────────────────
app.post("/chat", async (req, res) => {
  try {
    const { message, listings = [], history = [] } = req.body;
    if (!message) return res.status(400).json({ error: "message fehlt" });

    const summary = listings.slice(0, 10).map(c =>
      `• ${c.make} ${c.model} ${c.variant || ""} (${c.year}, ${(c.km || 0).toLocaleString("de-DE")} km, ` +
      `${c.fuel}, ${c.power} PS) → ${(c.price || 0).toLocaleString("de-DE")} € [${(c.valueRating || "ok").toUpperCase()}] – ${c.source}`
    ).join("\n");

    const system =
      `Du bist AutoBerater, ein erfahrener KFZ-Experte für den deutschen Fahrzeugmarkt. ` +
      `Du analysierst echte Inserate von mobile.de und AutoScout24.\n\n` +
      `Aktuelle Suchergebnisse (${listings.length} Inserate):\n${summary || "Noch keine Suche."}\n\n` +
      `Antworte auf Deutsch. Sachlich, max. 120 Wörter. Keine Markdown-Formatierung.`;

    const messages = [
      { role: "system", content: system },
      ...history.slice(-6).map(m => ({ role: m.role === "ai" ? "assistant" : "user", content: m.text })),
      { role: "user", content: message },
    ];

    const completion = await groq.chat.completions.create({
      model: "llama-3.3-70b-versatile", messages, max_tokens: 400, temperature: 0.4,
    });

    res.json({ reply: completion.choices[0]?.message?.content?.trim() || "Keine Antwort." });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Einzelbewertung ───────────────────────────────────────────────────────────
app.post("/verdict", async (req, res) => {
  try {
    const c = req.body;
    const text = await ai(
      "Du bist KFZ-Experte. Preis-Leistungs-Einschätzung in max. 60 Wörtern auf Deutsch. Keine Formatierung.",
      `Bewerte: ${c.make} ${c.model} ${c.variant || ""}, ` +
      `Bj. ${c.year}, ${(c.km || 0).toLocaleString("de-DE")} km, ${c.fuel}, ${c.power} PS. ` +
      `Preis: ${(c.price || 0).toLocaleString("de-DE")} €. ` +
      `Marktschnitt: ${(c.marketAvg || 0).toLocaleString("de-DE")} €. ` +
      `Bewertung: ${c.valueRating}. Quelle: ${c.source}.`,
      200
    );
    res.json({ verdict: text });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Groq Anreicherung ─────────────────────────────────────────────────────────
async function enrichWithGroq(raw) {
  const subset = raw.slice(0, 20).map(c => ({
    id: c.id, make: c.make, model: c.model, year: c.year, km: c.km, price: c.price, fuel: c.fuel,
  }));

  const text = await ai(
    "Du bist Automobil-Marktanalyst für Deutschland. Antworte AUSSCHLIESSLICH mit einem JSON-Array. Kein Text, kein Markdown.",
    `Für jedes Fahrzeug: marketAvg (realer dt. Marktpreis 2025 in EUR), ` +
    `valueRating ("gut" = >5% unter Markt, "ok" = ±5%, "hoch" = >5% über Markt), ` +
    `valueNote (kurz, z.B. "9% unter Marktdurchschnitt").\n\n` +
    `Nur dieses Array zurückgeben:\n[{"id":"...","marketAvg":0,"valueRating":"ok","valueNote":"..."}]\n\n` +
    `Fahrzeuge:\n${JSON.stringify(subset)}`,
    1000
  );

  const t = text.replace(/```json\s*/gi, "").replace(/```/g, "").trim();
  const s = t.indexOf("["), e = t.lastIndexOf("]");
  if (s === -1 || e <= s) return raw;

  const enriched = JSON.parse(t.slice(s, e + 1));
  const map = Object.fromEntries(enriched.map(x => [x.id, x]));
  return raw.map(c => ({
    ...c,
    marketAvg:   map[c.id]?.marketAvg   ?? 0,
    valueRating: map[c.id]?.valueRating ?? "ok",
    valueNote:   map[c.id]?.valueNote   ?? "",
  }));
}

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`AutoAI Backend läuft auf Port ${PORT} | KI: Groq llama-3.3-70b`));
