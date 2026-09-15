/**
 * The Bench's entry point (F1).
 *
 * Two deliberate differences from the widget's `main.tsx`:
 *
 * 1. No `StrictMode`. Strict mode mounts, unmounts and remounts every component
 *    in development, which is a feature for pure React and a bug for anything
 *    holding an out-of-React resource: `Pane` constructs an xterm `Terminal` and
 *    registers it with `paneBus`, and the double mount would detach the frame
 *    router from the instance that is actually painted. The widget keeps
 *    StrictMode because its Live2D layer is idempotent; this one is not.
 * 2. xterm's stylesheet is imported before `bench.css`. Both define `.xterm`
 *    rules, and ours are the corrections (opaque background, our font stack),
 *    so ours must come last to win without `!important`.
 */
import { createRoot } from 'react-dom/client'
import '@xterm/xterm/css/xterm.css'
import './bench.css'
import { Bench } from './Bench'

const container = document.getElementById('root')
if (!container) throw new Error('#root missing from pro.html')

createRoot(container).render(<Bench />)
