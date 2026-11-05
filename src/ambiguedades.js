// Ambigüedades y preguntas para el PO/negocio que deja el diseño de casos: normalización (resultados viejos traían
// solo texto) y documento Word para enviarlas al negocio, agrupadas por criterio de aceptación o en una lista general.
import { AlignmentType, Document, Footer, HeadingLevel, PageNumber, Packer, Paragraph, TextRun } from "docx";
import { AZUL, texto, parrafo, tabla } from "./estimacion.js";

export const GENERAL = "General";

/** [{ criterio, pregunta }]: acepta también el formato anterior (lista de textos), que queda como "General". */
export function normalizarAmbiguedades(lista) {
  return (Array.isArray(lista) ? lista : [])
    .map((a) =>
      typeof a === "string"
        ? { criterio: GENERAL, pregunta: a }
        : {
            criterio: String(a?.criterio ?? "").trim() || GENERAL,
            pregunta: String(a?.pregunta ?? "").trim(),
            ...(a?.hu_id ? { hu_id: a.hu_id, hu_titulo: a.hu_titulo ?? "" } : {}),
          },
    )
    .filter((a) => a.pregunta);
}

/** Grupos en el orden de los criterios; lo que no corresponde a un criterio conocido va a "General", al final. */
export function agruparPorCriterio(datos) {
  const criterios = datos.criterios_aceptacion ?? [];
  const conocidos = new Set(criterios.map((c) => c.id));
  const grupos = new Map(criterios.map((c) => [c.id, { id: c.id, descripcion: c.descripcion, preguntas: [] }]));
  const general = { id: GENERAL, descripcion: "Afecta al requerimiento en general o a varios criterios", preguntas: [] };
  for (const a of normalizarAmbiguedades(datos.ambiguedades_y_preguntas)) (conocidos.has(a.criterio) ? grupos.get(a.criterio) : general).preguntas.push(a.pregunta);
  return [...grupos.values(), general].filter((g) => g.preguntas.length);
}

/** Word para el negocio. modo: "criterio" (una tabla por criterio ambiguo) o "general" (una sola lista numerada). */
export async function generarDocxAmbiguedades(datos, { modo = "criterio", analista = "" } = {}) {
  const lista = normalizarAmbiguedades(datos.ambiguedades_y_preguntas);
  if (!lista.length) throw new Error("El requerimiento no tiene ambigüedades para descargar.");
  const hu = datos.hu;
  const titulo = (t) => new Paragraph({ text: t, heading: HeadingLevel.HEADING_1, spacing: { before: 240, after: 120 } });
  const descripcionDe = new Map((datos.criterios_aceptacion ?? []).map((c) => [c.id, c.descripcion]));
  const grupos = agruparPorCriterio(datos);

  const hijos = [
    new Paragraph({ children: [texto("AMBIGÜEDADES Y PREGUNTAS DEL REQUERIMIENTO", { bold: true, size: 32, color: AZUL })], alignment: AlignmentType.CENTER, spacing: { after: 60 } }),
    new Paragraph({ children: [texto(hu?.id ? `HU #${hu.id} · ${hu.titulo ?? datos.titulo_requerimiento ?? ""}` : datos.titulo_requerimiento || "Requerimiento", { bold: true, size: 26 })], alignment: AlignmentType.CENTER, spacing: { after: 240 } }),
    tabla(
      [
        ["Dato", "Valor"],
        ...(hu?.enlace ? [["Historia de usuario", hu.enlace]] : []),
        ["Preguntas", String(lista.length)],
        ["Criterios con ambigüedades", `${grupos.filter((g) => g.id !== GENERAL).length} de ${(datos.criterios_aceptacion ?? []).length}`],
        ["Preguntas generales", String(grupos.find((g) => g.id === GENERAL)?.preguntas.length ?? 0)],
      ],
      [32, 68],
    ),
    titulo("Propósito"),
    parrafo("Durante el diseño de los casos de prueba se identificaron puntos del requerimiento que no están definidos o admiten más de una interpretación. Se solicita al negocio responder cada pregunta para completar las pruebas sin suponer comportamientos. Puede escribir la respuesta en la columna \"Respuesta del negocio\"."),
  ];

  if (datos.resumen_requerimiento) hijos.push(titulo("Resumen del requerimiento"), parrafo(datos.resumen_requerimiento));

  if (modo === "general") {
    hijos.push(
      titulo("Preguntas"),
      tabla(
        [
          ["#", "Criterio", "Pregunta", "Respuesta del negocio"],
          ...lista.map((a, i) => [String(i + 1), descripcionDe.has(a.criterio) ? a.criterio : GENERAL, a.pregunta, ""]),
        ],
        [6, 12, 47, 35],
      ),
    );
  } else {
    hijos.push(titulo("Preguntas por criterio de aceptación"));
    let n = 0;
    for (const g of grupos) {
      hijos.push(
        new Paragraph({ children: [texto(g.id === GENERAL ? "General" : g.id, { bold: true, color: AZUL }), texto(` · ${g.descripcion}`)], spacing: { before: 200, after: 80 } }),
        tabla(
          [
            ["#", "Pregunta", "Respuesta del negocio"],
            ...g.preguntas.map((q) => [String(++n), q, ""]),
          ],
          [6, 54, 40],
        ),
      );
    }
  }

  if (datos.supuestos?.length) {
    hijos.push(
      titulo("Supuestos adoptados mientras se responde"),
      parrafo("Para no detener el diseño, los casos afectados se redactaron con estos supuestos. Si alguno no es correcto, indíquelo."),
      ...datos.supuestos.map((s) => new Paragraph({ children: [texto(s)], bullet: { level: 0 }, spacing: { after: 60 } })),
    );
  }

  hijos.push(
    parrafo([texto(`Generado el ${new Date().toLocaleString("es-DO", { dateStyle: "long", timeStyle: "short" })}${analista ? ` por ${analista}` : ""} con el Ecosistema de Aseguramiento de Calidad TI.`, { size: 18, color: "667085" })], { spacing: { before: 240 } }),
  );

  const doc = new Document({
    creator: "Ecosistema de Aseguramiento de Calidad TI",
    title: `Ambigüedades - ${hu?.id ? `HU ${hu.id}` : datos.titulo_requerimiento ?? "Requerimiento"}`,
    styles: { default: { document: { run: { font: "Calibri", size: 21 } } } },
    sections: [
      {
        properties: { page: { margin: { top: 1000, bottom: 1000, left: 1000, right: 1000 } } },
        footers: {
          default: new Footer({
            children: [new Paragraph({ alignment: AlignmentType.RIGHT, children: [texto("Página ", { size: 16, color: "667085" }), new TextRun({ children: [PageNumber.CURRENT], size: 16, color: "667085" })] })],
          }),
        },
        children: hijos,
      },
    ],
  });
  return Packer.toBuffer(doc);
}

