// Pipeline Agendas completo: lista todas las oportunidades del pipeline "Agendas"
// de GoHighLevel creadas en el período, con su etapa y su fuente. Solo lectura.
import { timingSafeEqual } from "node:crypto";

const env = (k, d) => process.env[k] || d;
const GHL_TOKEN = env("GHL_TOKEN");
const GHL_LOCATION = env("GHL_LOCATION", "x7nYndpXUc1dmpunATsZ");
const GHL_PIPELINE = env("GHL_PIPELINE", "Hdnl2Kgw5kRk1rCNrwYW");
const PASSWORD = env("DASHBOARD_PASSWORD");
const MAX_DAYS = 31;
const DAY = 864e5;

const cache = new Map(); // caché corta por instancia
const CACHE_MS = 2 * 60 * 1000;

const json = (status, body) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });

function passOk(given) {
  if (!PASSWORD || !given) return false;
  const a = Buffer.from(String(given)), b = Buffer.from(PASSWORD);
  return a.length === b.length && timingSafeEqual(a, b);
}

/* ---------- fechas (hora de Argentina, UTC-3) ---------- */
const isDay = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || "");
const dayStart = (k) => new Date(k + "T00:00:00-03:00").getTime();
const dayKey = (ms) => new Date(ms - 3 * 3600e3).toISOString().slice(0, 10);
const hhmm = (ms) => new Date(ms - 3 * 3600e3).toISOString().slice(11, 16);

/* ---------- texto ---------- */
const norm = (s) =>
  (s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
const toks = (s) => norm(s).split(" ").filter((w) => w.length > 1);

/* ---------- GoHighLevel ---------- */
async function ghl(path, params) {
  const u = new URL("https://services.leadconnectorhq.com" + path);
  for (const [k, v] of Object.entries(params || {})) if (v !== undefined && v !== "") u.searchParams.set(k, String(v));
  const r = await fetch(u, {
    headers: { Authorization: `Bearer ${GHL_TOKEN}`, Version: "2021-07-28", Accept: "application/json" },
  });
  if (!r.ok) throw { where: "ghl", code: `http_${r.status}`, detail: (await r.text()).slice(0, 300) };
  return r.json();
}
async function stageMap() {
  const j = await ghl("/opportunities/pipelines", { locationId: GHL_LOCATION });
  const p = (j.pipelines || []).find((x) => x.id === GHL_PIPELINE);
  if (!p) throw { where: "ghl", code: "pipeline_not_found" };
  return Object.fromEntries((p.stages || []).map((s) => [s.id, s.name]));
}
function slim(o, stages) {
  return {
    name: o.name || "",
    contact: o.contact?.name || "",
    email: o.contact?.email || "",
    stage: stages[o.pipelineStageId] || "Sin etapa",
    created: Date.parse(o.createdAt || o.dateAdded || 0) || 0,
    changed: Date.parse(o.lastStageChangeAt || o.updatedAt || o.createdAt || 0) || 0,
    source: o.source || "",
  };
}
async function searchOpps(stages, { q, sinceMs, max = 1500 }) {
  const out = [];
  let startAfter, startAfterId;
  for (let page = 0; page < Math.ceil(max / 100); page++) {
    const j = await ghl("/opportunities/search", {
      location_id: GHL_LOCATION, pipeline_id: GHL_PIPELINE, limit: 100, q, startAfter, startAfterId,
    });
    const items = j.opportunities || [];
    for (const o of items) out.push(slim(o, stages));
    startAfter = j.meta?.startAfter; startAfterId = j.meta?.startAfterId;
    const oldest = items.length ? Math.min(...items.map((o) => Date.parse(o.createdAt || 0) || 0)) : 0;
    if (!items.length || !startAfterId || (sinceMs && oldest < sinceMs)) break;
  }
  return sinceMs ? out.filter((o) => o.created >= sinceMs) : out;
}

/* ---------- cruce ---------- */
function stageCat(n) {
  const s = norm(n);
  if (s.startsWith("nutricion") || /^(asistencia|no asistio|sena|venta)/.test(s)) return "con";
  if (s.startsWith("descualificado") && s.includes("nicho")) return "pn";
  if (s.startsWith("descualificado")) return "pi";
  if (s.startsWith("cancelado")) return "ca";
  if (s.startsWith("triaje")) return "tri";
  if (s.startsWith("nuevo lead") || s.startsWith("lead confirmar")) return "sin";
  return "abi";
}
/* ---------- vista completa ---------- */
function srcCode(source) {
  const s = norm(source);
  if (!s) return "M";
  if (s.includes("bio")) return "B";
  if (s === "vsl") return "A";
  if (s.includes("audit") || s.includes("webinar")) return "W";
  if (s.includes("solicitud") || s.includes("formulario")) return "F";
  return "O";
}
async function buildAll(from, to) {
  const stages = await stageMap();
  const start = dayStart(from), end = dayStart(to) + DAY;
  const opps = (await searchOpps(stages, { sinceMs: start, max: 3000 })).filter((o) => o.created < end);
  return opps.sort((a, b) => b.created - a.created).map((o) => {
    const stage = o.stage.replace(/\s*\|S$/, "");
    return {
      name: o.contact || o.name, email: o.email, day: dayKey(o.created), time: hhmm(o.created),
      src: srcCode(o.source), source: o.source || "", stage, cat: stageCat(stage), why: null,
    };
  });
}

export default async (req) => {
  if (!GHL_TOKEN || !PASSWORD) return json(500, { error: "config", message: "Faltan variables de entorno en Netlify (GHL_TOKEN o DASHBOARD_PASSWORD)." });
  if (!passOk(req.headers.get("x-pass"))) return json(401, { error: "auth", message: "Contraseña incorrecta." });
  const url = new URL(req.url);
  let from = url.searchParams.get("from"), to = url.searchParams.get("to");
  if (!isDay(from) || !isDay(to)) return json(400, { error: "range", message: "Fechas inválidas." });
  if (from > to) [from, to] = [to, from];
  if ((dayStart(to) - dayStart(from)) / DAY + 1 > MAX_DAYS) from = dayKey(dayStart(to) - (MAX_DAYS - 1) * DAY + 12 * 3600e3);
  const key = from + "|" + to;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS && !url.searchParams.has("fresh")) return json(200, { from, to, updatedAt: hit.at, rows: hit.rows });
  try {
    const rows = await buildAll(from, to);
    const at = Date.now();
    cache.set(key, { at, rows });
    return json(200, { from, to, updatedAt: at, rows });
  } catch (e) {
    const where = e?.where || "server";
    const msgs = {
      http_401: "El token de GoHighLevel es inválido o venció.",
      http_403: "Al token de GoHighLevel le faltan permisos (ver oportunidades).",
      pipeline_not_found: "No se encontró el pipeline Agendas en GoHighLevel.",
    };
    return json(502, { error: where, code: e?.code, message: msgs[e?.code] || `Falló ${where === "ghl" ? "GoHighLevel" : "el servidor"} (${e?.code || e?.message || "error"}).` });
  }
};

export const config = { path: "/api/pipeline" };
