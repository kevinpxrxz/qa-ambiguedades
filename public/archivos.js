// Extrae texto de archivos Word (.docx), Excel (.xlsx/.xls) y PDF en el navegador.
// Versión clásica (sin módulos) para la app con servidor: expone window.extraerTexto.
(function () {
  const LIBS = {
    mammoth: "https://cdn.jsdelivr.net/npm/mammoth@1.9.1/mammoth.browser.min.js",
    xlsx: "https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js",
    pdf: "https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.min.js",
    pdfWorker: "https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js",
  };

  const cargadas = new Map();

  function cargarScript(src) {
    if (cargadas.has(src)) return cargadas.get(src);
    const promesa = new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = src;
      s.async = true;
      s.onload = () => resolve();
      s.onerror = () => reject(new Error(`No se pudo cargar la librería ${src}. Revise la conexión a internet.`));
      document.head.appendChild(s);
    });
    cargadas.set(src, promesa);
    return promesa;
  }

  function htmlATexto(html) {
    return String(html ?? "")
      .replace(/<img[^>]*>/gi, "")
      .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, "")
      .replace(/<\/(p|div|li|tr|h[1-6])>/gi, "\n")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<li[^>]*>/gi, "• ")
      .replace(/<[^>]+>/g, "")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  const extension = (nombre) => String(nombre).split(".").pop().toLowerCase();

  async function docx(file) {
    await cargarScript(LIBS.mammoth);
    if (!window.mammoth) throw new Error("No se pudo cargar el lector de Word.");
    const arrayBuffer = await file.arrayBuffer();
    const resultado = await window.mammoth.convertToHtml({ arrayBuffer });
    return { tipo: "Word", texto: htmlATexto(resultado.value) };
  }

  async function excel(file) {
    await cargarScript(LIBS.xlsx);
    if (!window.XLSX) throw new Error("No se pudo cargar el lector de Excel.");
    const data = new Uint8Array(await file.arrayBuffer());
    const libro = window.XLSX.read(data, { type: "array" });
    const partes = libro.SheetNames.map((nombre) => {
      const csv = window.XLSX.utils.sheet_to_csv(libro.Sheets[nombre]);
      return `Hoja "${nombre}":\n${csv}`;
    });
    return { tipo: "Excel", texto: partes.join("\n\n") };
  }

  async function pdf(file) {
    await cargarScript(LIBS.pdf);
    if (!window.pdfjsLib) throw new Error("No se pudo cargar el lector de PDF.");
    window.pdfjsLib.GlobalWorkerOptions.workerSrc = LIBS.pdfWorker;
    const data = new Uint8Array(await file.arrayBuffer());
    const documento = await window.pdfjsLib.getDocument({ data }).promise;
    const partes = [];
    for (let i = 1; i <= documento.numPages; i++) {
      const pagina = await documento.getPage(i);
      const contenido = await pagina.getTextContent();
      partes.push(contenido.items.map((it) => it.str).join(" "));
    }
    return { tipo: "PDF", texto: partes.join("\n\n") };
  }

  async function extraerTexto(file) {
    const ext = extension(file.name);
    if (ext === "docx") return await docx(file);
    if (ext === "xlsx" || ext === "xls") return await excel(file);
    if (ext === "pdf") return await pdf(file);
    throw new Error("Formato no soportado. Use .docx, .xlsx, .xls o .pdf.");
  }

  window.extraerTexto = extraerTexto;
})();
