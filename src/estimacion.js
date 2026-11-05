// Estimado del tiempo de ejecución manual de los casos de prueba de un sprint (o de una sola HU): historias con sus casos de prueba
// (pasos y prioridad), calculado con una fórmula por pasos y exportado a Word con el estilo del acta.
import {
  AlignmentType,
  BorderStyle,
  Document,
  Footer,
  HeadingLevel,
  PageNumber,
  Packer,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from "docx";

/**
 * Parámetros por defecto de la fórmula (el analista los ajusta en pantalla). Calibrados para casos manuales cortos:
 * un caso de login de 3 pasos se ejecuta en unos 5 minutos (35 casos de la HU 23055 ≈ 3,2 h).
 */
export const PARAMETROS_DEFECTO = Object.freeze({
  minutosPreparacionCaso: 2,
  minutosPorPaso: 1,
  pasosSupuestosSinPasos: 3,
  factorAlta: 1.3,
  factorMedia: 1,
  factorBaja: 0.8,
  minutosPreparacionHU: 15,
  // 1 día = jornada de 8:00 a 5:00 p. m. (9 h), menos el almuerzo si se indica.
  horaInicio: 8,
  horaFin: 17,
  almuerzoHoras: 0,
  analistas: 1,
});

const LIMITES = {
  minutosPreparacionCaso: [0, 240],
  minutosPorPaso: [0, 120],
  pasosSupuestosSinPasos: [0, 100],
  factorAlta: [0.1, 5],
  factorMedia: [0.1, 5],
  factorBaja: [0.1, 5],
  minutosPreparacionHU: [0, 960],
  horaInicio: [0, 23],
  horaFin: [1, 24],
  almuerzoHoras: [0, 4],
  analistas: [1, 50],
};

/** Parámetros válidos: los recibidos dentro de sus límites, o el valor por defecto. */
export function normalizarParametros(p = {}) {
  const salida = {};
  for (const [clave, defecto] of Object.entries(PARAMETROS_DEFECTO)) {
    const n = Number(p?.[clave]);
    const [min, max] = LIMITES[clave];
    salida[clave] = Number.isFinite(n) && n >= min && n <= max ? n : defecto;
  }
  salida.analistas = Math.round(salida.analistas);
  if (horasDeJornada(salida) < 1) Object.assign(salida, { horaInicio: PARAMETROS_DEFECTO.horaInicio, horaFin: PARAMETROS_DEFECTO.horaFin, almuerzoHoras: PARAMETROS_DEFECTO.almuerzoHoras });
  return salida;
}

/** Horas de trabajo de un día: de la hora de inicio a la de fin, menos el almuerzo. */
export const horasDeJornada = (p) => p.horaFin - p.horaInicio - p.almuerzoHoras;

/** "8:00 a. m." a partir de una hora en número (8, 17, 8.5…). */
export function textoHora(h) {
  const hora = Math.floor(h);
  const minutos = Math.round((h - hora) * 60);
  const h12 = hora % 12 || 12;
  return `${h12}:${String(minutos).padStart(2, "0")} ${hora < 12 ? "a. m." : "p. m."}`;
}

/** Jornada en texto: "8:00 a. m. a 5:00 p. m. (9 h)". */
export const textoJornada = (p) =>
  `${textoHora(p.horaInicio)} a ${textoHora(p.horaFin)}${p.almuerzoHoras ? `, menos ${p.almuerzoHoras} h de almuerzo` : ""} (${horasDeJornada(p)} h)`;

/** Días hábiles (lunes a viernes) entre dos fechas ISO, ambas incluidas. */
export function diasHabiles(inicio, fin) {
  if (!inicio || !fin) return 0;
  let n = 0;
  for (let d = new Date(`${inicio}T12:00:00Z`); d <= new Date(`${fin}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + 1)) {
    const dia = d.getUTCDay();
    if (dia !== 0 && dia !== 6) n++;
  }
  return n;
}

const factorDe = (prioridad, p) => ({ Alta: p.factorAlta, Baja: p.factorBaja })[prioridad] ?? p.factorMedia;
const redondear = (n, d = 1) => Math.round(n * 10 ** d) / 10 ** d;

/**
 * Calcula el estimado. `historias`: salida de historiasDelSprint (cada una { hu, casos }).
 * Por caso: (preparación + minutos por paso × pasos) × factor de prioridad. Por HU: + preparación de la HU
 * (datos y ambiente) si tiene casos. Total en horas; días = horas / (horas de la jornada × analistas), con 1 día = jornada de 8 a 5.
 */
export function calcularEstimado(sprint, historias, parametros) {
  const p = normalizarParametros(parametros);
  // Solo cuentan las historias con casos de prueba vinculados; las demás se informan como excluidas.
  const recibidas = (historias ?? []).slice(0, 1000);
  const filas = recibidas.filter((h) => h?.casos?.length).map(({ hu, casos }) => {
    const detalle = (casos ?? []).map((c) => {
      // Desde Azure llegan los pasos (lista); al recalcular, el número ya contado.
      const pasos = Array.isArray(c.pasos) ? c.pasos.length : Math.max(0, Math.round(Number(c.pasos) || 0));
      // Un caso sin pasos en Azure se estima con un número supuesto de pasos (parámetro), no solo con la preparación.
      const pasosCalculo = pasos || p.pasosSupuestosSinPasos;
      const minutos = (p.minutosPreparacionCaso + p.minutosPorPaso * pasosCalculo) * factorDe(c.prioridad, p);
      return { azure_id: c.azure_id, titulo: c.titulo, prioridad: c.prioridad, pasos, pasosCalculo, minutos: redondear(minutos), sinPasos: pasos === 0 };
    });
    const minutosCasos = detalle.reduce((s, c) => s + c.minutos, 0);
    const minutos = detalle.length ? minutosCasos + p.minutosPreparacionHU : 0;
    return {
      hu: { id: hu.id, titulo: hu.titulo, tipo: hu.tipo, estado: hu.estado, enlace: hu.enlace },
      casos: detalle,
      pasos: detalle.reduce((s, c) => s + c.pasos, 0),
      minutos: redondear(minutos),
    };
  });

  const minutosTotales = filas.reduce((s, f) => s + f.minutos, 0);
  const horas = redondear(minutosTotales / 60);
  const horasDia = horasDeJornada(p);
  const capacidadDia = horasDia * p.analistas;
  const dias = redondear(horas / capacidadDia);
  // Días completos y horas sobrantes (con todos los analistas): "1 día y 3.3 h".
  const diasCompletos = Math.floor(horas / capacidadDia + 1e-9);
  const horasSobrantes = redondear(horas - diasCompletos * capacidadDia);
  const habiles = diasHabiles(sprint?.inicio, sprint?.fin);
  const casos = filas.reduce((s, f) => s + f.casos.length, 0);

  return {
    sprint,
    parametros: p,
    generado: new Date().toISOString(),
    historias: filas,
    resumen: {
      historias: filas.length,
      historiasExcluidas: recibidas.length - filas.length,
      casos,
      casosSinPasos: filas.reduce((s, f) => s + f.casos.filter((c) => c.sinPasos).length, 0),
      pasos: filas.reduce((s, f) => s + f.pasos, 0),
      // Pasos con los supuestos de los casos que no tienen pasos en Azure.
      pasosEstimados: filas.reduce((s, f) => s + f.casos.reduce((n, c) => n + c.pasosCalculo, 0), 0),
      porPrioridad: ["Alta", "Media", "Baja"].map((prioridad) => ({
        prioridad,
        casos: filas.reduce((s, f) => s + f.casos.filter((c) => c.prioridad === prioridad).length, 0),
      })),
      horas,
      dias,
      diasCompletos,
      horasSobrantes,
      horasDia,
      jornada: textoJornada(p),
      diasHabilesSprint: habiles,
      capacidadHoras: redondear(habiles * capacidadDia),
      cabe: habiles ? dias <= habiles : null,
    },
  };
}

// ---------------------------------------------------------------- Word

const AZUL = "1F4E79";
const texto = (t, opciones = {}) => new TextRun({ text: String(t ?? ""), ...opciones });
const parrafo = (hijos, opciones = {}) => new Paragraph({ children: Array.isArray(hijos) ? hijos : [texto(hijos)], spacing: { after: 80 }, ...opciones });
const borde = { style: BorderStyle.SINGLE, size: 4, color: "BFBFBF" };
const bordes = { top: borde, bottom: borde, left: borde, right: borde };

function celda(contenido, { ancho, encabezado = false, negrita = false, color, fondo } = {}) {
  return new TableCell({
    children: [parrafo([texto(contenido, { bold: encabezado || negrita, color: encabezado ? "FFFFFF" : color, size: 19 })], { spacing: { after: 0 } })],
    ...(ancho ? { width: { size: ancho, type: WidthType.PERCENTAGE } } : {}),
    ...(encabezado ? { shading: { type: ShadingType.CLEAR, color: "auto", fill: AZUL } } : fondo ? { shading: { type: ShadingType.CLEAR, color: "auto", fill: fondo } } : {}),
    borders: bordes,
    margins: { top: 60, bottom: 60, left: 100, right: 100 },
  });
}

function tabla(filas, anchos) {
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: filas.map(
      (fila, i) =>
        new TableRow({
          tableHeader: i === 0,
          children: fila.map((c, j) =>
            typeof c === "object" && c !== null
              ? celda(c.texto, { ancho: anchos[j], encabezado: i === 0, negrita: c.negrita, color: c.color, fondo: c.fondo })
              : celda(c, { ancho: anchos[j], encabezado: i === 0 }),
          ),
        }),
    ),
  });
}

// Piezas del estilo del acta, reutilizadas por otros documentos Word (ambigüedades).
export { AZUL, texto, parrafo, tabla };

const fechaLarga = (iso) => (iso ? new Date(`${iso.slice(0, 10)}T12:00:00Z`).toLocaleDateString("es-DO", { dateStyle: "long", timeZone: "UTC" }) : "—");
const num = (n) => Number(n).toLocaleString("es-DO", { maximumFractionDigits: 1 });
const horasYMin = (min) => (min >= 60 ? `${num(min / 60)} h` : `${num(min)} min`);
/** "1 día y 3,3 h", "2 días", "4,5 h". */
export const textoDias = (r) =>
  [r.diasCompletos ? `${r.diasCompletos} día${r.diasCompletos === 1 ? "" : "s"}` : "", r.horasSobrantes ? `${num(r.horasSobrantes)} h` : ""].filter(Boolean).join(" y ") || "0 h";

/** Documento Word del estimado. */
export async function generarDocxEstimado(est, { analista = "" } = {}) {
  const { sprint, parametros: p, resumen: r } = est;
  const titulo = (t) => new Paragraph({ text: t, heading: HeadingLevel.HEADING_1, spacing: { before: 240, after: 120 } });
  // Estimado de una sola historia (sprint.huId) o de todas las de un sprint.
  const unaHU = Boolean(sprint?.huId);

  const veredicto =
    r.cabe === null
      ? unaHU
        ? "La historia no está en un sprint con fechas: no se compara con su duración."
        : "El sprint no tiene fechas definidas: no se compara con su duración."
      : r.cabe
        ? `La ejecución estimada (${textoDias(r)}) cabe en los ${r.diasHabilesSprint} días hábiles ${unaHU ? "de su sprint" : "del sprint"}.`
        : `La ejecución estimada (${textoDias(r)}) supera los ${r.diasHabilesSprint} días hábiles ${unaHU ? "de su sprint" : "del sprint"}: considere más analistas o repriorizar.`;

  const hijos = [
    new Paragraph({ children: [texto("ESTIMADO DE EJECUCIÓN DE PRUEBAS", { bold: true, size: 32, color: AZUL })], alignment: AlignmentType.CENTER, spacing: { after: 60 } }),
    new Paragraph({ children: [texto(sprint?.nombre ?? "Sprint", { bold: true, size: 26 })], alignment: AlignmentType.CENTER, spacing: { after: 40 } }),
    new Paragraph({ children: [texto(sprint?.ruta ?? "", { size: 18, color: "667085" })], alignment: AlignmentType.CENTER, spacing: { after: 240 } }),

    tabla(
      [
        ["Dato", "Valor"],
        ...(sprint?.inicio ? [[unaHU ? "Sprint de la historia" : "Sprint", `${fechaLarga(sprint.inicio)} al ${fechaLarga(sprint.fin)} (${r.diasHabilesSprint} días hábiles)`]] : []),
        ...(sprint?.proyecto ? [["Proyecto", sprint.proyecto]] : []),
        ...(unaHU ? [] : [["Ruta de área", sprint?.area || "Todas las áreas del proyecto"]]),
        ...(unaHU ? [] : [["Historias de usuario con casos", `${r.historias}${r.historiasExcluidas ? ` (${r.historiasExcluidas} sin casos de prueba no se tomaron en cuenta)` : ""}`]]),
        ["Casos de prueba", `${r.casos} (${r.porPrioridad.map((x) => `${x.casos} ${x.prioridad.toLowerCase()}`).join(", ")})`],
        ["Pasos a ejecutar", r.pasosEstimados > r.pasos ? `${r.pasosEstimados} (${r.pasosEstimados - r.pasos} supuestos en casos sin pasos)` : String(r.pasos)],
        [{ texto: "Horas estimadas", negrita: true }, { texto: `${num(r.horas)} h`, negrita: true }],
        [{ texto: "Días estimados", negrita: true }, { texto: `${textoDias(r)} (${num(r.dias)} jornadas) con ${p.analistas} analista(s); 1 día = jornada de ${r.jornada}`, negrita: true }],
        ...(r.diasHabilesSprint ? [["Capacidad del sprint", `${num(r.capacidadHoras)} h`]] : []),
        [{ texto: "Resultado", negrita: true }, { texto: veredicto, negrita: true, color: r.cabe === false ? "B42318" : r.cabe ? "067647" : undefined }],
      ],
      [32, 68],
    ),

    titulo("Alcance"),
    parrafo(`El estimado cubre la ejecución manual de los casos de prueba vinculados (relación "Tested By") ${unaHU ? `a la historia de usuario #${sprint.huId}` : `a las historias de usuario y PBI del sprint${sprint?.area ? ` en la ruta de área ${sprint.area}` : ""}`} en Azure DevOps. No incluye reporte de defectos, re-pruebas, automatización ni la elaboración del acta de certificación.`),

    titulo("Resumen por historia de usuario"),
    tabla(
      [
        ["HU", "Título", "Casos", "Pasos", "Tiempo"],
        ...est.historias.map((f) => [
          `#${f.hu.id}`,
          f.hu.titulo,
          f.casos.length ? String(f.casos.length) : { texto: "Sin casos", color: "B54708" },
          String(f.pasos),
          f.minutos ? horasYMin(f.minutos) : "—",
        ]),
        [{ texto: "Total", negrita: true }, "", { texto: String(r.casos), negrita: true }, { texto: String(r.pasos), negrita: true }, { texto: `${num(r.horas)} h`, negrita: true }],
      ],
      [10, 52, 12, 10, 16],
    ),
  ];

  const conCasos = est.historias.filter((f) => f.casos.length);
  if (conCasos.length) {
    hijos.push(titulo("Detalle por caso de prueba"));
    for (const f of conCasos) {
      hijos.push(
        new Paragraph({ children: [texto(`HU #${f.hu.id} · ${f.hu.titulo}`, { bold: true, color: AZUL })], spacing: { before: 200, after: 80 } }),
        tabla(
          [
            ["Caso", "Título", "Prioridad", "Pasos", "Minutos"],
            ...f.casos.map((c) => [
              `#${c.azure_id}`,
              c.titulo,
              c.prioridad,
              c.sinPasos ? { texto: `${p.pasosSupuestosSinPasos} supuestos`, color: "B54708" } : String(c.pasos),
              num(c.minutos),
            ]),
            ["", { texto: `Preparación de la HU (datos y ambiente)`, color: "667085" }, "", "", num(p.minutosPreparacionHU)],
          ],
          [10, 56, 12, 10, 12],
        ),
      );
    }
  }

  hijos.push(
    ...(r.casosSinPasos
      ? [parrafo([texto(`${r.casosSinPasos} caso(s) no tienen pasos en Azure DevOps: se estimaron con ${p.pasosSupuestosSinPasos} pasos supuestos cada uno. Complete sus pasos para un estimado más preciso.`, { color: "B54708" })], { spacing: { before: 120 } })]
      : []),
    ...(r.historiasExcluidas ? [parrafo([texto(`${r.historiasExcluidas} historia(s) no tienen casos de prueba vinculados y no se tomaron en cuenta en el estimado.`, { color: "B54708" })])] : []),
    parrafo([texto(`Generado el ${new Date(est.generado).toLocaleString("es-DO", { dateStyle: "long", timeStyle: "short" })}${analista ? ` por ${analista}` : ""} con el Ecosistema de Aseguramiento de Calidad TI.`, { size: 18, color: "667085" })], { spacing: { before: 240 } }),
  );

  const doc = new Document({
    creator: "Ecosistema de Aseguramiento de Calidad TI",
    title: `Estimado de ejecución - ${sprint?.nombre ?? "Sprint"}`,
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
