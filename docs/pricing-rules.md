# Configuración de medidas y reglas de precio

Las migraciones `002_catalog_configuration.sql` y `004_category_measurement_templates.sql` agregan columnas JSONB opcionales para reglas y medidas. `products.measurement_config` guarda la configuración propia del producto; `categories.measurement_template` guarda una plantilla reutilizable; `products.pricing_rules` y `categories.pricing_rules` conservan sus reglas de precio. La migración 004 solo agrega una columna nullable y su restricción de tipo objeto: no inserta valores ni modifica productos existentes. `GET /api/catalog` devuelve solo la configuración propia del producto y nunca devuelve la plantilla ni las reglas de precio.

## Plantillas y medidas por producto

`measurement_template` y `measurement_config` usan el mismo formato `version: 1` con una lista ordenada `dimensions`. Una plantilla se guarda en la categoría y solo se copia al producto cuando el carpintero decide aplicarla. Los cambios posteriores a la plantilla no modifican productos que ya guardaron su copia.

Las dimensiones fijas que el cliente solo consulta se guardan por separado en la columna existente `products.dimensions`, con el formato `{ "version": 1, "dimensions": [{ "label": "…", "value_m": 1.2 }] }`. Son información del producto, no campos de cotización; no participan en las reglas de precio. La API pública las devuelve como `fixed_dimensions` después de validar el formato. No se añadió una migración. Si un registro contiene un valor anterior que no coincide con este formato, la edición del panel lo conserva sin cambios y no lo muestra como una dimensión fija.

Cada dimensión admite:

| Campo | Uso |
| --- | --- |
| `key` | Una clave compatible (`width_m`, `height_m`, `depth_m`, `length_m`, `thickness_m`) o un identificador `custom_` estable. Las claves existentes no se renombran ni convierten. |
| `label` | Nombre cotidiano y editable mostrado al cliente, como “Ancho”, “Largo” o el nombre personalizado elegido. |
| `help` | Explicación opcional sobre cómo tomar la medida. |
| `min_m` | Límite mínimo opcional definido por el carpintero. Si se omite, se conserva el límite físico de no aceptar medidas negativas. |
| `max_m` | Límite máximo opcional. Si ambos límites existen, el mínimo no puede superar el máximo. |
| `required` | `false` permite dejar esa dimensión vacía; por defecto se requiere. |

Se admiten hasta doce medidas por plantilla o producto, sin repetir claves. La configuración del producto puede modificar, quitar, agregar y ordenar las medidas copiadas sin tocar la plantilla. Los valores ingresados por el cliente son texto decimal en metros; el catálogo acepta coma o punto y muestra la equivalencia en centímetros. El navegador y el servidor validan formato, límites configurados y campos obligatorios. La solicitud se queda en memoria del navegador y no se guarda ni se envía.

## Reglas de precio

La regla del producto tiene prioridad. Si no está configurada, el catálogo usa la regla de su categoría. Si ambas faltan o la regla no es válida, muestra que el precio está pendiente y permite incluir el trabajo en la solicitud.

Una regla tiene versión `1`, un código de moneda de tres letras y una expresión. La expresión es un árbol de nodos: una hoja puede referirse a una clave de medida admitida por su producto o contener una constante numérica; los nodos de operación admiten `add`, `subtract`, `multiply` y `divide`. La resta y división requieren dos argumentos; suma y multiplicación admiten de dos a ocho. `POST /api/catalog/:id/estimate` carga la regla del producto o de la categoría y calcula el resultado en el servidor; las reglas no se envían al navegador. El evaluador impone límites de profundidad y cantidad de nodos, no usa `eval`, rechaza dimensiones ausentes, división por cero y resultados negativos o no finitos.

Las hojas constantes, operaciones, unidades y tarifas deben reflejar reglas reales definidas por el negocio. Este documento no prescribe fórmulas ni tarifas comerciales. No hay valores predeterminados. Una regla configurada produce un valor **orientativo**; el carpintero confirma el precio final según materiales, acabados, herrajes, instalación y demás condiciones.

El panel de administración permite configurar estas columnas con validación en el servidor y autorización por sesión. La regla de precio se introduce en formato JSON; se valida su estructura, moneda, operaciones, campos y límites de profundidad/nodos. Las reglas de producto solo pueden referirse a dimensiones configuradas en ese producto. Las reglas de categoría pueden referirse a dimensiones que cada producto debe configurar. Las medidas y la solicitud permanecen solo en memoria del navegador; el resumen se copia manualmente y no se envía ni se guarda.
