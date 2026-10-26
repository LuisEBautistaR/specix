import { parseArgs } from "node:util";

export type Command =
  | { kind: "info"; file: string; json: boolean }
  | { kind: "lint"; paths: string[]; format: LintFormat; guide: string | null; noGuide: boolean }
  | { kind: "init"; dir: string; name: string | null }
  | { kind: "bundle"; file: string; out: string | null; format: "yaml" | "json" }
  | { kind: "publish"; api: string; version: string; dir: string; domain: boolean }
  | { kind: "docs"; path: string; out: string; brand: string | null; color: string | null; logo: string | null; publishedOnly: boolean }
  | { kind: "help" }
  | { kind: "version" };

export type LintFormat = "text" | "json" | "sarif" | "junit";

export type ParseResult = { ok: true; command: Command } | { ok: false; message: string };

export const HELP = `Uso: specix <comando> [opciones]

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
`;

/** node:util reports parse errors in English; the CLI speaks Spanish. */
function describeParseError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  const code = (err as { code?: unknown }).code;
  // Messages name options as "'-p, --port <value>'" or "'--watch'": prefer the long form.
  const option = /--[\w-]+/.exec(message)?.[0] ?? /-\w/.exec(message)?.[0] ?? "";
  if (code === "ERR_PARSE_ARGS_UNKNOWN_OPTION") return `Opción desconocida: ${option}`;
  if (code === "ERR_PARSE_ARGS_INVALID_OPTION_VALUE") return `Falta el valor de ${option}`;
  return message;
}

/** Parses argv (without node and script). Never throws. */
export function parseCli(argv: readonly string[]): ParseResult {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      allowPositionals: true,
      strict: true,
      options: {
        json: { type: "boolean" },
        nombre: { type: "string" },
        salida: { type: "string", short: "o" },
        formato: { type: "string" },
        guia: { type: "string" },
        "sin-guia": { type: "boolean" },
        carpeta: { type: "string" },
        dominio: { type: "boolean" },
        marca: { type: "string" },
        color: { type: "string" },
        logo: { type: "string" },
        "solo-publicadas": { type: "boolean" },
        help: { type: "boolean", short: "h" },
        version: { type: "boolean", short: "v" },
      },
    });
  } catch (err) {
    return { ok: false, message: describeParseError(err) };
  }
  const { values, positionals } = parsed;
  if (values.version) return { ok: true, command: { kind: "version" } };
  if (values.help || positionals.length === 0) return { ok: true, command: { kind: "help" } };

  const [name, ...rest] = positionals;
  const extra = (max: number) => (rest.length > max ? { ok: false as const, message: `Argumento inesperado: ${rest[max]}` } : null);
  switch (name) {
    case "lint": {
      if (rest.length === 0) return { ok: false, message: "lint necesita al menos un archivo o carpeta" };
      const format = values.formato ?? (values.json ? "json" : "text");
      if (format !== "text" && format !== "json" && format !== "sarif" && format !== "junit") return { ok: false, message: `Formato no válido: ${format} (usa text, json, sarif o junit)` };
      if (values.guia !== undefined && values["sin-guia"]) return { ok: false, message: "--guia y --sin-guia no van juntas" };
      return { ok: true, command: { kind: "lint", paths: rest, format, guide: values.guia ?? null, noGuide: values["sin-guia"] ?? false } };
    }
    case "info":
      if (rest[0] === undefined) return { ok: false, message: "info necesita la ruta de un archivo" };
      return extra(1) ?? { ok: true, command: { kind: "info", file: rest[0], json: values.json ?? false } };
    case "init":
      return extra(1) ?? { ok: true, command: { kind: "init", dir: rest[0] ?? ".", name: values.nombre ?? null } };
    case "bundle": {
      if (rest[0] === undefined) return { ok: false, message: "bundle necesita el archivo de entrada" };
      const format = values.formato ?? "yaml";
      if (format !== "yaml" && format !== "json") return { ok: false, message: `Formato no válido: ${format} (usa yaml o json)` };
      return extra(1) ?? { ok: true, command: { kind: "bundle", file: rest[0], out: values.salida ?? null, format } };
    }
    case "publish":
      if (rest.length < 2) return { ok: false, message: "publish necesita la API y la versión, por ejemplo: specix publish tienda 1.1.0" };
      return extra(2) ?? { ok: true, command: { kind: "publish", api: rest[0]!, version: rest[1]!, dir: values.carpeta ?? ".", domain: values.dominio ?? false } };
    case "docs": {
      if (rest[0] === undefined) return { ok: false, message: "docs necesita una carpeta de trabajo o un archivo" };
      if (!values.salida) return { ok: false, message: "docs necesita la carpeta de salida: -o <carpeta>" };
      if (values.color !== undefined && !/^#[0-9a-fA-F]{6}$/.test(values.color)) return { ok: false, message: `Color no válido: ${values.color} (usa #rrggbb)` };
      return (
        extra(1) ?? {
          ok: true,
          command: {
            kind: "docs",
            path: rest[0],
            out: values.salida,
            brand: values.marca ?? null,
            color: values.color ?? null,
            logo: values.logo ?? null,
            publishedOnly: values["solo-publicadas"] ?? false,
          },
        }
      );
    }
    default:
      return { ok: false, message: `Comando desconocido: ${name}` };
  }
}
