import type { ArtemisAPI } from './index'

declare global {
  interface Window {
    artemis: ArtemisAPI
  }
}

export {}
