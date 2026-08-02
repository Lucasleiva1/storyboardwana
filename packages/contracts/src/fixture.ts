import type { CaptureEnvelope } from "./index";

const capturedAt = "2026-07-29T12:00:00.000Z";

const sourceMessages = [
  {
    role: "user" as const,
    text: `GUIÓN — "La última frecuencia"

En una ciudad húmeda y casi vacía, Mara recibe por radio una señal que parece enviada por su hermano desaparecido. Teo intenta convencerla de abandonar el viejo estudio antes de la tormenta.

PERSONAJE: Mara
Operadora de radio de 32 años. Cabello oscuro corto, campera verde gastada, actitud precisa y desconfiada.

PERSONAJE: Teo
Sonidista de 38 años. Alto, anteojos redondos, piloto negro, lleva un grabador portátil. Es leal pero teme quedarse atrapado.

ESCENARIO: Estudio Aurora
Estudio de radio abandonado, paneles de madera, consolas analógicas, luz de emergencia ámbar, lluvia contra los ventanales.

ESCENARIO: Azotea
Techo industrial mojado, antena roja, viento fuerte, horizonte urbano azul petróleo.`,
  },
  {
    role: "assistant" as const,
    text: `ESCENA 01 — LA SEÑAL
Escenario: Estudio Aurora
Mara limpia una frecuencia. Una voz entrecortada pronuncia su nombre. Teo deja de enrollar un cable.

E01-P01 — Consola dormida
Plano detalle de los vúmetros apagados. La aguja despierta con un golpe de estática.
Duración: 3 s
Cámara: fija

E01-P02 — Mara escucha
Primer plano de Mara, iluminada por el piloto ámbar. Se quita un auricular para comprobar que la voz viene de la radio.
Duración: 4 s

E01-P03 — Teo al fondo
Plano medio con Teo desenfocado detrás. Él pregunta: "¿Lo conocés?"
Movimiento: acercamiento lento.

ESCENA 02 — EL ORIGEN
Escenario: Estudio Aurora
La señal marca una coordenada en la azotea.

E02-P01 — Mapa de interferencias
Plano cenital del papel donde Mara dibuja el patrón.
Duración: 3 s

E02-P02 — Decisión
Plano conjunto. Mara toma el transmisor; Teo bloquea la puerta por miedo.
Duración: 5 s

E02-P03 — Pasillo
Travelling trasero mientras corren hacia la escalera.
Duración: 4 s`,
  },
  {
    role: "user" as const,
    text: `ESCENA 03 — RESPUESTA
Escenario: Azotea

E03-P01 — Antena
Gran plano general de la azotea bajo la tormenta. Mara conecta el transmisor.
Duración: 4 s

E03-P02 — La voz
Primerísimo primer plano de Mara al oír: "No me busques. Terminá la película."
Duración: 6 s

PROMPT DE IMAGEN — E03-P01
Azotea industrial nocturna bajo lluvia intensa, mujer con campera verde junto a antena roja, ciudad azul petróleo, luz ámbar de transmisor, cinematográfico realista.

PROMPT DE VIDEO — E03-P01
La cámara avanza lentamente hacia la antena mientras el viento mueve la campera; relámpago distante, lluvia realista, 4 segundos.

NOTA: mantener la antena roja y la campera verde en todos los planos.`,
  },
  {
    role: "user" as const,
    text: `Cambio: reemplazá E02-P02. Teo no bloquea la puerta; apaga la consola para obligar a Mara a elegir. No aplicar hasta que lo revise.

Tal vez haya un plano de la escalera o quizá convenga unirlo con el pasillo. Todavía no está decidido.`,
  },
];

export const DEMO_CAPTURE: CaptureEnvelope = {
  protocolVersion: 1,
  captureId: "demo-la-ultima-frecuencia",
  platform: "generic",
  sourceUrl: "https://example.local/framesync-demo",
  conversationTitle: "La última frecuencia — captura de demostración",
  captureMode: "loaded",
  capturedAt,
  destinationProjectId: null,
  destinationProjectName: null,
  selectedShotIds: null,
  messages: sourceMessages.map((message, index) => ({
    id: `demo-message-${index + 1}`,
    orderIndex: index,
    role: message.role,
    text: message.text,
    htmlSnapshot: null,
    messageFingerprint: `demo-fingerprint-${String(index + 1).padStart(2, "0")}`,
    sourceDomId: null,
    createdAt: capturedAt,
  })),
  assets: [],
  diagnostics: {
    adapterId: "fixture.demo.v1",
    detectedMessageCount: sourceMessages.length,
    skippedNodeCount: 0,
    warnings: [
      "Fixture local: no contiene assets binarios.",
      "Incluye deliberadamente una corrección y un bloque ambiguo.",
    ],
  },
};
