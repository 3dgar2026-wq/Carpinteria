# Límite de intentos detrás de Render

Render pasa el tráfico público de Web Services por Cloudflare y el balanceador. También permite que los servicios del mismo workspace se comuniquen con un Web Service por la red privada, hacia el mismo listener HTTP. La aplicación no tiene una señal autenticada que diferencie esas dos rutas de entrada. Un servicio privado podría enviar `CF-Connecting-IP` o `X-Forwarded-For` arbitrarios.

Por ese motivo, la aplicación **no usa esos encabezados en Render**. Express conserva `trust proxy=false`; el resolver devuelve una dirección solo para conexiones directas de desarrollo y toma exclusivamente el socket. En Render, donde esa IP no representa necesariamente al visitante, se usan buckets que no dependen de encabezados: el login limita por la identidad `owner` configurada y la recuperación aplica un bucket estable por operación además de sus límites por cuenta y globales. Los valores se HMAC antes de guardarse. Así el tráfico público y privado no puede elegir ni rotar su IP de rate limit.

Los topes numéricos se mantienen: cinco intentos de login por ventana de 15 minutos; recuperación con 3 solicitudes por cuenta, 10 por bucket de cliente y 20 globales; verificación con 10 por cuenta, 30 por bucket de cliente y 400 globales. En Render, los buckets de cliente son del servicio y no por IP; esto es más restrictivo para recuperación que un bucket por IP, pero no puede ser evadido variando encabezados. En desarrollo directo se mantiene el bucket por la IP del socket. Direcciones desconocidas en desarrollo fallan cerradas.

La única sesión de administrador admitida por la aplicación es la cuenta activa configurada por `ADMIN_EMAIL` con rol `owner`. El rol `administrator` existe en la tabla de roles pero login, carga de sesión y recuperación exigen `owner`. No se habilita el rol administrador en esta intervención.

## Configuración y validación

Render establece automáticamente `RENDER=true` y `RENDER_SERVICE_TYPE=web` para Web Services. No copies estos valores a `.env`. No se requiere `trust proxy`, configuración de saltos ni una lista de CIDR. La configuración de producción debe conservar `trust proxy=false`.

Las pruebas locales cubren conexiones directas, IPv4/IPv6, encabezados ausentes, inválidos, duplicados o manipulados, límites repetidos y buckets independientes de los encabezados en modo Render. No prueban el firewall de Render ni una solicitud desde servicios de producción. La limitación por visitante/IP real en Render queda deshabilitada deliberadamente porque el proceso no puede autenticar la procedencia de esas cabeceras para tráfico privado. Para volver a un rate limit por IP hace falta un ingress que firme la identidad o que separe de manera verificable el tráfico privado; no basta con añadir otro encabezado.
