---
name: feature-flag
description: Wrap a new feature behind a PostHog feature flag
---

## API side (apps/api)
```ts
import { PostHog } from 'posthog-node'
const posthog = new PostHog(process.env.POSTHOG_API_KEY!)

const flagEnabled = await posthog.isFeatureEnabled('flag-name', userId)
if (!flagEnabled) return reply.code(404).send({ error: 'not_available' })
```

## Mobile side (apps/mobile)
```tsx
import { useFeatureFlag } from 'posthog-react-native'

const isEnabled = useFeatureFlag('flag-name')
if (!isEnabled) return null
```

## Naming convention
`kebab-case`, prefixed by area: `credit-score-v2`, `remittance-beta`, `education-module`

## Process
1. Create flag in PostHog dashboard (start disabled)
2. Wrap feature in code
3. Enable for internal users only first
4. Widen to 10% → 50% → 100%
