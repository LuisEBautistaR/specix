/**
 * Templates a new workspace starts with (copied into plantillas/ so they can be
 * edited). «__TITULO__» and «__VERSION__» are replaced when an API is created (the files stay valid YAML).
 */
export interface BuiltinTemplate {
  name: string;
  file: string;
  description: string;
  content: string;
}

export const BUILTIN_TEMPLATES: BuiltinTemplate[] = [
  {
    name: "rest-basica",
    file: "openapi.yaml",
    description: "API REST en OpenAPI 3.1 con una colección, su elemento y un error común",
    content: `openapi: 3.1.0
info:
  title: __TITULO__
  version: __VERSION__
  description: Describe aquí qué ofrece la API.
  contact:
    name: Equipo de la API
    email: api@ejemplo.test
servers:
  - url: https://api.ejemplo.test/v1
tags:
  - name: elementos
paths:
  /elementos:
    get:
      operationId: listarElementos
      tags: [elementos]
      summary: Lista los elementos
      parameters:
        - name: limit
          in: query
          schema: { type: integer, minimum: 1, maximum: 100, default: 20 }
      responses:
        '200':
          description: Página de elementos
          content:
            application/json:
              schema:
                type: array
                items: { $ref: '#/components/schemas/Elemento' }
    post:
      operationId: crearElemento
      tags: [elementos]
      summary: Crea un elemento
      requestBody:
        required: true
        content:
          application/json:
            schema: { $ref: '#/components/schemas/Elemento' }
      responses:
        '201':
          description: Elemento creado
        '400':
          $ref: '#/components/responses/Error'
  /elementos/{id}:
    get:
      operationId: obtenerElemento
      tags: [elementos]
      summary: Obtiene un elemento
      parameters:
        - name: id
          in: path
          required: true
          schema: { type: string }
      responses:
        '200':
          description: El elemento
          content:
            application/json:
              schema: { $ref: '#/components/schemas/Elemento' }
        '404':
          $ref: '#/components/responses/Error'
components:
  schemas:
    Elemento:
      type: object
      required: [id, nombre]
      properties:
        id: { type: string }
        nombre: { type: string }
    Error:
      type: object
      required: [codigo, mensaje]
      properties:
        codigo: { type: string }
        mensaje: { type: string }
  responses:
    Error:
      description: Algo no salió bien
      content:
        application/json:
          schema: { $ref: '#/components/schemas/Error' }
`,
  },
  {
    name: "eventos",
    file: "asyncapi.yaml",
    description: "Eventos en AsyncAPI 3.0 con un canal que la aplicación envía",
    content: `asyncapi: 3.0.0
info:
  title: __TITULO__
  version: __VERSION__
  description: Describe aquí qué eventos publica la aplicación.
  contact:
    name: Equipo de la API
    email: api@ejemplo.test
channels:
  elementoCreado:
    address: elementos.creado
    messages:
      elementoCreado:
        $ref: '#/components/messages/ElementoCreado'
operations:
  publicarElementoCreado:
    action: send
    summary: Avisa de que se creó un elemento
    channel:
      $ref: '#/channels/elementoCreado'
components:
  messages:
    ElementoCreado:
      payload:
        type: object
        required: [id]
        properties:
          id: { type: string }
`,
  },
];

/** Puts the API's title and version into a template; the title is quoted so any text stays valid YAML. */
export function fillTemplate(content: string, values: { title: string; version: string }): string {
  const title = `'${values.title.replace(/'/g, "''")}'`;
  return content.replace(/__TITULO__/g, () => title).replace(/__VERSION__/g, () => values.version);
}
