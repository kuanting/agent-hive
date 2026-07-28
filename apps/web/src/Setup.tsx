import type { HiveStatus } from "./api.js";

/**
 * Setup answers one question Home deliberately does not: what could this machine
 * run, and why isn't it registered?
 *
 * Home shows promises — the agents an operator configured, which is what the
 * Queen routes on and what should stay short enough to scan. Everything a host
 * merely *could* do lives here instead, because a hive that showed you every
 * installed model as a capability is exactly the confusion this split fixes.
 * Nothing on this page is routed on.
 */
export function Setup({ status }: { status?: HiveStatus }) {
  const workers = status?.workers ?? [];

  if (workers.length === 0) {
    return (
      <div className="setup">
        <div className="empty">No workers registered. Start one with `npm run solo`.</div>
      </div>
    );
  }

  return (
    <div className="setup">
      {workers.map((w) => {
        const host = w.host;
        return (
          <section key={w.agentId} className="setup-worker">
            <h2>
              {w.agentId} <span className="muted">{w.site}</span>
            </h2>

            <h3>Configured agents</h3>
            <div className="caps">
              {w.capabilities.map((c, i) => (
                <span key={i} className={`cap t${c.tier}`}>
                  T{c.tier} {c.agent ?? c.runtime}
                  {c.model ? `/${c.model}` : ""}
                </span>
              ))}
              {w.capabilities.length === 0 && <span className="empty">nothing advertised</span>}
            </div>

            {!host ? (
              <div className="empty">
                This bee reported no host inventory (an older worker). Restart it to see what its machine can run.
              </div>
            ) : (
              <>
                <h3>Agents available on this host</h3>
                <div className="caps">
                  {host.runtimes.map((r) => (
                    <span key={r.name} className={`probe ${r.present ? "yes" : "no"}`} title={r.detail}>
                      {r.present ? "✓" : "✗"} {r.name}
                    </span>
                  ))}
                </div>

                <h3>
                  Models in local Ollama{" "}
                  <span className="muted">
                    {host.ollamaUp ? host.ollamaUrl : `${host.ollamaUrl} — not answering`}
                  </span>
                </h3>
                {host.models.length === 0 ? (
                  <div className="empty">
                    {host.ollamaUp ? "no models pulled" : "daemon unreachable"}
                  </div>
                ) : (
                  <table className="matrix">
                    <thead>
                      <tr>
                        <th>model</th>
                        <th>tools</th>
                        <th>tier</th>
                        <th>configure it</th>
                      </tr>
                    </thead>
                    <tbody>
                      {host.models.map((m) => {
                        const used = w.capabilities.some((c) => c.model === m.name);
                        return (
                          <tr key={m.name} className={used ? "used" : undefined}>
                            <td>{m.name}</td>
                            {/* Hermes always advertises tools, so a model without
                                them cannot serve it — worth seeing before you
                                configure one. */}
                            <td>{m.tools ? "✓" : "—"}</td>
                            <td>{m.cloud ? "2 (cloud seat)" : "3 (local)"}</td>
                            <td>
                              {used ? (
                                <span className="muted">in use</span>
                              ) : (
                                <code>{`agent: <name> / model: ${m.name}`}</code>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                )}

                {host.drops.length > 0 && (
                  <>
                    <h3>Configured but not registered</h3>
                    {host.drops.map((d, i) => (
                      <div key={i} className="setup-note drop">
                        <code>{d.label}</code> {d.reason}
                      </div>
                    ))}
                  </>
                )}

                {host.notes.length > 0 && (
                  <>
                    <h3>Registered, but will not run as written</h3>
                    {host.notes.map((n, i) => (
                      <div key={i} className="setup-note warn">
                        <code>{n.label}</code> {n.reason}
                      </div>
                    ))}
                  </>
                )}
              </>
            )}
          </section>
        );
      })}
    </div>
  );
}
