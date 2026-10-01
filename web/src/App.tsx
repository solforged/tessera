import { useEffect, useState } from 'react';
import { get, type NotebookInfo } from './api';

type State =
  | { kind: 'loading' }
  | { kind: 'ready'; info: NotebookInfo }
  | { kind: 'error'; message: string };

export function App() {
  const [state, setState] = useState<State>({ kind: 'loading' });

  useEffect(() => {
    const controller = new AbortController();
    get<NotebookInfo>('/notebook', controller.signal)
      .then(info => setState({ kind: 'ready', info }))
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setState({ kind: 'error', message: error instanceof Error ? error.message : String(error) });
      });
    return () => controller.abort();
  }, []);

  return (
    <main className="shell">
      <h1>Tessera</h1>
      {state.kind === 'loading' && <p className="muted">Opening notebook…</p>}
      {state.kind === 'error' && (
        <p className="error" role="alert">
          Cannot reach the notebook service: {state.message}
        </p>
      )}
      {state.kind === 'ready' && (
        <dl className="facts">
          <dt>Notebook</dt>
          <dd>{state.info.path}</dd>
          <dt>ID</dt>
          <dd>{state.info.id}</dd>
          <dt>Schema</dt>
          <dd>version {state.info.schema_version}</dd>
          <dt>SQLite</dt>
          <dd>{state.info.sqlite_version}</dd>
        </dl>
      )}
    </main>
  );
}
