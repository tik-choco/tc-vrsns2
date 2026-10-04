import { describe, expect, it } from 'vitest'
import { LLM_SETTINGS_MESSAGES } from '@tik-choco/mistai/preact'
import { aiTaskMessages } from './aiTasks'

describe('AI settings translations', () => {
  for (const catalog of [aiTaskMessages, LLM_SETTINGS_MESSAGES]) {
    for (const locale of ['ja', 'zh-CN', 'zh-TW'] as const) {
      it('has complete keys and placeholders in ' + locale, () => {
        const english = catalog.en as Record<string, string>
        const translated = catalog[locale] as Record<string, string>
        expect(Object.keys(translated).sort()).toEqual(Object.keys(english).sort())
        for (const [key, value] of Object.entries(english)) {
          expect(translated[key]?.trim(), key).toBeTruthy()
          const slots = (text: string) => (text.match(/\{[^}]+\}/g) ?? []).sort()
          expect(slots(translated[key]), key).toEqual(slots(value))
        }
      })
    }
  }
})
