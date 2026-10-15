import { useCallback, useEffect, useState } from "react";
import { api, onModelDownload } from "../lib/api";
import { formatBytes, percent } from "../lib/format";
import type { LocalModels, ModelInfo } from "../lib/types";

interface Props {
  /** Called when the set of installed/active models may have changed. */
  onChanged: () => void;
}

export function ModelsTab({ onChanged }: Props) {
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [local, setLocal] = useState<LocalModels>({ added: [], found: [] });

  const refresh = useCallback(async () => {
    try {
      const [catalog, onDisk] = await Promise.all([api.listModels(), api.listLocalModels()]);
      setModels(catalog);
      setLocal(onDisk);
    } catch (e) {
      setErrors((x) => ({ ...x, _: String(e) }));
    }
  }, []);

  useEffect(() => {
    void refresh();
    const sub = onModelDownload((ev) => {
      if (ev.state === "progress") {
        setModels((ms) =>
          ms.map((m) => (m.id === ev.id ? { ...m, progress: { downloaded: ev.downloaded, total: ev.total } } : m)),
        );
        return;
      }
      if (ev.state === "failed") setErrors((x) => ({ ...x, [ev.id]: ev.error }));
      void refresh();
      onChanged();
    });
    return () => void sub.then((unlisten) => unlisten());
  }, [refresh, onChanged]);

  async function run(id: string, action: () => Promise<void>) {
    setErrors((x) => {
      const next = { ...x };
      delete next[id];
      return next;
    });
    try {
      await action();
    } catch (e) {
      setErrors((x) => ({ ...x, [id]: String(e) }));
    }
    await refresh();
    onChanged();
  }

  const anyInstalled = models.some((m) => m.installed) || local.added.some((m) => m.available);

  return (
    <div className="models">
      <p className="models-intro">
        {anyInstalled
          ? "Models run entirely on this Mac. Switch any time — the new one loads on your next capture."
          : "Plucky needs one model to read your selections. It downloads once and then runs entirely on this Mac."}
      </p>
      {errors._ && <p className="model-error">{errors._}</p>}

      <LocalModelsSection local={local} errors={errors} run={run} />

      <h2 className="models-h">{anyInstalled ? "Download a model" : "Or download one"}</h2>
      <ul className="model-list">
        {models.map((m) => {
          const downloading = m.progress !== null;
          const total = m.progress?.total ?? m.approx_size_mb * 1e6;
          const done = m.progress?.downloaded ?? 0;
          return (
            <li key={m.id} className={m.active ? "model active" : "model"}>
              <div className="model-head">
                <div>
                  <h3>
                    {m.name}
                    {m.recommended && <span className="badge">Recommended</span>}
                    {m.active && <span className="badge on">In use</span>}
                  </h3>
                  <p className="model-meta">
                    {m.publisher} · {formatBytes(m.approx_size_mb * 1e6)} · {m.min_ram_gb} GB+ memory
                  </p>
                </div>
              </div>
              <p className="model-desc">{m.description}</p>

              {downloading && (
                <div
                  className="progress"
                  role="progressbar"
                  aria-valuenow={percent(done, total)}
                  aria-valuemin={0}
                  aria-valuemax={100}
                >
                  <div className="progress-bar" style={{ width: `${percent(done, total)}%` }} />
                </div>
              )}
              {downloading && (
                <p className="progress-label">
                  {formatBytes(done)} of {formatBytes(total)} · {percent(done, total)}%
                </p>
              )}
              {errors[m.id] && <p className="model-error">{errors[m.id]}</p>}

              <div className="model-actions">
                {!m.installed && !downloading && (
                  <button className="primary" onClick={() => void run(m.id, () => api.downloadModel(m.id))}>
                    {m.partial_bytes > 0 ? `Resume download (${formatBytes(m.partial_bytes)} done)` : "Download"}
                  </button>
                )}
                {downloading && (
                  <button className="ghost" onClick={() => void run(m.id, () => api.cancelDownload(m.id))}>
                    Pause
                  </button>
                )}
                {m.installed && !m.active && (
                  <button className="primary" onClick={() => void run(m.id, () => api.setActiveModel(m.id))}>
                    Use this model
                  </button>
                )}
                {m.installed &&
                  (confirmDelete === m.id ? (
                    <>
                      <span className="confirm">Delete {formatBytes(m.approx_size_mb * 1e6)}?</span>
                      <button
                        className="danger"
                        onClick={() => {
                          setConfirmDelete(null);
                          void run(m.id, () => api.deleteModel(m.id));
                        }}
                      >
                        Delete
                      </button>
                      <button className="ghost" onClick={() => setConfirmDelete(null)}>
                        Keep
                      </button>
                    </>
                  ) : (
                    <button className="ghost" onClick={() => setConfirmDelete(m.id)}>
                      Remove
                    </button>
                  ))}
              </div>
              <p className="model-license">License: {m.license}</p>
            </li>
          );
        })}
      </ul>
      <p className="models-foot">
        Downloads come from Hugging Face and are checked against their published checksum. This is the only time Plucky
        uses the internet.
      </p>
    </div>
  );
}

