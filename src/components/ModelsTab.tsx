import { useCallback, useEffect, useState } from "react";
import { api, onModelDownload } from "../lib/api";
import { formatBytes, percent } from "../lib/format";
import type { ModelInfo } from "../lib/types";

interface Props {
  /** Called when the set of installed/active models may have changed. */
  onChanged: () => void;
}

export function ModelsTab({ onChanged }: Props) {
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setModels(await api.listModels());
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

  const anyInstalled = models.some((m) => m.installed);

  return (
    <div className="models">
      <p className="models-intro">
        {anyInstalled
          ? "Models run entirely on this Mac. Switch any time — the new one loads on your next capture."
          : "Pluck needs one model to read your selections. It downloads once and then runs entirely on this Mac."}
      </p>
      {errors._ && <p className="model-error">{errors._}</p>}
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
                <div className="progress" role="progressbar" aria-valuenow={percent(done, total)} aria-valuemin={0} aria-valuemax={100}>
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
        Downloads come from Hugging Face and are checked against their published checksum. This is the only time Pluck
        uses the internet.
      </p>
    </div>
  );
}
