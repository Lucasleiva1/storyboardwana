# Storyboard Wana

Storyboard Wana es una aplicación de escritorio local-first para convertir
conversaciones y prompts audiovisuales en fuentes trazables, guiones,
personajes, escenarios, escenas, planos y storyboards.

Incluye:

- aplicación Windows construida con Tauri 2, React y SQLite;
- extensión Chromium MV3 para Microsoft Edge (compatible con Chrome) que
  captura conversaciones e imágenes;
- host de Native Messaging en Rust;
- análisis determinístico y revisión antes de importar;
- mesa horizontal de escenas y planos;
- actualizaciones firmadas desde GitHub Releases.

## Instalar

Descargá el instalador más reciente desde
[GitHub Releases](https://github.com/Lucasleiva1/storyboardwana/releases/latest).
La instalación es por usuario y no requiere permisos de administrador.

Después de instalar:

1. Abrí **Configuración** en Storyboard Wana.
2. Pulsá **Preparar conexión**.
3. Abrí la carpeta de la extensión.
4. En `edge://extensions`, activá **Modo de desarrollador**.
5. Elegí **Cargar descomprimida** y seleccioná la carpeta indicada.

Storyboard Wana registra automáticamente el host nativo en HKCU y mantiene un ID de
extensión estable:

```text
kdmgiohkeeehnpaccfmjgiccfbaodlhg
```

## Desarrollo en Windows

Requisitos: Node.js 22 o superior, pnpm 11, Rust MSVC, WebView2 y Microsoft
Edge.

```powershell
pnpm.cmd install
pnpm.cmd dev:desktop
```

Antes de abrir Tauri se compilan la extensión y el host de desarrollo. La ruta
unpacked es:

```text
apps\extension\.output\chrome-mv3
```

La aplicación registra ese host de depuración automáticamente, por lo que la
misma extensión sirve para probar el pipeline completo.

Comandos útiles:

```powershell
pnpm.cmd typecheck
pnpm.cmd test
pnpm.cmd lint
pnpm.cmd build:extension
pnpm.cmd release:windows
```

## Privacidad y seguridad

Los proyectos y capturas permanecen en el equipo. La extensión sólo se conecta
al host `com.framesync.capture`; el host sólo acepta el ID estable configurado;
y los updates se instalan únicamente después de validar su firma criptográfica.

La clave privada del updater vive fuera del repositorio.

## Documentación

- [Plan del MVP](docs/IMPLEMENTATION_PLAN_TODAY.md)
- [Protocolo Native Messaging](docs/NATIVE_MESSAGING_PROTOCOL.md)
- [Proceso de releases](docs/RELEASING.md)
- [Reglas operativas e incidentes](docs/OPERATING_RULES_AND_INCIDENTS.md)

## Licencia

MIT.
