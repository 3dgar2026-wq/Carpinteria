# Revisión de derechos de recursos

Revisión del contenido disponible en `public/` al 6 de noviembre de 2026. Esta inspección identifica referencias y procedencia visible en el repositorio; no sustituye la confirmación documental de titulares.

| Recurso | Procedencia visible | Licencia o permiso | Estado |
| --- | --- | --- | --- |
| `public/images/decor-center-entrada.png` | Archivo local usado como fotografía del Hero | No consta en el repositorio | Pendiente de confirmar titularidad y permiso de publicación |
| `public/images/taller-carpinteria.png` | Archivo local | No consta en el repositorio | Pendiente de confirmar titularidad y permiso de publicación |
| Fotografías y videos del catálogo servidos por `/media/` | Contenido administrado fuera de los estáticos; en producción puede almacenarse externamente | No verificable en el código local | Confirmar derechos y autorizaciones de cada elemento publicado |
| Textos de interfaz, marca decorCenter y textos descriptivos | Incluidos directamente en HTML y JavaScript | No consta autoría o cesión formal | Confirmar autoría y autorización de uso de los textos y la marca |
| Iconos SVG del encabezado | Trazados SVG en línea dentro de `public/index.html` | No se encontró atribución externa en el código inspeccionado | Confirmar autoría; conservar atribuciones si se incorporan recursos de terceros |
| Fuentes | Pilas CSS con alternativas del sistema (`Cormorant Garamond`, `EB Garamond`, Georgia, Inter, Work Sans, Arial) | No hay archivos de fuente ni carga remota en el sitio | Sin recurso de fuente externo detectado; verificar licencias antes de alojar archivos de fuentes |
| Otros recursos remotos | No se encontraron importaciones de fuentes, scripts, estilos o iconos remotos en los archivos estáticos inspeccionados | No aplica | No se detectaron dependencias de contenido remoto |

No se descargó ni añadió contenido de terceros. Antes de publicar imágenes del catálogo, deben conservarse las atribuciones obligatorias y registrarse permisos por recurso cuando correspondan. La autorización pendiente principal es la de las dos imágenes locales y cada medio publicado en el catálogo; la procedencia/autorización de textos, marca e iconos tampoco está documentada en Git.
