// Aplicativo de ambigüedades: consulta HUs de Azure DevOps (una o un sprint) y devuelve SOLO las
// ambigüedades y preguntas de cada HU. Reutiliza el cliente de Azure y los proveedores de IA del
// Ecosistema de Aseguramiento de Calidad TI.
import "./src/env.js";
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  obtenerHU,
  listarProyectos,
  listarSprints,
  listarAreas,
  historiasParaDisenar,
  azureConfigurado,
  infoAzure,
  conPAT,
} from "./src/azure-devops.js";
import { analizarAmbiguedades, infoIA } from "./src/ia.js";
import { detectarProveedor } from "./src/proveedor-clave.js";
import { generarDocxAmbiguedades, generarDocxAmbiguedadesLote } from "./src/ambiguedades.js";

const aqui = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json({ limit: "80mb" }));
app.use(express.static(path.join(aqui, "public")));

/** Envuelve una ruta async y devuelve el error como JSON. */
const ruta = (fn) => (req, res) =>
  Promise.resolve(fn(req, res)).catch((err) => {
    const status = Number(err?.status) || 400;
    console.error(`[ambigüedades] ${err?.message ?? err}`);
    if (!res.headersSent) res.status(status).json({ error: err?.message ?? String(err) });
  });

/** Ejecuta una llamada a Azure con el PAT de la persona (encabezado X-Azure-Pat) o el del .env. */
const conAzure = (req, fn) => {
  const pat = String(req.get("x-azure-pat") ?? "").trim();
  return pat ? conPAT(pat, fn) : fn();
};

/** Conexión de IA enviada por el navegador (X-IA-Config, JSON en base64). */
function iaDeSolicitud(req) {
  const crudo = req.get("x-ia-config");
  if (!crudo) return null;
  try {
    const c = JSON.parse(Buffer.from(crudo, "base64").toString("utf8"));
    const apiKey = String(c?.apiKey ?? "").trim().slice(0, 500);
    const baseUrl = String(c?.baseUrl ?? "").trim().replace(/\/+$/, "").slice(0, 300);
    const modelo = String(c?.modelo ?? "").trim().slice(0, 120);
    // La API key define el proveedor; el campo `proveedor` solo se usa si la clave no se reconoce.
    const detectado = detectarProveedor(apiKey, { baseUrl, modelo });
    const proveedor = detectado?.proveedor ?? (["gemini", "anthropic", "openai"].includes(c?.proveedor) ? c.proveedor : "");
    if (!proveedor) return null;
    return {
      proveedor,
      nombre: detectado?.nombre || String(c.nombre ?? "").trim().slice(0, 60),
      apiKey,
      modelo,
      baseUrl: baseUrl || detectado?.baseUrl || "",
    };
  } catch {
    return null;
  }
}

app.get("/api/config", (_req, res) => {
  res.json({
    azure: { configurado: azureConfigurado(), ...infoAzure() },
    ia: infoIA(),
  });
});

app.get(
  "/api/proyectos",
  ruta(async (req, res) => res.json(await conAzure(req, () => listarProyectos()))),
);

app.get(
  "/api/proyectos/:proyecto/sprints",
  ruta(async (req, res) => res.json({ sprints: await conAzure(req, () => listarSprints(req.params.proyecto)) })),
);

app.get(
  "/api/proyectos/:proyecto/areas",
  ruta(async (req, res) => res.json({ areas: await conAzure(req, () => listarAreas(req.params.proyecto)) })),
);

app.get(
  "/api/azure/sprint/hus",
  ruta(async (req, res) => {
    const { proyecto = "", ruta: sprint = "", area = "" } = req.query;
    if (!String(sprint).trim()) return res.status(400).json({ error: "Seleccione un sprint." });
    res.json({ hus: await conAzure(req, () => historiasParaDisenar(sprint, area, proyecto)) });
  }),
);

app.post(
  "/api/analizar-hu",
  ruta(async (req, res) => {
    const id = Number(req.body?.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "Indique un ID de HU válido." });
    const hu = await conAzure(req, () => obtenerHU(id));
    if (!String(hu.textoRequerimiento ?? "").trim()) {
      throw new Error(`La HU #${id} no tiene descripción ni criterios de aceptación para analizar.`);
    }
    const { datos, meta } = await analizarAmbiguedades({ texto: hu.textoRequerimiento, imagenes: hu.imagenes, ia: iaDeSolicitud(req) });
    res.json({
      hu: {
        id: hu.id,
        titulo: hu.titulo,
        tipo: hu.tipo,
        estado: hu.estado,
        asignado: hu.asignado,
        area: hu.area,
        iteracion: hu.iteracion,
        enlace: hu.enlace,
        casosVinculados: hu.casosVinculados,
        advertencias: hu.advertencias,
      },
      datos,
      meta,
    });
  }),
);

app.post(
  "/api/analizar-texto",
  ruta(async (req, res) => {
    const texto = String(req.body?.texto ?? "").trim();
    if (!texto) return res.status(400).json({ error: "El archivo no tiene texto para analizar." });
    const { datos, meta } = await analizarAmbiguedades({ texto, ia: iaDeSolicitud(req) });
    res.json({ datos, meta });
  }),
);

app.post(
  "/api/docx",
  ruta(async (req, res) => {
    const { datos, modo = "criterio", analista = "" } = req.body ?? {};
    const buffer = await generarDocxAmbiguedades(datos, { modo, analista });
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    res.setHeader("Content-Disposition", `attachment; filename="ambiguedades-HU-${datos?.hu?.id ?? "requerimiento"}.docx"`);
    res.send(buffer);
  }),
);

app.post(
  "/api/docx-lote",
  ruta(async (req, res) => {
    const { datos, analista = "" } = req.body ?? {};
    const buffer = await generarDocxAmbiguedadesLote(datos, { analista });
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    res.setHeader("Content-Disposition", 'attachment; filename="ambiguedades-sprint.docx"');
    res.send(buffer);
  }),
);

const puerto = Number(process.env.PORT_AMBIGUEDADES) || Number(process.env.PORT) || 3300;
const host = process.env.HOST || "127.0.0.1";
app.listen(puerto, host, () => {
  const az = azureConfigurado() ? "configurado" : "NO configurado";
  const ia = infoIA();
  console.log("");
  console.log("  Ambigüedades de HUs · Ecosistema de Aseguramiento de Calidad TI");
  console.log("  -------------------------------------------------------------");
  console.log(`  Escuchando en: http://${host}:${puerto}`);
  console.log(`  Azure DevOps:  ${az}`);
  console.log(`  IA:            ${ia.proveedor}${ia.modelo ? ` · ${ia.modelo}` : ""}${ia.configurado ? "" : " (sin credenciales)"}`);
  console.log("");
});
