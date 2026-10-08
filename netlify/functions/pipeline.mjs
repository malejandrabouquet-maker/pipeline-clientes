// Pipeline Agendas completo: lista todas las oportunidades del pipeline "Agendas"
// de GoHighLevel creadas en el período, con su etapa y su fuente. Solo lectura.
import { timingSafeEqual } from "node:crypto";

const env = (k, d) => process.env[k] || d;
const GHL_TOKEN = env("GHL_TOKEN");
const GHL_LOCATION = env("GHL_LOCATION", "x7nYndpXUc1dmpunATsZ");
const GHL_PIPELINE = env("GHL_PIPELINE", "Hdnl2Kgw5kRk1rCNrwYW");          // Agendas
const GHL_PIPE_WEBINAR = env("GHL_PIPE_WEBINAR", "kY28NRmKxkvrkAUm1tOq"); // WEBINAR
const GHL_PIPE_SEG = env("GHL_PIPE_SEG", "5pgmx29qxGQt7GpypecG");         // Seguimientos
const PASSWORD = env("DASHBOARD_PASSWORD");
const MAX_DAYS = 31;
const DAY = 864e5;

const cache = new Map(); // caché corta por instancia
const CACHE_MS = 5 * 60 * 1000;

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
  // Si GHL responde 429 (demasiadas consultas juntas), espera y reintenta.
  for (let attempt = 0; ; attempt++) {
    const r = await fetch(u, {
      headers: { Authorization: `Bearer ${GHL_TOKEN}`, Version: "2021-07-28", Accept: "application/json" },
    });
    if (r.status === 429 && attempt < 3) {
      const ra = parseFloat(r.headers.get("retry-after") || "");
      const wait = Math.min(Number.isFinite(ra) ? ra * 1000 : 800 * (attempt + 1), 2500);
      await new Promise((res) => setTimeout(res, wait));
      continue;
    }
    if (!r.ok) throw { where: "ghl", code: `http_${r.status}`, detail: (await r.text()).slice(0, 300) };
    return r.json();
  }
}
async function stageMap() {
  const j = await ghl("/opportunities/pipelines", { locationId: GHL_LOCATION });
  const pipes = j.pipelines || [];
  if (!pipes.some((x) => x.id === GHL_PIPELINE)) throw { where: "ghl", code: "pipeline_not_found" };
  // Mapa de etapas de Agendas, WEBINAR y Seguimientos, y la lista de etapas de cada uno.
  const map = {}, byPipe = {};
  for (const x of pipes) {
    if (![GHL_PIPELINE, GHL_PIPE_WEBINAR, GHL_PIPE_SEG].includes(x.id)) continue;
    byPipe[x.id] = (x.stages || []).map((s) => ({ id: s.id, name: s.name }));
    for (const s of x.stages || []) map[s.id] = s.name;
  }
  return { map, byPipe };
}
function slim(o, stages) {
  return {
    name: o.name || "",
    contact: o.contact?.name || "",
    email: o.contact?.email || "",
    contactId: o.contactId || o.contact?.id || "",
    tags: (o.contact?.tags || []).map((x) => norm(x)),
    stage: stages[o.pipelineStageId] || "Sin etapa",
    created: Date.parse(o.createdAt || o.dateAdded || 0) || 0,
    changed: Date.parse(o.lastStageChangeAt || o.updatedAt || o.createdAt || 0) || 0,
    source: o.source || "",
    stageAt: Date.parse(o.lastStageChangeAt || o.createdAt || o.dateAdded || 0) || 0,
  };
}
async function searchOpps(stages, { q, sinceMs, max = 1500, stageId, pipelineId = GHL_PIPELINE }) {
  const out = [];
  let startAfter, startAfterId;
  for (let page = 0; page < Math.ceil(max / 100); page++) {
    const j = await ghl("/opportunities/search", {
      location_id: GHL_LOCATION, pipeline_id: pipelineId, pipeline_stage_id: stageId, limit: 100, q, startAfter, startAfterId,
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
// Filtra por la fecha del último cambio de etapa. Como GHL no permite buscar
// por esa fecha, se consulta cada etapa en paralelo (ordenadas de la más nueva
// a la más vieja) y se miran las oportunidades creadas hasta LOOKBACK_DAYS
// antes del inicio del período.
const LOOKBACK_DAYS = 90;

// Etapas de WEBINAR → columna del tablero. "Agendado" no se cuenta: esa persona ya está en Agendas.
function webinarStage(name) {
  const s = norm(name);
  if (s.startsWith("agendado")) return null;
  if (s.startsWith("low ticket")) return { stage: "Low ticket", cat: "form" };
  if (s.startsWith("datos erroneos")) return { stage: "Datos erróneos", cat: "de" };
  if (s.startsWith("descualificado")) return { stage: "Descualificado por nicho", cat: "pn" };
  if (s.startsWith("new lead")) return { stage: "New Lead (webinar)", cat: "sin" };
  return { stage: name + " (webinar)", cat: "rev" };
}
// En Seguimientos solo cuentan los leads de webinar que descalificó el form.
const isFormDisq = (o) =>
  /perdido|descualificado/.test(norm(o.stage)) &&
  (o.tags.some((x) => x.includes("descualificado webinar")) || norm(o.source).includes("audit"));

async function buildAll(from, to) {
  const { map: stages, byPipe } = await stageMap();
  const start = dayStart(from), end = dayStart(to) + DAY;
  const since = start - LOOKBACK_DAYS * DAY;
  const inRange = (o) => o.stageAt >= start && o.stageAt < end;
  const closer = (n) => /^(asistencia|no asistio|sena|venta)/.test(norm(n));

  // 1) Agendas: cada etapa por separado, de a 3 por vez para no saturar a GoHighLevel.
  const agIds = (byPipe[GHL_PIPELINE] || []).map((s) => s.id), agendas = [];
  for (let i = 0; i < agIds.length; i += 3) {
    const batch = await Promise.all(agIds.slice(i, i + 3).map((stageId) => searchOpps(stages, { stageId, sinceMs: since, max: 2000 })));
    batch.forEach((b) => agendas.push(...b));
  }
  // 2) WEBINAR completo y 3) Seguimientos solo en sus etapas de descalificados.
  const segIds = (byPipe[GHL_PIPE_SEG] || []).filter((s) => /perdido|descualificado/.test(norm(s.name))).map((s) => s.id);
  const [webinar, ...segParts] = await Promise.all([
    byPipe[GHL_PIPE_WEBINAR] ? searchOpps(stages, { sinceMs: since, max: 2000, pipelineId: GHL_PIPE_WEBINAR }) : [],
    ...segIds.map((stageId) => searchOpps(stages, { stageId, sinceMs: start - 3 * DAY, max: 3000, pipelineId: GHL_PIPE_SEG })),
  ]);
  const seg = segParts.flat();

  // Cada persona se cuenta una sola vez: primero Agendas, después WEBINAR, después Seguimientos.
  const seen = new Set();
  const key = (o) => o.contactId || norm(o.contact || o.name) + "|" + o.email;
  const take = (o) => { const k = key(o); if (seen.has(k)) return false; seen.add(k); return true; };
  const rows = [];
  const push = (o, src, stage, cat) => rows.push({
    name: o.contact || o.name, email: o.email, day: dayKey(o.stageAt), time: hhmm(o.stageAt), at: o.stageAt,
    src, source: o.source || "", stage, cat, why: null,
  });

  const recent = (a, b) => b.stageAt - a.stageAt;
  agendas.sort(recent); webinar.sort(recent); seg.sort(recent);
  for (const o of agendas) {
    if (!take(o)) continue; // la persona está en Agendas: manda su etapa ahí (aunque esté fuera del período)
    if (closer(o.stage) || !inRange(o)) continue;
    const stage = o.stage.replace(/\s*\|S$/, "");
    push(o, srcCode(o.source), stage, stageCat(stage));
  }
  for (const o of webinar) {
    const w = webinarStage(o.stage);
    if (!w) { seen.add(key(o)); continue; } // Agendado: ya cuenta en Agendas
    if (!take(o) || !inRange(o)) continue;
    push(o, "W", w.stage, w.cat);
  }
  for (const o of seg) {
    if (!isFormDisq(o) || !take(o) || !inRange(o)) continue;
    push(o, "W", "Descalificado por el form", "form");
  }
  return rows.sort((a, b) => b.at - a.at).map(({ at, ...r }) => r);
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
      http_429: "GoHighLevel recibió demasiadas consultas juntas. Esperá un minuto y tocá Actualizar.",
      pipeline_not_found: "No se encontró el pipeline Agendas en GoHighLevel.",
    };
    return json(502, { error: where, code: e?.code, message: msgs[e?.code] || `Falló ${where === "ghl" ? "GoHighLevel" : "el servidor"} (${e?.code || e?.message || "error"}).` });
  }
};

export const config = { path: "/api/pipeline" };
