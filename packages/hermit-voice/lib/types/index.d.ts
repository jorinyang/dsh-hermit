export interface VoiceConfig {
  /** 语音引擎 WS 端口（引擎仅绑定回环） */
  port?: number
  /** 显式覆盖引擎地址（默认 ws://127.0.0.1:{port}/voice） */
  url?: string
}

export interface VoiceSpeakArgs {
  text: string
  priority?: 'urgent' | 'normal' | 'batch'
  source?: string
}

export interface VoiceStatus {
  state: string
  engine: { health: string; ready: boolean; degrade: number }
  metrics: { turns: number; p50: number | null; p95: number | null; lastE2e: number | null }
}
