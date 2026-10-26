/** The definition the desktop app shows until workspaces exist (S3). Synthetic data only. */
export const DEMO_SPEC = `openapi: 3.1.0
info:
  title: Tienda
  version: 1.0.0
  description: Catálogo y pedidos de la tienda de ejemplo.
  contact:
    name: Equipo Tienda
    email: api@tienda-demo.test
servers:
  - url: https://api.tienda-demo.test/v1
tags:
  - name: productos
  - name: pedidos
paths:
  /productos:
    get:
      operationId: listarProductos
      tags: [productos]
      summary: Lista productos
      responses:
        '200':
          description: Página de productos
  /productos/{id}:
    get:
      operationId: obtenerProducto
      tags: [productos]
      summary: Obtiene un producto
      parameters:
        - name: id
          in: path
          required: true
          schema: { type: string }
      responses:
        '200':
          description: El producto
        '404':
          description: No existe
  /pedidos:
    post:
      operationId: crearPedido
      tags: [pedidos]
      summary: Crea un pedido
      responses:
        '201':
          description: Pedido creado
`;
