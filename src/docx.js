// Extrae el texto de un .docx conservando títulos, listas y tablas (en formato legible).
import mammoth from "mammoth";

const ENTIDADES = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'", "&nbsp;": " " };

/** Convierte HTML (de Word o de Azure DevOps) a texto legible conservando títulos, listas y tablas. */
export function htmlATexto(html) {
  return String(html ?? "")
    .replace(/<img[^>]*>/gi, "")
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, "")
    // El contenido de cada celda viene en <p>: se aplana a una línea para que la fila quede en una sola línea.
    .replace(/<t([dh])[^>]*>([\s\S]*?)<\/t\1>/gi, (_m, _t, celda) =>
      ` ${celda.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()}</td>`,
    )
    .replace(/<h([1-6])[^>]*>/gi, (_m, n) => `\n\n${"#".repeat(Number(n))} `)
    .replace(/<\/h[1-6]>/gi, "\n")
    .replace(/<tr[^>]*>/gi, "\n|")
    .replace(/<\/t[dh]>/gi, " |")
    .replace(/<li[^>]*>/gi, "\n- ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|table|ul|ol)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&#(\d+);/g, (_m, n) => String.fromCodePoint(Number(n)))
    .replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (e) => ENTIDADES[e])
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export async function extraerTextoDocx(buffer) {
  const { value } = await mammoth.convertToHtml({ buffer });
  return htmlATexto(value);
}
