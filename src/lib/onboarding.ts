const ONBOARDING_DONE_KEY = 'tc-vrsns2:onboarding-done'

export function shouldShowOnboarding(): boolean {
  try {
    return localStorage.getItem(ONBOARDING_DONE_KEY) !== '1'
  } catch {
    return false
  }
}

export function markOnboardingDone(): void {
  try {
    localStorage.setItem(ONBOARDING_DONE_KEY, '1')
  } catch {
    // Storage can be unavailable in private browsing. The tour still remains usable.
  }
}
