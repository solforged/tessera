import '../shell/theme';
import '@fontsource-variable/ibm-plex-sans';
import '@fontsource-variable/piazzolla/standard.css';
import '@fontsource-variable/piazzolla/standard-italic.css';
import { render } from 'solid-js/web';
import { setStreamFactory, setTransport } from '../api/client';
import { App } from '../shell/App';
import { notebookFetch, notebookStream } from './transport';
import '../styles.css';

const root = document.getElementById('root');
if (!root) throw new Error('Missing #root element.');
setTransport(notebookFetch);
setStreamFactory(notebookStream);
// The app bundles its interface, so the native entry's offline cache is not registered.
render(() => <App />, root);
