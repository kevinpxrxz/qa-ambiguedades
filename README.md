# Ambigüedades de HUs

Aplicativo local que consulta **una HU** o **un sprint** en Azure DevOps y devuelve **solo las ambigüedades y preguntas** de cada HU para el Product Owner/negocio. No diseña casos de prueba ni ejecuta pruebas.

Reutiliza el cliente de Azure DevOps y los proveedores de IA del **Ecosistema de Aseguramiento de Calidad TI**.

## Requisitos

- Node.js 22.15 o superior.
- Un PAT de Azure DevOps con lectura de Work Items.
- Una API key de Gemini o Anthropic (o un proveedor compatible con OpenAI).

## Configuración

1. Copia `.env.example` a `.env`.
2. Completa:
   - `AZDO_ORG_URL`, `AZDO_PROJECT`, `AZDO_PAT`.
   - `PROVEEDOR_IA` y la clave correspondiente (`GEMINI_API_KEY` o `ANTHROPIC_API_KEY`).
3. Instala dependencias:

```bash
npm install
```

4. Inicia:

```bash
npm start
```

Abre http://127.0.0.1:3300

## Uso

- **Por HU**: escribe el ID y pulsa *Analizar*.
- **Por sprint**: elige proyecto, sprint y área; pulsa *Listar HUs*, marca las que quieras y pulsa *Analizar N HU(s)*.

Los resultados se muestran por HU, agrupados por criterio de aceptación, con:

- resumen del requerimiento,
- preguntas para el negocio,
- supuestos detectados,
- copiar al portapapeles,
- descargar Word por HU o del lote completo,
- exportar JSON/CSV.

## Endpoints

| Método | Ruta | Uso |
|---|---|---|
| GET | `/api/config` | Estado de Azure e IA |
| GET | `/api/proyectos` | Proyectos de la organización |
| GET | `/api/proyectos/:proyecto/sprints` | Sprints del proyecto |
| GET | `/api/proyectos/:proyecto/areas` | Áreas del proyecto |
| GET | `/api/azure/sprint/hus?proyecto=&ruta=&area=` | HUs del sprint |
| POST | `/api/analizar-hu` | `{ id }` → ambigüedades de una HU |
| POST | `/api/docx` | Word de una HU |
| POST | `/api/docx-lote` | Word consolidado del lote |

## Notas

- El análisis usa IA: cada HU tarda unos segundos y consume tokens.
- Si una HU no tiene descripción ni criterios, se informa y no se analiza.
- El historial no se guarda en el servidor: los resultados viven en la página hasta que la cierres.
