# Releases firmados de Storyboard Wana

Storyboard Wana publica instaladores NSIS para Windows y usa el actualizador firmado
de Tauri. La clave privada nunca forma parte del repositorio.

## Regla de autorización obligatoria

No ejecutar este procedimiento durante el desarrollo normal ni sin una petición expresa del usuario para guardar o publicar una versión.

Las pruebas cotidianas se realizan con `pnpm.cmd dev:desktop`. Nunca se debe instalar una compilación que todavía no exista como GitHub Release completo. La publicación, los assets y la verificación remota deben completarse antes de actualizar la aplicación instalada.

Consultar [Reglas operativas e incidentes](OPERATING_RULES_AND_INCIDENTS.md) antes de preparar cualquier versión.

## Archivos de la clave

La clave local vive en:

```text
%APPDATA%\FrameSync\updater\tauri-updater.key
%APPDATA%\FrameSync\updater\tauri-updater-password.txt
```

La clave pública correspondiente está incrustada en
`apps/desktop/src-tauri/tauri.conf.json`.

Si se pierde la clave privada, las instalaciones existentes no podrán aceptar
updates firmados con una clave nueva. En ese caso se requiere una instalación
manual de transición.

## Crear artefactos

Desde la raíz:

```powershell
pnpm.cmd release:windows
```

El comando valida TypeScript, pruebas y Clippy; compila el host nativo y la
extensión; crea el instalador firmado; y genera:

```text
target\release\bundle\release-assets-<versión>\
  Storyboard_Wana_<versión>_x64-setup.exe
  Storyboard_Wana_<versión>_x64-setup.exe.sig
  Storyboard_Wana_Capture_<versión>.zip
  latest.json
  SHA256SUMS.txt
```

## Publicar

1. Confirmar que la misma versión figura en los tres `package.json`, el
   workspace de Cargo y `tauri.conf.json`.
2. Crear el commit y el tag `app-v<versión>`.
3. Subir `main` y el tag.
4. Crear GitHub Release y subir todos los archivos de
   `release-assets-<versión>`.
5. Marcarlo como Latest.
6. Verificar
   `https://github.com/Lucasleiva1/storyboardwana/releases/latest/download/latest.json`.

El JSON debe responder HTTP 200, comenzar con `{` sin BOM, incluir
`windows-x86_64-nsis` y contener una firma no vacía.

## Probar una actualización real

1. Instalar la versión publicada.
2. Aumentar la versión, por ejemplo de `0.1.0` a `0.1.1`.
3. Repetir el build y publicar un nuevo tag.
4. En Storyboard Wana, abrir **Configuración → Buscar actualización**.
5. Descargar, instalar y comprobar el reinicio.

El updater se desactiva deliberadamente en `tauri dev`; la integración de la
extensión sí funciona en desarrollo.
