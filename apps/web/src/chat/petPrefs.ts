/**
 * 桌宠偏好共享仓库：设置中心「外观」页签与 PetMascot 共用同一状态源。
 * localStorage('pet-prefs') 持久化（隐藏开关默认开启=显示，且跟随用户上一次的选择）；
 * useSyncExternalStore 保证多处读写自动同步。
 */
import { useSyncExternalStore } from 'react'

export type PetPos = 'left' | 'center' | 'right'
export type PetSize = 'sm' | 'md' | 'lg'
/** 话痨密度：quiet=只在 hover 时说话 / normal=仅状态变更说一句 / chatty=换到新台词也重新弹出 */
export type PetChat = 'quiet' | 'normal' | 'chatty'

export interface PetPrefs {
  pos: PetPos
  size: PetSize
  chat: PetChat
  /** 隐藏桌宠（默认 false=显示；持久化，跟随用户上一次的选择） */
  hidden: boolean
}

export const PET_POS_LABEL: Record<PetPos, string> = { left: '左侧', center: '居中', right: '右侧' }

const DEFAULTS: PetPrefs = { pos: 'right', size: 'md', chat: 'chatty', hidden: false }
const KEY = 'pet-prefs'

function load(): PetPrefs {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<PetPrefs>
    return { ...DEFAULTS, ...raw }
  } catch {
    return DEFAULTS
  }
}

let cached: PetPrefs = load()
const listeners = new Set<() => void>()

export function getPetPrefs(): PetPrefs {
  return cached
}

export function updatePetPrefs(patch: Partial<PetPrefs>): void {
  cached = { ...cached, ...patch }
  try {
    localStorage.setItem(KEY, JSON.stringify(cached))
  } catch {
    /* 存不上就仅本次会话生效 */
  }
  listeners.forEach((l) => l())
}

function subscribe(l: () => void): () => void {
  listeners.add(l)
  return () => {
    listeners.delete(l)
  }
}

/** React 侧订阅（设置中心与桌宠组件共用，任一处修改双方即时同步） */
export function usePetPrefs(): PetPrefs {
  return useSyncExternalStore(subscribe, getPetPrefs)
}
