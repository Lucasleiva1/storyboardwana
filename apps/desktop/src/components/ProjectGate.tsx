import { ArrowRight, Import, ScanLine, Settings } from "lucide-react";
import { FormEvent, useState } from "react";
import { useFrameSyncStore } from "../store";

export function ProjectGate() {
  const [name, setName] = useState("");
  const { createProject, importDemo, setActiveView, busy } =
    useFrameSyncStore();

  function submit(event: FormEvent) {
    event.preventDefault();
    void createProject(name);
  }

  return (
    <main className="project-gate">
      <section className="gate-intro">
        <div className="gate-mark">
          <ScanLine size={42} />
        </div>
        <p className="kicker">LOCAL-FIRST · WINDOWS · CHROME</p>
        <h1>
          De la conversación
          <br />
          al plano terminado.
        </h1>
        <p className="gate-copy">
          FrameSync conserva la fuente original, propone una estructura
          revisable y organiza guion, continuidad y medios en una mesa de
          producción horizontal.
        </p>
        <dl className="gate-specs">
          <div>
            <dt>FUENTE</dt>
            <dd>Inmutable</dd>
          </div>
          <div>
            <dt>ANÁLISIS</dt>
            <dd>Local y trazable</dd>
          </div>
          <div>
            <dt>DATOS</dt>
            <dd>SQLite</dd>
          </div>
        </dl>
      </section>

      <section className="gate-actions">
        <button
          className="gate-settings"
          onClick={() => setActiveView("settings")}
        >
          <Settings size={15} />
          Configuración, extensión y actualizaciones
        </button>
        <span className="gate-step">01 / CREAR PROYECTO</span>
        <h2>Prepará tu mesa de trabajo</h2>
        <form onSubmit={submit}>
          <label htmlFor="project-name">Nombre del proyecto</label>
          <input
            id="project-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Opcional · se asignará un nombre automático"
            autoFocus
          />
          <button className="primary-action" disabled={busy}>
            Crear proyecto
            <ArrowRight size={16} />
          </button>
        </form>
        <div className="gate-divider">
          <span>O EMPEZAR CON DATOS REALES DE PRUEBA</span>
        </div>
        <button
          className="secondary-action"
          disabled={busy}
          onClick={() => void importDemo()}
        >
          <Import size={16} />
          Crear e importar captura de demostración
        </button>
        <p className="gate-note">
          La demo contiene 2 personajes, 2 escenarios, 3 escenas, 8 planos, una
          corrección y un bloque ambiguo.
        </p>
      </section>
    </main>
  );
}
