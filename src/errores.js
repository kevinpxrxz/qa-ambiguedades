const MENSAJES = {
  rechazo:
    "El modelo no pudo procesar este contenido. Revise que el texto sea un requerimiento de software e intente de nuevo.",
  limite:
    "El requerimiento generó más casos de los que caben en una respuesta. Divida el documento en partes (por HU o módulo) y genere cada una por separado.",
  formato: "La respuesta del modelo no tuvo un formato válido. Intente generar nuevamente.",
  sin_clave:
    'No hay API key de IA configurada. Haga clic en el indicador de IA (arriba a la derecha) y pegue su API key, o agregue GEMINI_API_KEY / ANTHROPIC_API_KEY en el archivo .env.',
  sin_clave_gemini: "No se encontró la API key de Gemini. Configure GEMINI_API_KEY en el archivo .env y reinicie el servidor.",
};

/** Error con un mensaje listo para mostrar al usuario. */
export class ErrorGeneracion extends Error {
  constructor(codigo) {
    super(MENSAJES[codigo] ?? codigo);
    this.codigo = codigo;
  }
}
