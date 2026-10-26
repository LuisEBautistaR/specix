/**
 * Built-in style guides, written for Specix. "specix:base" covers what every
 * API should have; a workspace guide extends it and adds its own rules.
 */
export const BASE_GUIDE = `description: Guía base de Specix
rules:
  info-description:
    description: La API explica qué ofrece.
    message: Falta info.description, que explique qué ofrece la API
    severity: warn
    given: $.info
    then: { field: description, function: truthy }
  info-contact:
    description: La API dice a quién preguntar.
    message: Falta info.contact (a quién preguntar por la API)
    severity: info
    given: $.info
    then: { field: contact, function: truthy }
  operation-operationId:
    description: Cada operación tiene operationId; los clientes generados lo usan como nombre.
    message: La operación no tiene operationId
    severity: warn
    formats: [oas2, oas3]
    given: $.paths[*][get,put,post,delete,options,head,patch,trace]
    then: { field: operationId, function: truthy }
  operation-summary:
    description: Cada operación tiene un resumen de una línea.
    message: La operación no tiene summary
    severity: warn
    formats: [oas2, oas3]
    given: $.paths[*][get,put,post,delete,options,head,patch,trace]
    then: { field: summary, function: truthy }
  operation-tags:
    description: Cada operación tiene al menos una etiqueta, para agruparla en la documentación.
    message: La operación no tiene etiquetas
    severity: warn
    formats: [oas2, oas3]
    given: $.paths[*][get,put,post,delete,options,head,patch,trace]
    then: { field: tags, function: truthy }
  operation-success-response:
    description: Cada operación declara al menos una respuesta de éxito.
    severity: warn
    formats: [oas2, oas3]
    given: $.paths[*][get,put,post,delete,options,head,patch,trace].responses
    then: { function: successResponse }
  path-trailing-slash:
    description: Las rutas no terminan en «/».
    message: La ruta «{{property}}» termina en «/»
    severity: warn
    formats: [oas2, oas3]
    given: $.paths
    then: { field: '@key', function: pattern, functionOptions: { notMatch: '.+/$' } }
  path-query-string:
    description: Los parámetros de consulta van en parameters, no en la ruta.
    message: La ruta «{{property}}» lleva una consulta («?»); declárala en parameters
    severity: error
    formats: [oas2, oas3]
    given: $.paths
    then: { field: '@key', function: pattern, functionOptions: { notMatch: '\\?' } }
  servers-defined:
    description: La API dice dónde está.
    message: No hay servidores definidos
    severity: warn
    formats: [oas3]
    given: $
    then: { field: servers, function: truthy }
  components-unused:
    description: Los esquemas reutilizables se usan en algún sitio.
    severity: warn
    formats: [oas3]
    given: $.components.schemas
    then: { function: unusedComponent }
  definitions-unused:
    description: Los esquemas reutilizables se usan en algún sitio.
    severity: warn
    formats: [oas2]
    given: $.definitions
    then: { function: unusedComponent }
  asyncapi-operation-summary:
    description: Cada operación de AsyncAPI tiene un resumen.
    message: La operación no tiene summary
    severity: info
    formats: [asyncapi3]
    given: $.operations[*]
    then: { field: summary, function: truthy }
`;

/** The guide a new workspace starts with: the base plus one house rule as an example. */
export const STARTER_GUIDE = `# Guía de estilo del espacio de trabajo, en formato compatible con Spectral.
# Specix la aplica a todas las APIs; cambia severidades, añade reglas o apaga las de la base.
extends: [specix:base]
rules:
  operation-id-camelcase:
    description: El operationId va en camelCase para que los clientes generados tengan nombres limpios.
    message: 'operationId debe ir en camelCase: «{{value}}»'
    severity: warn
    formats: [oas2, oas3]
    given: $.paths[*][get,put,post,delete,options,head,patch,trace].operationId
    then: { function: casing, functionOptions: { type: camel, disallowDigits: true } }
  # Ejemplo de cómo cambiar la severidad de una regla de la base:
  info-contact: warn
`;

export const BUILTIN_GUIDES: Record<string, string> = { "specix:base": BASE_GUIDE };
