# Ambigüedades de HUs

Aplicativo local que consulta **una HU** o **un sprint** en Azure DevOps y devuelve **solo las ambigüedades y preguntas** de cada HU para el Product Owner/negocio. No diseña casos de prueba ni ejecuta pruebas.

Reutiliza el cliente de Azure DevOps y los proveedores de IA del **Ecosistema de Aseguramiento de Calidad TI**.

## Requisitos

- Node.js 22.15 o superior.
- Un PAT de Azure DevOps con lectura de Work Items.
- Una API key de Gemini, Anthropic o de un servicio compatible con OpenAI. La app detecta el proveedor automáticamente según la clave.

## Configuración

1. Copia `.env.example` a `.env`.
2. Completa:
   - `AZDO_ORG_URL`, `AZDO_PROJECT`, `AZDO_PAT`.
   - La clave de IA: `GEMINI_API_KEY` o `ANTHROPIC_API_KEY`. `PROVEEDOR_IA` es opcional; si se omite, se deduce de la clave configurada.
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

## Publicar en la nube (Render)

El repositorio incluye `render.yaml`. En Render:

1. **New → Blueprint** y conecta el repositorio de GitHub.
2. Render crea el servicio con `npm install` y `npm start`.
3. Las variables `HOST=0.0.0.0`, `AZDO_ORG_URL` y `AZDO_PROJECT` ya vienen en `render.yaml`.
4. Abre la URL del servicio; cada persona configura su **PAT** y pega su **API key** en ⚙ Configuración (el proveedor de IA se detecta solo).

No se guardan secretos en el repositorio ni en el servidor: el PAT y la API key se envían en cada consulta y viven en el navegador de cada usuario.

### Docker

```bash
docker build -t qa-ambiguedades .
docker run -p 3300:3300 -e HOST=0.0.0.0 qa-ambiguedades
```

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
