# FrameSync MVP 0.1 — plan de ejecución

## Resultado de hoy

El objetivo no es fingir que toda la visión está terminada. El resultado debe
ser un vertical slice verificable:

1. la extensión detecta una página, permite revisar una captura y comprueba el
   host;
2. el host nativo recibe el protocolo Chromium de Edge, valida y guarda una captura
   comprometida;
3. la aplicación de escritorio detecta esa captura, conserva el original,
   ejecuta análisis determinístico y ofrece revisión;
4. los elementos aprobados aparecen en una mesa horizontal de escenas y planos.

La demostración incluida atraviesa el mismo pipeline que una captura real.

## Decisiones de producto

- Nombre de trabajo: **FrameSync**.
- Windows y Microsoft Edge son la plataforma prioritaria del MVP; Chrome queda
  compatible por compartir Chromium MV3.
- La aplicación usa navegación principal horizontal. Los filtros, editores y
  detalles se despliegan hacia abajo; no hay navegación lateral persistente.
- El side panel de Edge es la única excepción porque es la superficie propia
  de la extensión.
- La fuente original es inmutable. Las interpretaciones y sus revisiones viven
  separadas.
- No se usa IA remota: el análisis inicial es determinístico y trazable.
- No se captura video web, no hay nube, autenticación ni colaboración.

## Ruta crítica

### 1. Base y contratos

- Monorepo `pnpm`.
- Contratos Zod compartidos.
- Fixture de conversación en español.
- Migración SQLite con WAL, foreign keys e índices.
- Documentación del protocolo y del modelo.

Salida: schemas y fixture pasan typecheck y pruebas.

### 2. Host de Native Messaging

- Lectura y escritura JSON con prefijo `uint32` little-endian.
- Modo binario explícito en Windows para no corromper saltos de línea.
- `ping`, `capture.begin`, `asset.begin/chunk/end` y `capture.commit`.
- Límites de mensaje y asset, SHA-256, nombres sanitizados y escritura atómica.
- Spool bajo `%LOCALAPPDATA%\FrameSync\inbox`.
- Registro por usuario en HKCU, sin requerir administrador.
- ID estable de extensión en desarrollo.

Salida: prueba CLI y prueba de protocolo con bytes reales.

### 3. Extensión Chromium MV3 (Edge principal)

- WXT, React y side panel.
- Service worker como único puente a `connectNative`.
- Captura seleccionada, cargada y seguimiento de sesión.
- Adaptador genérico y adaptador ChatGPT basado en atributos semánticos y
  fallbacks, nunca en una única clase minificada.
- Vista previa de mensajes, roles, imágenes, tamaño y advertencias.
- Transferencia de imágenes por chunks con hash.

Salida: build unpacked y `Host conectado` con ping real.

### 4. Ingesta de escritorio

- Tauri 2, React, TypeScript y SQLite.
- Proyecto local, polling controlado del inbox y validación del paquete.
- Importación transaccional, fingerprint y estado de duplicado.
- Fuentes con pestañas Original, Resumen y Estructura detectada.

Salida: una captura comprometida aparece en la bandeja sin perder el original.

### 5. Análisis y revisión

- Segmentación y reglas ES/EN para guion, personajes, escenarios, escenas,
  planos, prompts, correcciones y notas.
- Confianza, método y mensajes de origen en cada propuesta.
- Aprobar, rechazar, editar y crear manualmente.
- Importar solo elementos aprobados; nunca sobrescribir silenciosamente.

Salida: la demo genera entidades trazables y una corrección revisable.

### 6. Mesa de producción

- Barra superior: Fuentes, Guion, Personajes, Escenarios, Escenas y planos,
  Medios y Timeline.
- Escenas plegables en vertical.
- Planos como filas anchas y densas, con primera columna y encabezado fijos.
- Storyboard, primer frame y video como zonas de medios protagonistas.
- Editor de plano desplegado bajo la fila.
- Timeline inferior plegable y sincronizada.
- Dataset ampliado para comprobar 40 planos.

Salida: uso cómodo a 1280–1440 px sin canvas infinito.

### 7. Verificación Windows

- Typecheck, unit tests, build de extensión, build Rust, Clippy y build desktop.
- Checklist manual: unpacked, ID, HKCU, ping, captura, ACK, ingesta, análisis,
  aprobación y edición.
- Mensajes recuperables para host ausente, origen no autorizado, imagen
  inaccesible, hash incorrecto, duplicado y base bloqueada.

## Riesgos Windows y mitigaciones

| Riesgo                             | Prevención                                                        |
| ---------------------------------- | ----------------------------------------------------------------- |
| PowerShell bloquea `pnpm.ps1`      | usar `pnpm.cmd`; no cambiar ExecutionPolicy global                |
| ID unpacked cambia                 | clave pública de desarrollo fija y registro derivado del manifest |
| clave HKCU en vista 32/64 bits     | verificar ambas vistas y mostrar la ruta resuelta                 |
| espacios y acentos en rutas        | `-LiteralPath`, JSON real y argumentos PowerShell tipados         |
| stdout corrompe protocolo          | stdout exclusivo para frames; logs solo a stderr                  |
| modo texto altera `\n`             | activar modo binario al iniciar el host                           |
| antivirus/CFA bloquea escrituras   | escribir solo en LocalAppData y reportar `WRITE_FAILED`           |
| captura interrumpida               | carpeta `.partial`, hashes y `commit.json` atómico                |
| Edge conserva service worker viejo | comando de build, recarga explícita y diagnóstico de versión      |
| WebView2 ausente o bloqueado       | verificador previo y error guiado                                 |
| SQLite bloqueada                   | WAL, busy timeout y transacciones cortas                          |
| rutas largas                       | artifacts cortos bajo `target` y LocalAppData; no anidar copias   |
| imágenes muy grandes               | chunks acotados, límites configurables y progreso                 |

## Criterio de corte

Si el tiempo obliga a recortar, se preserva siempre la ruta
extensión → host → fuente original → análisis → revisión → planos. Se posponen
la captura completa con autoscroll, el watcher en tiempo real y la mayor parte
del pulido visual antes que simular una conexión o perder trazabilidad.
