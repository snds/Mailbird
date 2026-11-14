import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import './app/icons'
import App from './App.tsx'
import { watchKeyboardInset } from './lib/keyboard-inset'
import { watchThemeColor } from './lib/theme-color'

watchKeyboardInset()
watchThemeColor()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
