/**
 * The Bench's entry point (F1).
 *
 * Three deliberate differences from the widget's `main.tsx`:
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
 * 3. The tree is wrapped in `FaultBoundary`. The widget can survive a blank
 *    frame - it is a floating avatar, and a crash there is visible as an absence
 *    on the desktop. The bench is the only view of what twenty agents are doing,
 *    where "the window went empty" is indistinguishable from "herdr died" and
 *    both look like the work is lost. Two renderer crashes shipped that way
 *    before the card existed; see `FaultBoundary.tsx`.
 */
import { createRoot } from 'react-dom/client'
// The bundled coding face, before anything that paints text: the terminal and
// every code block measure against it, and a face declared after first paint
// is a face the first pane was measured without. Weights are the three xterm
// and the bench chrome actually request (regular, bold, italic); the rest of
// the family stays in node_modules. See pro/terminalFont.ts for why the app
// ships its own mono instead of trusting the host.
import '@fontsource/jetbrains-mono/400.css'
import '@fontsource/jetbrains-mono/700.css'
import '@fontsource/jetbrains-mono/400-italic.css'
import '@xterm/xterm/css/xterm.css'
import './bench.css'
import { guardWindowDrops } from '../attach'
import { Bench } from './Bench'
import { FaultBoundary } from './FaultBoundary'

const container = document.getElementById('root')
if (!container) throw new Error('#root missing from pro.html')

// Before anything renders: a drop nobody claimed would otherwise navigate this
// window to the dropped file, and the bench is the only view of the work.
guardWindowDrops()

createRoot(container).render(
  <FaultBoundary>
    <Bench />
  </FaultBoundary>
)
