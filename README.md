# Specix

<img src="docs/logo.svg" width="96" alt="Logo de Specix">

Estudio de diseño de APIs local primero: edita, valida, gobierna, versiona y documenta definiciones OpenAPI y AsyncAPI, con app de escritorio y CLI. Forma un ciclo con sus hermanas: **Specix diseña, Mockix simula, Sendix prueba**. Sistema visual en [docs/DESIGN.md](docs/DESIGN.md).

Estado: **0.1.1**, con instalador para Windows (hitos S0–S5, la vista Contrato y la salida de S10: logo, instalador y página en [protohub.digital/specix](https://protohub.digital/specix/)). El núcleo lee definiciones YAML o JSON, reconoce su especificación (Swagger 2.0, OpenAPI 3.0–3.2, AsyncAPI 2.0–3.1), las valida contra el **esquema oficial** de esa especificación y comprueba que las referencias internas (`$ref: '#/…'`) existan. Cada problema sale en español, con línea y columna exactas de la clave o el valor. La CLI `specix lint` hace lo mismo desde la terminal o en CI. La app de escritorio trae un editor (CodeMirror) que valida mientras escribes, sugiere claves, valores y referencias según el esquema oficial, explica cada clave en español y salta a la definición de un `$ref`. Trabaja sobre una carpeta (un repo git, normalmente) con APIs y dominios versionados, plantillas, definiciones de varios archivos y versiones publicadas que quedan congeladas. Junto al editor muestra la documentación en vivo, y exporta un sitio HTML estático con la marca de la empresa. Cada API se revisa además con una **guía de estilo** en formato compatible con Spectral (la del espacio de trabajo o la base incluida), en la app y en CI con salida SARIF o JUnit. Lo demás llega por hitos (S6–S9: comparar versiones, comentarios, ciclo con Mockix y Sendix, generadores). Specix no incluye IA.

## Requisitos

- Node.js 22.12 o superior (probado con 24.22) y npm 11.
- Windows 10/11 x64 para empaquetar la app de escritorio.

```bash
npm install
```

npm 11 bloquea los scripts de instalación que no están aprobados. `package.json` → `allowScripts` aprueba el de `electron`, que descarga el binario, y deniega el de `electron-winstaller`, que no se usa porque el instalador es NSIS. Si `node_modules/electron/dist` queda vacío, ejecuta `node node_modules/electron/install.js`.

## Monorepo

```
packages/
├─ core/      @specix/core: lectura, posiciones y validación de definiciones. Node puro, sin Electron
│             src/schemas/: esquemas oficiales de OpenAPI y AsyncAPI (Apache-2.0, sin modificar)
└─ cli/       @specix/cli: binario `specix`
apps/
└─ desktop/   @specix/desktop: Electron (main, servicio de lenguaje, preload, renderer)
docs/         DESIGN.md (lo propio de Specix) y DESIGN-base.md (sistema compartido con Sendix y Mockix)
```

El mismo `core` trabaja en los dos sitios: la CLI lo importa compilado (`dist/`) y el escritorio lo empaqueta desde el código fuente, así que el instalador no necesita `node_modules`.

## Scripts (desde la raíz)

| Script | Qué hace |
|---|---|
| `npm run typecheck` | TypeScript estricto: core y CLI (`tsc -b`), y los tres proyectos del escritorio (node, web y e2e) |
| `npm test` | Tests unitarios de los tres paquetes (Vitest), desde el código fuente |
| `npm run build` | Compila core y CLI a `dist/` y el escritorio a `apps/desktop/out/` |
| `npm run test:e2e` | Binario real de la CLI y app de Electron real con Playwright (necesita `build`) |
| `npm run check` | Todo lo anterior, en orden |
| `npm run dev -w @specix/desktop` | App de escritorio con recarga en caliente |
| `npm run dist` | Instalador NSIS en `apps/desktop/release/<versión>/`, con icono y versión en el `.exe` |

## CLI

```bash
node packages/cli/dist/bin.js lint api/tienda.yaml api/pagos.json
```

```
api/tienda.yaml:2:1  error  Falta la propiedad obligatoria «version»  [schema/required]
api/tienda.yaml:13:15  error  Valor no permitido; usa uno de: «query», «header», «path», «cookie»  [schema/enum]
api/tienda.yaml:17:28  error  La referencia «#/components/schemas/Pedid» no existe. ¿Querías «Pedido»?  [ref/missing]
api/pagos.json:9:7  aviso  La operación no tiene summary  [guia/operation-summary]
3 errores y 1 aviso en 2 archivos.
```

```
Uso: specix <comando> [opciones]

Comandos:
  init [carpeta]                   Crea un espacio de trabajo (carpeta vacía o nueva)
  lint <archivo|carpeta...>        Valida definiciones contra el esquema oficial,
                                   comprueba referencias y aplica la guía de estilo;
                                   con una carpeta de trabajo, revisa todas las
                                   versiones y las publicadas que cambiaron
  bundle <archivo>                 Une una definición de varios archivos en uno solo
  publish <api> <versión>          Publica una versión: queda congelada con su huella
  docs <carpeta|archivo> -o <dir>  Genera la documentación como sitio HTML estático
  info <archivo>                   Dice qué especificación y versión sigue una definición

Opciones:
      --json                       info y lint: escribe el resultado como JSON
      --formato <formato>          lint: text, json, sarif o junit (text por defecto)
      --guia <archivo>             lint: guía de estilo a aplicar en vez de la del espacio
      --sin-guia                   lint: solo esquema y referencias, sin guía de estilo
      --nombre <texto>             init: nombre del espacio de trabajo
  -o, --salida <archivo>           bundle: escribe en un archivo en vez de la salida estándar
      --formato yaml|json          bundle: formato de salida (yaml por defecto)
      --carpeta <carpeta>          publish: espacio de trabajo (por defecto, la carpeta actual)
      --dominio                    publish: la versión es de un dominio, no de una API
      --marca <texto>              docs: nombre en la cabecera (por defecto, el del espacio de trabajo)
      --color <#rrggbb>            docs: color de la cabecera y los enlaces
      --logo <archivo>             docs: logo PNG o SVG, incrustado en las páginas
      --solo-publicadas            docs: deja fuera los borradores

Generales:
  -h, --help                       Muestra esta ayuda
  -v, --version                    Muestra la versión
```

En CI basta con `specix lint .` en la raíz del espacio de trabajo: revisa todas las versiones, aplica la guía de estilo y falla si hay errores o si una publicada cambió. Con `--formato sarif` el resultado se sube a la pestaña de seguridad de GitHub (code scanning); con `--formato junit`, a cualquier visor de pruebas.

- Los problemas salen como `archivo:línea:columna  severidad  mensaje  [código]`, el formato que los editores y CI convierten en enlaces.
- Códigos de salida: `0` sin errores (puede haber notas), `1` hay errores, algún archivo no se puede leer o los argumentos no son válidos. `lint` revisa todos los archivos aunque uno falle.
- No lee archivos de más de 20 MB. El YAML con más de 100 alias se rechaza (evita la «bomba de alias»).

## Espacio de trabajo

Una carpeta normal, pensada para git: todo es YAML legible y nada propio de Specix va dentro de las definiciones.

```
tienda-demo/
├─ specix.workspace.yaml        nombre del espacio de trabajo
├─ apis/
│  └─ tienda/
│     ├─ api.yaml               versiones, su estado (draft/published), su huella y la versión por defecto
│     ├─ 1.0.0/openapi.yaml     publicada: solo lectura
│     └─ 1.1.0/                 borrador; puede tener varios archivos
│        ├─ openapi.yaml        entrada
│        └─ esquemas.yaml       referido con $ref: 'esquemas.yaml#/components/schemas/…'
├─ dominios/comunes/1.0.0/components.yaml   componentes reutilizables entre APIs
├─ plantillas/rest-basica/openapi.yaml      de aquí salen las APIs nuevas (también eventos/asyncapi.yaml)
├─ guias/empresa.yaml          guía de estilo (en specix.workspace.yaml: guide: guias/empresa.yaml)
└─ .specix/                     datos locales, fuera de git
```

- **Publicar** congela una versión: Specix guarda la huella (sha256) de sus archivos, la abre en solo lectura y `lint` avisa si alguien la cambia después. Para cambiarla se crea una versión nueva, que copia la anterior y actualiza `info.version`.
- **Referencias entre archivos** relativas (`paths/pedidos.yaml`, `../../../dominios/comunes/1.0.0/components.yaml#/components/schemas/Dinero`): se comprueban al validar y nunca salen de la carpeta del espacio de trabajo. Las remotas (`https://…`) no se descargan.
- **Empaquetar** (`specix bundle`) une una definición de varios archivos en uno: los componentes de otros archivos se copian a `components` (renombrando si chocan) y el resto se incrusta. Funciona con esquemas recursivos.

## Documentación

- **Vista previa** junto al editor, siempre al día: operaciones por etiqueta, parámetros, cuerpos con su esquema desplegado, respuestas con cabeceras y ejemplos, webhooks, canales y mensajes de AsyncAPI y esquemas. La operación donde está el cursor se abre sola. Con varios archivos, la vista previa los une (usando el texto sin guardar del editor).
- **Vista Contrato** (botón *Contrato* junto a *Código*): el contrato completo a lo ancho, con índice, para leerlo como lo leería quien consume la API. Cada operación muestra sus parámetros, el cuerpo y cada respuesta con dos vistas: **Ejemplo**, un JSON con datos (el del documento o, si no trae, uno generado del esquema con sus formatos, valores por defecto, enums y límites, sin campos `readOnly` en peticiones ni `writeOnly` en respuestas), y **Esquema**, el modelo como árbol con sus tipos, obligatorios y restricciones, donde cada `$ref` se abre en su sitio. Los esquemas de `components` tienen su propia sección.
- **Sitio estático**: `specix docs <carpeta> -o sitio` (o «Exportar sitio…» en la app) escribe `index.html` con todas las APIs, una página por versión y la versión por defecto en `sitio/<api>/`. Opciones: `--marca`, `--color #rrggbb`, `--logo logo.svg|png` (incrustado) y `--solo-publicadas`.
- Las páginas no llevan scripts ni piden nada a la red (CSP `default-src 'none'`): se abren desde el disco, una carpeta compartida o cualquier hosting estático. Siguen el tema claro u oscuro del lector y se leen en el móvil.
- Las descripciones admiten el Markdown habitual (párrafos, listas, negritas, código y enlaces http/https/mailto); todo lo demás se escapa.

## Gobernanza

Una guía de estilo es un archivo YAML con el formato de reglas de Spectral; Specix trae su propio motor (no usa Spectral) y admite este subconjunto:

```yaml
extends: [specix:base]          # o spectral:oas, que Specix sustituye por su base; o ./otra-guia.yaml
rules:
  operation-id-camelcase:
    description: El operationId va en camelCase.
    message: 'operationId debe ir en camelCase: «{{value}}»'
    severity: warn              # error, warn, info, hint u off
    formats: [oas3]             # oas2, oas3, oas3_0, oas3_1, oas3_2, asyncapi2, asyncapi3
    given: $.paths[*][get,post,put,patch,delete].operationId
    then: { function: casing, functionOptions: { type: camel, disallowDigits: true } }
  info-contact: warn            # cambia la severidad de una regla heredada (o off para apagarla)
```

- **Funciones**: `truthy`, `falsy`, `defined`, `undefined`, `pattern` (`match`/`notMatch`), `casing` (flat, camel, pascal, kebab, cobol, snake, macro; con `separator` y `disallowDigits`), `enumeration`, `length`, `alphabetical`, `xor`, `schema` (JSON Schema), `unusedComponent` y `successResponse`. Una regla con otra función no se ejecuta y se avisa.
- **`then.field`**: una propiedad (`description`, `a.b`), `@key` (cada clave del objeto, p. ej. cada ruta) o una consulta JSONPath (`$..type`). Los mensajes admiten `{{value}}`, `{{property}}`, `{{path}}`, `{{error}}` y `{{description}}`.
- **`specix:base`** (incluida): descripción y contacto en `info`, `operationId`, `summary`, etiquetas y una respuesta de éxito en cada operación, rutas sin `/` final ni `?`, servidores definidos y esquemas sin usar; para AsyncAPI 3, `summary` en cada operación.
- Un espacio de trabajo nuevo trae `guias/empresa.yaml`, que extiende la base y añade una regla de ejemplo. La guía se aplica a la entrada de cada versión de las **APIs** (no a los dominios ni a los fragmentos).
- **En la app**: los fallos de la guía salen en el panel de problemas como «guía» (con filtro Esquema / Guía) y la vista **Gobernanza** lista las reglas con su severidad, a qué aplican y cuántas fallan en el documento; un clic lleva al primer fallo. La guía se edita como cualquier archivo del espacio de trabajo: mientras se escribe se revisa su formato y al guardarla las APIs la aplican al momento.
- **En la CLI**: `lint` aplica la guía del espacio de trabajo (o la base a un archivo suelto); `--guia otra.yaml` usa otra y `--sin-guia` solo revisa esquema y referencias.

## Validación

| Paso | Qué comprueba | Código del diagnóstico |
|---|---|---|
| Sintaxis | YAML o JSON bien formado; claves repetidas, tabuladores, alias excesivos | `yaml/…`, `json/syntax` |
| Especificación | `openapi`, `swagger` o `asyncapi` con una versión conocida | `spec/…` |
| Esquema oficial | El documento cumple el esquema JSON publicado de su versión (ver tabla) | `schema/<palabra clave>` |
| Referencias | Cada `$ref` interno (`#/…`) apunta a algo que existe; si no, propone el nombre más parecido | `ref/missing`, `ref/invalid` |
| Guía de estilo | Las reglas de la guía activa (ver Gobernanza) | `guia/<regla>` |

| Especificación | Esquema aplicado |
|---|---|
| Swagger 2.0 | spec.openapis.org, 2017-08-27 |
| OpenAPI 3.0.x | spec.openapis.org, 2024-10-18 |
| OpenAPI 3.1.x | spec.openapis.org, 2026-08-03 |
| OpenAPI 3.2.x | spec.openapis.org, 2026-08-30 |
| AsyncAPI 2.0.0 a 3.1.0 | asyncapi/spec-json-schemas, uno por versión; una versión sin esquema propio usa el último de su rama y lo avisa |

- Los errores de un esquema llegan de ajv y se traducen: cada mensaje dice qué falta o sobra, y apunta a la clave o al valor exactos. Las alternativas (`oneOf`/`anyOf`) se resumen: «Falta una de estas propiedades: «schema» o «content»», o una sola lista de valores permitidos en lugar de un error por rama.
- Probado sin falsos positivos contra definiciones públicas conocidas (petstore 2.0 y 3.0, uspto, callbacks, links, webhooks 3.1, streetlights de AsyncAPI 3).
- Las referencias a otros archivos (`otro.yaml#/…`) se comprueban cuando el documento está en un espacio de trabajo (o junto a sus archivos, en la CLI). Los archivos que no son la entrada de su versión (un path item, un grupo de esquemas) se revisan solo por sintaxis y referencias. Los `$ref` dentro de `example` o de extensiones `x-` se tratan como datos.

## Editor

| Función | Cómo |
|---|---|
| Diagnósticos | Subrayado ondulado en el texto exacto y punto en el margen; el panel de problemas lleva al sitio con un clic |
| Sugerencias (Ctrl+Espacio o al escribir) | Claves que admite el objeto en esa posición (las obligatorias primero y sin repetir las ya escritas), valores permitidos (`in: query`, `action: send`…) y destinos de `$ref` (entre comillas, porque en YAML `#` abre un comentario) |
| Ayuda al pasar el ratón | Explicación en español de la clave y su tipo; sobre un `$ref`, qué hay en el destino |
| Ir a la definición | F12 o Ctrl+clic sobre un `$ref` interno |
| Migas y estructura | Ruta del nodo bajo el cursor; en la barra lateral, operaciones por etiqueta, webhooks, canales y componentes |

- Todo lo calcula el servicio de lenguaje (`packages/core/src/language.ts`) a partir del esquema oficial de la versión del documento, recorrido por `SchemaNavigator` (sigue `$ref`, `allOf`/`anyOf`/`oneOf`, `if/then/else`, propiedades por patrón e `items`).
- Las sugerencias funcionan aunque el documento no se pueda leer en ese momento (el usuario está escribiendo): la posición en YAML se deduce de la sangría.
- CodeMirror vive en un *shadow root*, el único sitio donde sus estilos no chocan con la CSP estricta.

## Escritorio: arquitectura

```
src/
├─ main/      ventana, protocolo app://, seguridad, LangService, HostProcess, router IPC
├─ host/      servicio de lenguaje (utilityProcess): servidor RPC y handlers sobre @specix/core
├─ preload/   puente mínimo window.specix (sandbox + contextIsolation)
├─ renderer/  React 19, tokens del diseño aprobado, fuentes autoalojadas
└─ shared/    contratos: sobres RPC (rpc.ts), métodos del host (host-methods.ts), canales IPC (ipc.ts)
```

- **Servicio de lenguaje aparte.** Leer y validar documentos ocurre en un `utilityProcess`, al que el main llama por un MessagePort con RPC tipado (zod en los dos extremos). Un documento enorme o malicioso puede ralentizar o tumbar ese proceso, pero no la ventana.
- **Recuperación.** Si el servicio muere, el main lo reinicia con espera creciente (250 ms → 5 s) y la interfaz vuelve a pedir la lectura. Si cae más de 5 veces en 60 s, queda "Con errores".
- **Solo el proceso principal toca el disco.** `WorkspaceService` abre la carpeta, lee y guarda (escritura atómica) y crea, versiona y publica con el núcleo; el renderer solo manda rutas relativas, que el main comprueba que no salgan del espacio de trabajo. Las versiones publicadas se niegan a guardarse también en el main, no solo en la interfaz. La app vuelve a abrir el último espacio de trabajo.
- **El renderer nunca habla con el host.** Solo tiene canales con nombre: estado, revisar documento, sugerir, ayuda, definición, ruta y medir. Los de editor reciben `{ text, line, column }` y el main los valida antes de pasarlos. Al pulsar un problema, el editor selecciona la clave o el valor exactos. El main comprueba el remitente y valida los argumentos (texto de 5 MB como máximo).
- Los errores siempre llegan como `{ ok: false, error: { code, message } }`, nunca como excepciones. Ejemplos de código: `INVALID_PARAMS`, `HOST_EXITED`, `TIMEOUT`.

## Seguridad (verificada)

| Medida | Cómo se comprueba |
|---|---|
| `contextIsolation`, `sandbox`, sin `nodeIntegration`, sin `webviewTag` | E2E lee las preferencias aplicadas |
| UI servida desde `app://specix` con CSP estricta (`default-src 'none'`, sin `unsafe-eval`) | E2E: `eval` bloqueado, origen correcto, `fetch` a la red bloqueado |
| Sin ventanas emergentes ni navegación fuera de la app; todos los permisos web denegados | E2E: `window.open` y cambio de `location` |
| IPC solo desde el marco principal de la app; argumentos validados; ganchos de prueba solo con `SPECIX_TEST=1` en builds sin empaquetar | E2E + unitarios |
| La app empaquetada se niega a arrancar con `--remote-debugging-port`, `--inspect` y similares | revisión del arranque en `main/index.ts` |
| Rutas de `app://` sin escapar de la carpeta del renderer | unitarios (incluye `..%5c`) |
| YAML con más de 100 alias rechazado; documentos de más de 5 MB rechazados antes de llegar al servicio | unitarios y E2E |
| Fuses empaquetados: RunAsNode, NODE_OPTIONS e `--inspect` desactivados; integridad del asar y solo `app.asar` activados; cookies cifradas; sin privilegios extra de `file://` | Lectura de los fuses del `Specix.exe` empaquetado |

## Logo e instalador

- `python -I apps/desktop/build/logo.py` dibuja el logo (una hoja de definición con una marca de válida, en los tonos de la familia) y escribe `build/icon.png`, `build/icon.ico` y `docs/logo.svg`.
- `npm run dist` crea el instalador NSIS: por usuario, sin permisos de administrador, con acceso directo y sin borrar los ajustes al desinstalar. El icono y la versión se escriben en `Specix.exe` desde `build/after-pack.cjs` (el paso propio de electron-builder falla en algunos equipos porque el `.exe` recién creado queda bloqueado un momento); el hook reintenta.
- El instalador no lleva firma de código. Para actualizar, el instalador nuevo se ejecuta encima del anterior.

## Licencia

MIT, ver [LICENSE](LICENSE).

## Licencias de terceros

Los esquemas de `packages/core/src/schemas/` son de la OpenAPI Initiative y de la AsyncAPI Initiative, con licencia Apache-2.0, y se incluyen sin cambios ([detalle](packages/core/src/schemas/README.md)). Specix no usa código de otros editores de APIs: el cargador, el servicio de lenguaje, los mensajes y la interfaz son propios. Validación con [ajv](https://ajv.js.org) (MIT), lectura de YAML con [yaml](https://eemeli.org/yaml) (ISC) y consultas JSONPath de las guías con [jsonpath-plus](https://github.com/JSONPath-Plus/JSONPath) (MIT, en su modo de evaluación segura). El motor de guías es propio; solo comparte con Spectral el formato de las reglas.

## Cómo se desarrolla

Specix lo diseña y dirige Luis E. Bautista. El código, los tests y la documentación se escriben con la ayuda de Claude (Anthropic) como asistente de programación. Cada cambio se revisa y se prueba antes de integrarlo.