/**
 * Word consolidado de un lote por sprint: todas las preguntas en una tabla con columnas
 * HU, Criterio y Pregunta, ordenadas por HU y criterio.
 */
export async function generarDocxAmbiguedadesLote(datos, { analista = "" } = {}) {
  const lista = normalizarAmbiguedades(datos.ambiguedades_y_preguntas);
  if (!lista.length) throw new Error("El lote no tiene ambigüedades para descargar.");
  const hus = datos.lote?.hus ?? [...new Map(lista.map((a) => [a.hu_id, { id: a.hu_id, titulo: a.hu_titulo }])).values()];
  const titulo = (t) => new Paragraph({ text: t, heading: HeadingLevel.HEADING_1, spacing: { before: 240, after: 120 } });
  const ordenadas = [...lista].sort(
    (a, b) => String(a.hu_id ?? "").localeCompare(String(b.hu_id ?? ""), "es") || String(a.criterio).localeCompare(String(b.criterio), "es"),
  );
  const filas = ordenadas.map((a, i) => [String(i + 1), a.hu_id ? `#${a.hu_id}` : "—", a.hu_id ? String(a.criterio).replace(`H${a.hu_id}-`, "") : a.criterio, a.pregunta, ""]);
  const hijos = [
    new Paragraph({ children: [texto("AMBIGÜEDADES Y PREGUNTAS DEL LOTE", { bold: true, size: 32, color: AZUL })], alignment: AlignmentType.CENTER, spacing: { after: 60 } }),
    new Paragraph({ children: [texto(datos.lote?.sprint?.nombre ?? datos.titulo_requerimiento ?? "", { bold: true, size: 26 })], alignment: AlignmentType.CENTER, spacing: { after: 240 } }),
    tabla(
      [
        ["Dato", "Valor"],
        ["HUs del lote", String(hus.length)],
        ["Preguntas", String(lista.length)],
        ["HUs con preguntas", String(new Set(lista.map((a) => a.hu_id).filter(Boolean)).size)],
      ],
      [32, 68],
    ),
    titulo("Propósito"),
    parrafo("Durante el diseño masivo de casos por sprint se identificaron puntos que no están definidos o admiten más de una interpretación. Se solicita al negocio responder cada pregunta indicando la HU y el criterio afectado."),
    titulo("Preguntas por HU y criterio"),
    tabla([["#", "HU", "Criterio", "Pregunta", "Respuesta del negocio"], ...filas], [5, 8, 14, 43, 30]),
  ];
  if (datos.supuestos?.length) {
    hijos.push(
      titulo("Supuestos adoptados mientras se responde"),
      parrafo("Para no detener el diseño, los casos afectados se redactaron con estos supuestos. Si alguno no es correcto, indíquelo."),
      ...datos.supuestos.map((s) => new Paragraph({ children: [texto(s)], bullet: { level: 0 }, spacing: { after: 60 } })),
    );
  }
  hijos.push(
    parrafo([texto(`Generado el ${new Date().toLocaleString("es-DO", { dateStyle: "long", timeStyle: "short" })}${analista ? ` por ${analista}` : ""} con el Ecosistema de Aseguramiento de Calidad TI.`, { size: 18, color: "667085" })], { spacing: { before: 240 } }),
  );
  const doc = new Document({
    creator: "Ecosistema de Aseguramiento de Calidad TI",
    title: `Ambigüedades - ${datos.lote?.sprint?.nombre ?? "Lote por sprint"}`,
    styles: { default: { document: { run: { font: "Calibri", size: 21 } } } },
    sections: [
      {
        properties: { page: { margin: { top: 1000, bottom: 1000, left: 1000, right: 1000 } } },
        footers: {
          default: new Footer({
            children: [new Paragraph({ alignment: AlignmentType.RIGHT, children: [texto("Página ", { size: 16, color: "667085" }), new TextRun({ children: [PageNumber.CURRENT], size: 16, color: "667085" })] })],
          }),
        },
        children: hijos,
      },
    ],
  });
  return Packer.toBuffer(doc);
}
