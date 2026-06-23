import ReactDOM from 'react-dom/client'
import App from './App'
import './styles.css'

// No StrictMode: its dev-only double-mount spawns the PTY twice (causing a stray
// "[process exited]") and doubles the orb's setup cost.
ReactDOM.createRoot(document.getElementById('root')!).render(<App />)
