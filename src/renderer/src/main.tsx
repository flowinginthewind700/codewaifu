import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { guardWindowDrops } from './attach'
// Same bundled face as the Bench (pro/main.tsx), minus italic: the widget's
// code blocks and mono chips read var(--mono), and two surfaces of one app
// must not disagree about what code looks like.
import '@fontsource/jetbrains-mono/400.css'
import '@fontsource/jetbrains-mono/700.css'
import './styles.css'

const container = document.getElementById('root')
if (!container) throw new Error('#root missing from index.html')

// Before anything renders: an unclaimed drop would otherwise navigate this
// window to the dropped file, replacing her with a PNG.
guardWindowDrops()

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>
)
