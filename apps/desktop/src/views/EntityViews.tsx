import { Image, MapPin, Shirt, Sparkles, UserRound } from "lucide-react";
import { useFrameSyncStore } from "../store";

export function ScriptView() {
  const scripts = useFrameSyncStore((state) => state.production.scripts);
  return (
    <section className="entity-workspace">
      <header className="section-titlebar">
        <div>
          <span className="section-code">GUIÓN MAESTRO</span>
          <h1>{scripts[0]?.title ?? "Sin versión aprobada"}</h1>
          <p>
            Las versiones anteriores permanecen disponibles y nunca se
            sobrescriben.
          </p>
        </div>
      </header>
      {scripts[0] ? (
        <article className="script-sheet">
          <div className="script-ruler">
            <span>V01</span>
            <span>APROBADA</span>
            <span>FUENTE TRAZABLE</span>
          </div>
          <pre>{scripts[0].text}</pre>
        </article>
      ) : (
        <EntityEmpty label="Aprobá e importá una propuesta de guion desde Fuentes." />
      )}
    </section>
  );
}

export function CharactersView() {
  const characters = useFrameSyncStore((state) => state.production.characters);
  return (
    <section className="entity-workspace">
      <header className="section-titlebar">
        <div>
          <span className="section-code">BIBLIA VISUAL / PERSONAJES</span>
          <h1>Personajes canónicos</h1>
          <p>{characters.length} fichas aprobadas para continuidad.</p>
        </div>
      </header>
      {characters.length > 0 ? (
        <div className="entity-grid">
          {characters.map((character, index) => (
            <article className="entity-card" key={character.id}>
              <div className="entity-index">
                PERS-{String(index + 1).padStart(2, "0")}
              </div>
              <div className="portrait-placeholder">
                <UserRound size={32} />
                <span>REFERENCIA SIN ASIGNAR</span>
              </div>
              <header>
                <div>
                  <span className="approved-label">APROBADO</span>
                  <h2>{character.name}</h2>
                </div>
                <Sparkles size={17} />
              </header>
              <p>{character.physicalDescription ?? "Sin descripción física"}</p>
              <dl>
                <div>
                  <dt>
                    <Shirt size={12} /> Vestuario
                  </dt>
                  <dd>{character.wardrobe ?? "Pendiente"}</dd>
                </div>
                <div>
                  <dt>Actitud</dt>
                  <dd>{character.attitude ?? "Pendiente"}</dd>
                </div>
              </dl>
            </article>
          ))}
        </div>
      ) : (
        <EntityEmpty label="Aprobá personajes en la revisión de Fuentes." />
      )}
    </section>
  );
}

export function LocationsView() {
  const locations = useFrameSyncStore((state) => state.production.locations);
  return (
    <section className="entity-workspace">
      <header className="section-titlebar">
        <div>
          <span className="section-code">BIBLIA VISUAL / ESCENARIOS</span>
          <h1>Escenarios canónicos</h1>
          <p>{locations.length} espacios disponibles para asignar a escenas.</p>
        </div>
      </header>
      {locations.length > 0 ? (
        <div className="entity-grid location-grid">
          {locations.map((location, index) => (
            <article className="entity-card location-card" key={location.id}>
              <div className="entity-index">
                LOC-{String(index + 1).padStart(2, "0")}
              </div>
              <div className="location-placeholder">
                <MapPin size={30} />
                <div className="frame-guides" />
                <span>REFERENCIA DE ESCENARIO</span>
              </div>
              <header>
                <div>
                  <span className="approved-label">APROBADO</span>
                  <h2>{location.name}</h2>
                </div>
                <Image size={17} />
              </header>
              <p>{location.description ?? "Sin descripción"}</p>
              <dl>
                <div>
                  <dt>Atmósfera</dt>
                  <dd>{location.atmosphere ?? "Por definir"}</dd>
                </div>
                <div>
                  <dt>Iluminación</dt>
                  <dd>{location.lighting ?? "Por definir"}</dd>
                </div>
              </dl>
            </article>
          ))}
        </div>
      ) : (
        <EntityEmpty label="Aprobá escenarios en la revisión de Fuentes." />
      )}
    </section>
  );
}

function EntityEmpty({ label }: { label: string }) {
  return (
    <div className="empty-workspace compact">
      <Sparkles size={26} />
      <h2>Todavía no hay contenido canónico</h2>
      <p>{label}</p>
    </div>
  );
}
