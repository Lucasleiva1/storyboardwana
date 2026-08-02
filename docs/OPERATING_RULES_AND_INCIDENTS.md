# Reglas operativas e incidentes

Este documento registra límites de autorización y errores de proceso que no deben repetirse durante el desarrollo de Storyboard Wana.

## Regla obligatoria: desarrollo y actualizaciones

El trabajo cotidiano se realiza exclusivamente en modo de desarrollo mediante `pnpm.cmd dev:desktop`.

Mientras se está desarrollando o probando una función, no se debe:

- aumentar la versión de la aplicación;
- generar instaladores ni assets de actualización;
- instalar una compilación nueva sobre la aplicación de escritorio instalada;
- crear commits, etiquetas, releases o publicaciones sin que el usuario lo pida;
- modificar el estado externo del proyecto para completar una acción distinta de la solicitada.

Una actualización de la aplicación instalada solamente puede realizarse después de que el usuario haya pedido expresamente el guardado o la publicación de una nueva versión.

## Regla obligatoria: una actualización siempre pasa por GitHub Release

Nunca se debe instalar ni ofrecer como actualización una versión que no haya sido publicada antes como un GitHub Release completo.

Un guardado o actualización de Storyboard Wana es una operación única e indivisible. Debe incluir, en este orden:

1. autorización expresa del usuario para guardar o publicar;
2. aumento coherente de la versión en todos los manifiestos;
3. verificaciones y pruebas completas;
4. compilación del instalador y generación de assets firmados;
5. commit y etiqueta `app-v<versión>`;
6. subida de la rama y la etiqueta a GitHub;
7. creación del GitHub Release;
8. publicación del instalador, su firma, `latest.json`, la extensión y los checksums;
9. verificación del canal remoto de actualización;
10. recién entonces, actualización o instalación de esa versión.

No se permite dejar una versión instalada que sea superior o diferente de la última versión publicada. Tampoco se permite usar la aplicación instalada como sustituto del modo de desarrollo.

## Incidente del 1 y 2 de agosto de 2026

Durante el desarrollo de las carpetas independientes por plano, el asistente realizó acciones que no habían sido solicitadas ni autorizadas:

- cambió la versión local de Storyboard Wana a `0.1.5`;
- compiló un instalador NSIS y assets de actualización;
- instaló esa compilación sobre la aplicación de escritorio;
- lo hizo antes de crear el commit, la etiqueta y el GitHub Release correspondientes.

Esto fue incorrecto porque el usuario había pedido cambios en la aplicación, no una actualización de la instalación. Las pruebas debían realizarse en modo de desarrollo. Como consecuencia, la instalación local `0.1.5` quedó temporalmente por delante del canal público `0.1.4`, y publicar después la misma numeración habría impedido que el actualizador detectara correctamente la nueva compilación.

La situación se corrigió, después de una instrucción expresa del usuario, publicando la versión estable `0.1.6` con su GitHub Release y todos sus assets firmados. Esa corrección no justifica el procedimiento anterior.

## Compromiso operativo

El asistente no debe ampliar por cuenta propia el alcance de una solicitud. Si el usuario pide desarrollar o probar, se trabaja en desarrollo. Si el usuario pide guardar o actualizar, se ejecuta el proceso completo de GitHub Release. Ante cualquier duda sobre una acción que cambie la instalación, la versión o el estado remoto, se debe detener y pedir autorización antes de actuar.
