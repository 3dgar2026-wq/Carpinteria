# Instrucciones del proyecto

## Objetivo y alcance

Esta aplicación sirve un catálogo público de trabajos de carpintería y un panel privado para administrarlos. No inventes la marca, los datos de contacto, el logotipo ni el contenido del negocio. No presentes datos de demostración como datos persistidos.

## Arquitectura

- Aplicación monolítica modular: Node.js 20+, Express y PostgreSQL.
- HTML, CSS y JavaScript del navegador sin framework de frontend mientras no exista una necesidad concreta.
- Mantén separadas las rutas HTTP, el acceso a datos, la lógica de negocio y los archivos estáticos.
- Los cambios de esquema se hacen con migraciones SQL reproducibles en `db/migrations/`.
- Los binarios multimedia se alojarán en almacenamiento persistente de objetos o archivos; PostgreSQL guarda metadatos y referencias, no los binarios.
- La configuración y los secretos vienen del entorno; nunca incluyas `.env` ni credenciales en Git.

## Diseño

Sigue `docs/design-system.md`. Prioriza accesibilidad, diseño adaptable, foco visible, jerarquía clara y controles fáciles de usar. No añadas sombras, degradados, colores saturados ni animaciones llamativas.

## Seguridad

- Valida toda entrada en el servidor y usa consultas parametrizadas.
- Las operaciones administrativas deben verificar sesión y permiso en el backend; ocultar controles en la interfaz no es autorización.
- No almacenes contraseñas sin hash resistente ni expongas secretos, trazas o datos personales innecesarios.
- Las cargas multimedia requieren límites, comprobación de tipo y almacenamiento persistente.
- Registra las operaciones administrativas importantes desde el backend.
- No ejecutes pruebas destructivas ni ataques contra sistemas externos o producción.
- Cloudflare `security-audit` está instalado en `.agents/skills/security-audit/SKILL.md` desde `cloudflare/security-audit-skill`. Lee sus instrucciones antes de usarlo. Para cambios cotidianos usa su modo de orientación y revisiones proporcionales al riesgo; ejecuta el flujo integral de seis fases solo cuando se solicite una auditoría completa. Sigue siempre sus límites de aislamiento al ejecutar código del proyecto.

## Cambios y comprobaciones

- Conserva código existente y limita los cambios al alcance solicitado.
- No añadas botones que aparenten funcionar sin una operación real.
- Ejecuta las comprobaciones disponibles después de cambios pertinentes e informa exactamente sus resultados.
- Documenta riesgos o limitaciones que impidan completar una función.

## Etapas

1. Inspección, documentación y base funcional.
2. Autenticación, sesiones y autorización por roles.
3. Gestión de categorías, trabajos, multimedia y bitácora.
4. Catálogo público conectado a PostgreSQL.
5. Cotizaciones orientativas mediante WhatsApp.
6. Administración, auditoría, pruebas y documentación de despliegue.

La arquitectura y el alcance de cada etapa se explican en `docs/architecture.md`.
