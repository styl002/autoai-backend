"use strict";
require("dotenv").config();

const express   = require("express");
const cors      = require("cors");
const NodeCache = require("node-cache");
const Groq      = require("groq-sdk");

const { scrapeMobile    } = require("./scrapers/mobile");
const { scrapeAutoScout } = require("./scrapers/autoscout");

const app   = express();
const cache = new NodeCache({ stdTTL: 600 }); // 10 Min Cache
const groq  = new Groq({ apiKey: process.env.GROQ_API_KEY });

app.use(cors());
app.use(express.json({ limit: "2mb" }));

// ── Groq Helper ───────────────────────────────────────────────────────────────
// Modell: llama-3.3-70b-versatile  →  kostenlos, sehr stark, schnell
async function ai(system, user, maxTokens = 800) {
  const res = await groq.chat.completions.create({
    model:    "llama-3.3-70b-versatile",
    messages: [
      { role: "system",  content: system },
      { role: "user",    content: user   },
    ],
    max_tokens:  maxTokens,
    temperature: 0.3,
  });
  return res.choices[0]?.message?.content?.trim() || "";
}

// ── HEALTH ────────────────────────────────────────────────────────────────────
app.get("/health", (_, res) => res.json({ ok: true, ai: "Groq / Llama-3.3-70b" }));

// ── SUCHE ─────────────────────────────────────────────────────────────────────
app.post("/search", async (req, res) => {
  const f   = req.body || {};
  const key = "s:" + JSON.stringify(f);
  const hit = cache.get(key);
  if (hit) {
    console.log("[cache] HIT");
    return res.json({ listings: hit, cached: true });
  }

  console.log("[search] Filter:", JSON.stringify(f));

  // Beide Plattformen parallel scrapen
  const [mob, as24] = await Promise.allSettled([
    scrapeMobile(f),
    scrapeAutoScout(f),
  ]);

  const raw = [
    ...(mob.status  === "fulfilled" ? mob.value  : []),
    ...(as24.status === "fulfilled" ? as24.value : []),
  ];

  if (mob.status  === "rejected") console.error("[mobile.de] Fehler:", mob.reason?.message);
  if (as24.status === "rejected") console.error("[AutoScout24] Fehler:", as24.reason?.message);

  if (!raw.length) {
    return res.status(502).json({
      error: "Keine Ergebnisse von den Plattformen. Möglicherweise blockiert – Proxy empfohlen.",
    });
  }

  // Groq-KI bewertet Preis-Leistung
  let listings = raw;
  try {
    listings = await enrichWithGroq(raw);
  } catch (e) {
    console.warn("[Groq] Anreicherung übersprungen:", e.message);
  }

  cache.set(key, listings);
  res.json({
    listings,
    sources: {
      "mobile.de":   mob.status  === "fulfilled" ? mob.value.length  : "Fehler",
      "AutoScout24": as24.status === "fulfilled" ? as24.value.length : "Fehler",
    },
  });
});

// ── KI-CHAT ───────────────────────────────────────────────────────────────────
app.post("/chat", async (req, res) => {
  const { message, listings = [], history = [] } = req.body;
  if (!message) return res.status(400).json({ error: "message fehlt" });

  const summary = listings.slice(0, 10).map(c =>
    `• ${c.make} ${c.model} ${c.variant||""} (${c.year}, ${(c.km||0).toLocaleString("de-DE")} km, ` +
    `${c.fuel}, ${c.power} PS) → ${(c.price||0).toLocaleString("de-DE")} € [${(c.valueRating||"ok").toUpperCase()}] – ${c.source}`
  ).join("\n");

  const system =
    `Du bist AutoBerater, ein erfahrener KFZ-Experte und Marktanalyst für den deutschen Fahrzeugmarkt. ` +
    `Du analysierst echte Inserate von mobile.de und AutoScout24.\n\n` +
    `Aktuelle Suchergebnisse (${listings.length} echte Inserate):\n${summary || "Noch keine Suche durchgeführt."}\n\n` +
    `Antworte auf Deutsch. Sachlich, präzise, max. 130 Wörter. Keine Markdown-Formatierung. ` +
    `Beziehe dich auf konkrete Fahrzeuge wenn möglich.`;

  // Konversationsverlauf einbauen
  try {
    const messages = [
      { role: "system", content: system },
      ...history.slice(-6).map(m => ({
        role:    m.role === "ai" ? "assistant" : "user",
        content: m.text,
      })),
      { role: "user", content: message },
    ];

    const completion = await groq.chat.completions.create({
      model:       "llama-3.3-70b-versatile",
      messages,
      max_tokens:  400,
      temperature: 0.4,
    });

    const reply = completion.choices[0]?.message?.content?.trim() || "Keine Antwort erhalten.";
    res.json({ reply });
  } catch (e) {
    console.error("[chat]", e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── EINZELBEWERTUNG ───────────────────────────────────────────────────────────
app.post("/verdict", async (req, res) => {
  const c = req.body;
  if (!c?.id) return res.status(400).json({ error: "Kein Fahrzeug" });

  try {
    const text = await ai(
      "Du bist KFZ-Experte. Gib eine sachliche Preis-Leistungs-Einschätzung in max. 60 Wörtern auf Deutsch. Keine Formatierung.",
      `Bewerte dieses echte Inserat: ${c.make} ${c.model} ${c.variant || ""}, ` +
      `Baujahr ${c.year}, ${(c.km||0).toLocaleString("de-DE")} km, ${c.fuel}, ${c.power} PS. ` +
      `Preis: ${(c.price||0).toLocaleString("de-DE")} €. ` +
      `Marktdurchschnitt laut KI: ${(c.marketAvg||0).toLocaleString("de-DE")} €. ` +
      `Bewertung: ${c.valueRating}. Quelle: ${c.source}.`,
      200
    );
    res.json({ verdict: text });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GROQ: Preis-Leistungs-Analyse ────────────────────────────────────────────
async function enrichWithGroq(raw) {
  const subset = raw.slice(0, 20).map(c => ({
    id: c.id, make: c.make, model: c.model, year: c.year, km: c.km, price: c.price, fuel: c.fuel,
  }));

  const system =
    "Du bist Automobil-Marktanalyst für Deutschland. " +
    "Antworte AUSSCHLIESSLICH mit einem JSON-Array. Kein Text davor oder danach. Kein Markdown.";

  const user =
    `Analysiere diese echten Fahrzeuginserate und ergänze für jedes:\n` +
    `- marketAvg: realistischer Marktdurchschnittspreis in EUR (2024/2025)\n` +
    `- valueRating: "gut" (>5% unter Markt), "ok" (±5%), "hoch" (>5% über Markt)\n` +
    `- valueNote: kurze Erklärung z.B. "9% unter Marktdurchschnitt"\n\n` +
    `Antworte NUR mit diesem JSON-Array (gleiche Reihenfolge wie Eingabe):\n` +
    `[{"id":"...","marketAvg":0,"valueRating":"ok","valueNote":"..."}]\n\n` +
    `Fahrzeuge:\n${JSON.stringify(subset)}`;

  const text = await ai(system, user, 1000);

  // Robust JSON extrahieren
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

// ── START ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════════╗
║         AutoAI Backend – Groq Edition        ║
║   KI: Llama 3.3 70B via Groq (KOSTENLOS)    ║
║   http://localhost:${PORT}                       ║
╚══════════════════════════════════════════════╝
  `);
});
