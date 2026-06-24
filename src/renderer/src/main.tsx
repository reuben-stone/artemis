import ReactDOM from 'react-dom/client'
import App from './App'
import './styles.css'
import { initAccent } from './theme'

// Apply the saved accent before first paint so there's no violet flash on a custom theme.
initAccent()

// No StrictMode: its dev-only double-mount spawns the PTY twice (causing a stray
// "[process exited]") and doubles the orb's setup cost.
ReactDOM.createRoot(document.getElementById('root')!).render(<App />)
