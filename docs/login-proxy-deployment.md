# Despliegue del limitador de inicio de sesión detrás de proxy

La aplicación no configura `trust proxy`. El limitador de `server/admin-auth.js` toma `request.socket.remoteAddress` y guarda un bucket hash por dirección de conexión en `admin_login_attempts`: cinco intentos por ventana de quince minutos. Esta opción evita depender de encabezados reenviados que el cliente podría falsificar.

## Si Node recibe conexiones directamente

Mantenga el comportamiento actual. Compruebe que el puerto de Node solo sea accesible desde los clientes previstos y que no se altere `remoteAddress` mediante un intermediario no documentado.

## Si hay un proxy inverso

El proxy puede hacer que todos los clientes aparezcan con la misma dirección de socket. El límite se compartiría entonces entre clientes y un tercero podría agotar el cupo compartido. No habilite `trust proxy: true` ni lea `X-Forwarded-For` sin una configuración verificada.

Antes de cambiarlo, el responsable de infraestructura debe confirmar:

1. El producto y la topología reales (CDN, balanceador, proxy y saltos hasta Node).
2. Las IP/CIDR exactas de los proxies que pueden conectarse a Node y cómo restringir acceso directo al origen.
3. Que el proxy elimina el `X-Forwarded-For` recibido del cliente y escribe un valor propio confiable.
4. El número de saltos y la política para cambios de IPv4/IPv6, clientes detrás de NAT y direcciones compartidas.
5. Que las instancias comparten la persistencia del limitador; actualmente usa PostgreSQL para ello.

Si la infraestructura se confirma, configure Express para confiar únicamente en los CIDR/hops concretos del proxy y derive la IP desde `request.ip` bajo esa lista; el proxy debe sobrescribir el encabezado reenviado. Añada pruebas con encabezados falsificados, conexión directa y cadena válida del proxy antes del despliegue. Para limitar abuso distribuido también puede considerarse una cuota adicional por cuenta/IP a nivel de gateway, con respuestas genéricas y evitando bloqueos globales de una cuenta.

La topología de producción no está declarada en el repositorio inspeccionado, así que no se cambió la confianza del proxy ni la clave actual del bucket. El límite no puede considerarse probado para producción hasta completar esas verificaciones. La prueba de integración local genera solicitudes desde un único proceso/cliente loopback; no demuestra que la IP se particione correctamente entre clientes reales detrás de un proxy, CDN, NAT o varias instancias, ni que un firewall impida conexiones directas al origen.

## Evidencia y comprobación de despliegue

La revisión del código muestra que el limitador obtiene la IP de `request.socket.remoteAddress`; no lee `X-Forwarded-For` y `server/app.js` no establece `trust proxy`. No se encontraron manifiestos de proxy/ingress en el repositorio. Esto confirma el comportamiento del código, pero no si el servicio desplegado realmente recibe conexiones directas.

Para determinarlo, inspeccione la configuración del balanceador/CDN y del firewall del origen, confirme las direcciones origen que llegan al socket de Node desde los registros de infraestructura, y compruebe si el puerto de Node es accesible desde Internet sin pasar por el proxy. No use una petición pública de escaneo para inferirlo. Si Node solo acepta al proxy, documente sus CIDR exactos y su política de sobrescritura de encabezados.

Antes de cambiar el limitador, prepare una prueba en staging con al menos dos clientes de prueba: envíe un `X-Forwarded-For` falsificado desde el cliente A, verifique en el proxy que se reemplaza, y compruebe en Node que cada cliente obtiene la IP esperada. Asegure que seis fallos desde una misma IP producen bloqueo y que cinco fallos de A no bloquean a B cuando la política de negocio exige buckets por cliente. Repita con acceso directo al origen, IPv4/IPv6 y clientes detrás de NAT. Si `request.ip` se adopta, las pruebas deben demostrar que las IP incluidas en `X-Forwarded-For` no cambian la identidad del cliente cuando el socket no pertenece a un proxy CIDR confiable.

Las pruebas locales del proyecto y cualquier prueba con tráfico de staging deben respetar los límites de aislamiento documentados en `security-integration-tests.md`. La suite actual solo puede probar en su servidor loopback y en una base PostgreSQL desechable; no verifica la topología ni el firewall de producción. La allowlist de variables del runner no sustituye un sandbox del sistema operativo. La elección de `request.socket.remoteAddress` frente a `request.ip` queda pendiente hasta que infraestructura proporcione CIDR/hops confiables y política del proxy. No debe confiarse en encabezados enviados por el cliente ni habilitar `trust proxy` globalmente como sustituto de esa evidencia.
