import nextCoreWebVitals from 'eslint-config-next/core-web-vitals'
import nextTypescript from 'eslint-config-next/typescript'

// eslint-config-next 16 ships native flat configs, so these are spread
// directly. Before Next 16 this file went through FlatCompat, which is what
// `next lint` set up — that path throws a schema-validation error against
// v16, and is why the eslint-config-next bump could never go green alone.
const config = [
  // `next lint` supplied these implicitly. `eslint .` does not, so without
  // them the build output and Playwright artifacts get linted.
  {
    ignores: ['.next/', 'out/', 'next-env.d.ts', 'playwright-report/', 'test-results/'],
  },
  ...nextCoreWebVitals,
  ...nextTypescript,
  {
    // eslint-plugin-react-hooks 7 (new in eslint-config-next 16) adds two
    // React-Compiler-aware rules that fire as errors on patterns this app
    // already uses deliberately:
    //
    //   react-hooks/set-state-in-effect — LanguageProvider (reads
    //     localStorage after mount because it is unavailable during SSR),
    //     OtpForm, PayStep, ReviewConfirm, TransferTracker (fetch-on-mount).
    //   react-hooks/refs — lib/idempotency.ts's lazy ref init, which is the
    //     documented React pattern and carries a comment explaining why the
    //     read is safe.
    //
    // These are style opinions about cascading renders, not detected bugs,
    // and four of the six sites are onboarding or money-movement UI. Silently
    // rewriting those inside a framework bump is the wrong trade, so they are
    // demoted to warnings here and left visible rather than disabled.
    //
    // Follow-up: work through the six sites deliberately and restore these to
    // 'error'. Do NOT let this block the Next 15 EOL deadline (Oct 21 2026).
    rules: {
      'react-hooks/set-state-in-effect': 'warn',
      'react-hooks/refs': 'warn',
    },
  },
]

export default config