function LocalModelsSection({
  local,
  errors,
  run,
}: {
  local: LocalModels;
  errors: Record<string, string>;
  run: (id: string, action: () => Promise<void>) => Promise<void>;
}) {
  const [path, setPath] = useState("");
  const [adding, setAdding] = useState(false);

  async function addPath() {
    if (!path.trim() || adding) return;
    setAdding(true);
    await run("_path", async () => {
      await api.addModelFile(path);
      setPath("");
    });
    setAdding(false);
  }

  return (
    <section className="local-models" aria-labelledby="local-models-h">
      <h2 className="models-h" id="local-models-h">
        Already have a model?
      </h2>
      <p className="local-hint">
        Point Plucky at a GGUF model file on this Mac and it will use it directly — no download. Files from Ollama, LM
        Studio and Hugging Face work.
      </p>
      <form
        className="path-form"
        onSubmit={(e) => {
          e.preventDefault();
          void addPath();
        }}
      >
        <input
          className="path-input"
          value={path}
          onChange={(e) => setPath(e.target.value)}
          placeholder="~/Models/Llama-3.2-3B-Instruct-Q4_K_M.gguf"
          spellCheck={false}
          autoCorrect="off"
          autoCapitalize="off"
          aria-label="Model file path"
        />
        <button type="submit" className="primary" disabled={!path.trim() || adding}>
          {adding ? "Checking…" : "Use file"}
        </button>
      </form>
      {errors._path && <p className="model-error">{errors._path}</p>}
      <p className="local-tip">
        Tip: in Finder, right-click the file, hold <kbd>⌥</kbd> and choose <b>Copy “…” as Pathname</b>, then paste here.
      </p>

      {local.added.length > 0 && (
        <ul className="model-list compact">
          {local.added.map((m) => (
            <li key={m.id} className={m.active ? "model active" : "model"}>
              <h3>
                {m.name}
                {m.active && <span className="badge on">In use</span>}
                {!m.available && <span className="badge">File missing</span>}
              </h3>
              <p className="model-meta path" title={m.path}>
                {m.source ? `${m.source} · ` : ""}
                {formatBytes(m.size)} · {m.path}
              </p>
              {errors[m.id] && <p className="model-error">{errors[m.id]}</p>}
              <div className="model-actions">
                {m.available && !m.active && (
                  <button className="primary" onClick={() => void run(m.id, () => api.setActiveModel(m.id))}>
                    Use this model
                  </button>
                )}
                <button
                  className="ghost"
                  title="Plucky forgets this file; the file itself stays where it is."
                  onClick={() => void run(m.id, () => api.removeModelFile(m.id))}
                >
                  Remove from Plucky
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {local.found.length > 0 && (
        <>
          <h3 className="found-h">Found on this Mac</h3>
          <ul className="found-list">
            {local.found.map((f) => (
              <li key={f.path} className="found">
                <div className="found-text">
                  <span className="found-name">{f.name}</span>
                  <span className="model-meta">
                    {f.source} · {formatBytes(f.size)}
                  </span>
                </div>
                <button
                  className="ghost"
                  onClick={() =>
                    void run(`found:${f.path}`, async () => void (await api.addModelFile(f.path, f.source)))
                  }
                >
                  Use
                </button>
                {errors[`found:${f.path}`] && <p className="model-error">{errors[`found:${f.path}`]}</p>}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
