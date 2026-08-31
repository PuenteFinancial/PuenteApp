export type Lang = 'en' | 'es'

export type Translations = {
  nav: { remit: string; how: string; cta: string; signIn: string }
  hero: {
    eyebrow: string
    h1: [string, string][]
    sub: string
    cta1: string
    cta2: string
    elig: string
    pills: string[]
    notes: string[]
  }
  phone: {
    greeting: string
    name: string
    scoreLabel: string
    delta: string
    remitLabel: string
    remitNote: string
    reported: string
    onTime: string
    sends: { who: string; amt: string }[]
    cta: string
  }
  remit: {
    eyebrow: string
    h2: string
    sub: string
    calc: {
      to: string
      you: string
      they: string
      rate: string
      cta: string
    }
  }
  how: {
    eyebrow: string
    h2: [string, string][]
    sub: string
    heroAlt: string
    steps: { t: string; d: string }[]
    privacyTitle: string
    privacy: string
    eligTitle: string
    elig: string
    cta: string
  }
  wl: {
    eyebrow: string
    h2: string
    cta: string
    points: string[]
    f: {
      name: string
      phone: string
      country: string
      referralSource: string
      referralSourceOther: string
    }
    referralSourceOptions: string[]
    countries: string[]
    ph: { name: string; phone: string; referralSourceOther: string }
    select: string
    submit: string
    fine: string
    success: {
      title: string
      body: string
      refLabel: string
      copy: string
      copied: string
      wa: string
      waText: string
    }
    steps: { h: string }[]
    next: string
    back: string
    errors: { generic: string; validation: string }
  }
  footer: {
    tagline: string
    privacyLink: string
    termsLink: string
    // NEEDS LEGAL REVIEW (EN + ES) — regulatory disclosures, legally operative
    // in both languages. `entity` is split around the two licensing links.
    disclosures: {
      entity: [string, string, string]
      fincen: string
      fdic: string
      creditRepair: string
      results: string
    }
    rights: string
  }
  onboarding: {
    signup: {
      title: string
      sub: string
      phone: string
      phonePh: string
      smsConsent: string
      legal: { pre: string; privacyLink: string; and: string; termsLink: string; post: string }
      cta: string
      sending: string
      error: string
    }
    verify: {
      title: string
      sub: string
      code: string
      cta: string
      verifying: string
      resend: string
      resendIn: (seconds: number) => string
      resent: string
      error: string
    }
    profile: {
      title: string
      sub: string
      firstName: string
      lastName: string
      email: string
      emailNote: string
      // K2 address section (US-only sender)
      address: {
        heading: string
        note: string
        line1: string
        line2: string
        city: string
        state: string
        statePh: string
        zip: string
      }
      cta: string
      saving: string
      error: string
    }
    // K1 consent page: two checkboxes (E-SIGN, TOS+Privacy) + provider
    // disclosure links. Checkbox labels are legally operative in BOTH
    // languages — see NEEDS LEGAL REVIEW markers at the values.
    consent: {
      title: string
      sub: string
      esign: { pre: string; link: string; post: string }
      policies: { pre: string; termsLink: string; and: string; privacyLink: string; post: string }
      providers: { intro: string; stripeLink: string; bridgeLink: string }
      cta: string
      saving: string
      error: string
      stale: string
    }
    kyc: {
      title: string
      body: string
      dataNotice: string
      cta: string
      starting: string
      error: string
    }
    pending: { title: string; body: string; autoNote: string }
    rejected: {
      title: string
      body: string
      reasonLabel: string
      retryCta: string
      retrying: string
      retryError: string
      exhaustedBody: string
      supportCta: string
    }
    dashboard: {
      title: string
      // K5: rendered instead of `title` when web-kyc-at-first-send is ON and
      // the user has NOT been verified — the K2 wart was "You're verified"
      // shown to unverified users. `body` never claims verification, so it
      // needs no flag-aware twin.
      readyTitle: string
      body: string
      recipientsCta: string
      historyCta: string
    }
  }
  dashNav: {
    send: string
    transfers: string
    recipients: string
  }
  recipients: {
    title: string
    sub: string
    empty: string
    addRecipient: string
    firstName: string
    lastName: string
    lastNameNote: string
    relationship: string
    relationshipPh: string
    country: string
    countryMx: string
    save: string
    saving: string
    cancel: string
    addAccount: string
    bankAccount: string
    label: string
    labelPh: string
    clabe: string
    clabeConfirm: string
    clabeNote: string
    clabeMismatch: string
    accountEnding: string
    archive: string
    confirmArchive: string
    archived: string
    archiveFailed: string
    errors: {
      invalidClabe: string
      bankRejected: string
      alreadySaved: string
      providerDown: string
      generic: string
    }
  }
  send: {
    cta: string
    title: string
    sub: string
    dashboardReady: string
    // K5 expectation banner on the quote screen (flag-ON only): identity
    // verification happens at payment, on this page. limitLine renders only
    // when the (deliberately unpinned) limits response parses.
    limitsBanner: {
      title: string
      body: string
      limitLine: (max: string) => string
    }
    recipient: string
    recipientPh: string
    account: string
    accountPh: string
    noRecipients: string
    manageRecipients: string
    amount: string
    amountPh: string
    getQuote: string
    quoting: string
    youPay: string
    fee: string
    theyReceive: string
    rate: string
    rateValue: string
    expiresIn: string
    expiredNotice: string
    newQuote: string
    continue: string
    review: {
      title: string
      sub: string
      accept: string
      confirm: string
      confirming: string
      back: string
      confirmedTitle: string
      confirmedBody: string
      loading: string
      loadError: string
      retry: string
    }
    // Transfer tracker (PR3). NOTE: the Reg E disclosure copy is NOT here — it
    // is server-authored and rendered verbatim (see ReviewConfirm), as is the
    // 202 cancellation-requires-support message. These strings are UI chrome
    // around it. The cancel-window and outcome lines still make statements
    // about the sender's money and their cancellation right, so:
    // NEEDS LEGAL REVIEW (ES) — bundled into the PR7 human-ES review.
    track: {
      title: string
      youSend: string
      theyReceive: string
      steps: {
        PENDING_PAYMENT: string
        FUNDED: string
        SUBMITTED: string
        IN_FLIGHT: string
        COMPLETED: string
      }
      // States the Reg E RIGHT (the full window), not the mechanism. The
      // self-service cancel only works until the payout job claims the transfer
      // — seconds after funding, since payout.submit is enqueued with no delay —
      // after which the server returns its 202 support routing. cancelWindowNote
      // sets that expectation without overstating: a cancellation request that
      // arrives late is still timely under §1005.34, but it can't be automatic,
      // and if the payout already delivered it can't be honored at all.
      cancelWindow: string
      cancelWindowNote: string
      cancel: string
      cancelConfirm: string
      canceling: string
      simulate: string
      simulating: string
      simulateNote: string
      // The real pay step (PR-S3): Stripe Payment Element at PENDING_PAYMENT.
      // Stripe authors + localizes the mandate and its own field/bank errors
      // (via the Element's locale); these are only the Puente-authored frame.
      pay: {
        payTitle: string
        payNow: string
        paying: string
        // After confirmPayment resolves: the debit was SUBMITTED, not settled —
        // FUNDED arrives via webhook + poll. Copy must not claim "paid".
        submittedTitle: string
        submittedBody: string
        // funding-session fetch / Stripe loader failure — retryable, generic.
        sessionError: string
        // Instant-only verification: if their bank isn't connectable we cannot
        // take the payment at all — no microdeposit fallback at pilot.
        bankNote: string
        paymentError: string
        // Stripe crypto onramp widget (#213): rendered above Stripe's embedded
        // UI. The body must set expectations for the in-widget flow — Stripe
        // verifies the sender's identity and charges its own processing fee on
        // top — and must never claim anything was paid (the widget owns the
        // payment; our state advances only on the webhook).
        onrampTitle: string
        onrampBody: string
        // Out-of-band funding (FUNDING_PROCESSOR=manual): the sender pays by a
        // rail Puente does not operate, so there is nothing to click here. The
        // copy must set the expectation without implying we received anything
        // — the transfer only advances once an operator confirms the deposit.
        offlineTitle: string
        offlineBody: string
        offlineInstructions: {
          lead: string
          bank: string
          routing: string
          account: string
          beneficiary: string
          reference: string
          amount: string
          referenceWarning: string
        }
        // Sender payment claim (funding-ops slice 4): a set-once signal to
        // ops, never a release. The claimed copy must NOT promise instant (or
        // any automatic) release — release happens only after an operator
        // confirms the payment is on its way.
        claim: {
          button: string
          claiming: string
          claimedTitle: string
          claimedBody: string
          error: string
        }
      }
      // Embedded-components pay surface (K5): Link auth → KYC in OUR UI →
      // payment → checkout, all at PENDING_PAYMENT. Stripe authors and
      // localizes its own SDK surfaces (the Link OTP modal, the payment
      // element, the document upload); these are the Puente-authored frame
      // and the identity form around them. Busy states reuse the repo idiom
      // (label swap + disabled, no spinners); the submitted state reuses
      // pay.submittedTitle/submittedBody above.
      crypto: {
        intro: {
          title: string
          // Names the Stripe/Link emails and the USDC mechanism (decision 7:
          // de-emphasize crypto, never deny it).
          // NEEDS LEGAL REVIEW (EN + ES)
          expectation: string
          // Debit-forward labeling is the ONLY credit-card discouragement (no
          // backend restriction exists). States the cash-advance risk without
          // asserting any specific issuer's behavior.
          // NEEDS LEGAL REVIEW (EN + ES)
          methodsNote: string
          continueCta: string
        }
        link: {
          starting: string
          registering: string
          // Rendered above the SDK's OTP/consent modal.
          modalHint: string
          abandonedTitle: string
          abandonedBody: string
          resumeCta: string
          // The OAuth consent screen was declined — consent is required to
          // continue, so this explains rather than retries silently.
          declined: string
          // A later call answered link_auth_required: the flow returns to
          // Link auth and this line says why.
          reauthNote: string
        }
        kyc: {
          formTitle: string
          // Step-up re-entry (the 400 named the exact missing tier).
          formTitleStepUp: string
          sub: string
          firstName: string
          lastName: string
          addressLine1: string
          addressLine2: string
          city: string
          state: string
          postalCode: string
          // DOB is three separate numeric fields on purpose: EN and ES
          // readers order date parts differently, and a single text input
          // invites silently-swapped day/month.
          dobLegend: string
          dobMonth: string
          dobDay: string
          dobYear: string
          ssn: string
          // Where the SSN/DOB go (client → Stripe SDK only, never Puente).
          // NEEDS LEGAL REVIEW (EN + ES)
          ssnPrivacyNote: string
          submitCta: string
          submitting: string
          verifying: string
          verifyTimeout: string
          retryCta: string
          rejectedTitle: string
          // Must not claim anything was charged; routes to support.
          // NEEDS LEGAL REVIEW (EN + ES)
          rejectedBody: string
          docsTitle: string
          docsBody: string
          docsCta: string
          docsAbandoned: string
          achRequiresDocs: string
        }
        // Persona/Bridge fallback branch (decision 2, ratified 2026-08-28:
        // BEFORE payment). The user leaves for the partner-hosted flow and
        // returns; the waiting copy promises only the in-place update the
        // polling page actually delivers ("truthful pending copy").
        bridge: {
          title: string
          body: string
          tosCta: string
          waitingTitle: string
          waitingBody: string
        }
        collect: {
          title: string
          debitNote: string
        }
        pay: {
          creatingSession: string
          startingCheckout: string
        }
        errors: {
          // 409 conflict from session create/checkout: the attempt is dead,
          // payment restarts from method selection (never claims a charge).
          restartPayment: string
          retryCta: string
        }
      }
      loadError: string
      retry: string
      done: string
      // Shown on the delivered outcome — links to the receipt view (PR4).
      viewReceipt: string
      // Rendered as a mailto next to every message that tells a sender to
      // contact us — the 202 cancellation routing and the outcomes that direct
      // to support. Without it those messages instruct a sender to exercise a
      // statutory right with no route to do so.
      supportCta: string
      // The pending-cancellation banner (slice-7 PR6b). A flag ORTHOGONAL to
      // state: the payout keeps advancing while the request is open, so this
      // rides above the timeline rather than replacing it.
      cancellationRequested: { title: string; body: string }
      outcomes: {
        completed: { title: string; body: string }
        canceled: { title: string; body: string }
        refunded: { title: string; body: string }
        paymentFailed: { title: string; body: string }
        payoutFailed: { title: string; body: string }
        fundingReversed: { title: string; body: string }
        underReview: { title: string; body: string }
      }
    }
    // Receipt view (PR4). Chrome ONLY — the Reg E receipt body is server-authored
    // and rendered verbatim (see ReceiptView/DisclosureBody). Its counsel-final
    // wording is the PR7 gate; this chrome makes no statement about money or rights.
    receipt: {
      title: string
      viewHistory: string
    }
    // Transfer history (PR4) — the money-moved transaction list. Row status
    // labels reuse track.steps / track.outcomes; these are just list chrome.
    history: {
      title: string
      empty: string
      loadMore: string
      loading: string
      loadError: string
      retry: string
    }
    // code → user-facing message; the apiError layer maps the API error
    // envelope's stable `code` onto these (unmapped codes fall back to generic)
    errors: {
      validation_error: string
      unauthorized: string
      forbidden: string
      not_found: string
      kyc_required: string
      limit_exceeded: string
      transfer_in_progress: string
      quote_expired: string
      transfer_not_cancelable: string
      conflict: string
      idempotency_conflict: string
      // Embedded onramp (K5): the user must (re)connect with Link before the
      // call can work. The pay step handles this state machine-side; this
      // mapping is the fallback for any other surface.
      link_auth_required: string
      not_configured: string
      // Stripe onramp supportability refusal (#213): the payment provider
      // can't serve this sender's location/profile. Mentions that payment
      // couldn't START; must never claim anything was paid.
      funding_unsupported: string
      rate_limited: string
      rate_unavailable: string
      provider_rejected: string
      provider_unavailable: string
      internal_error: string
      cancellation_requires_support: string
      generic: string
    }
  }
  // 8.5-v1 read-only ops page (/dashboard/ops, admin-allowlisted). Operator
  // jargon, not consumer copy — no legal-review markers needed.
  ops: {
    title: string
    generatedAt: string
    loadFailed: string
    retry: string
    needsYou: string
    stateOfWorld: string
    pendingCancellations: string
    pendingCancellationsEmpty: string
    withinWindow: string
    outOfWindow: string
    refundMoving: string
    openTransfers: string
    openTransfersEmpty: string
    openTransfersNote: string
    dwell: string
    threshold: string
    holdLabel: string
    holdReasons: {
      fx_drift: string
      payability: string
      submit_error: string
      velocity_review: string
    }
    waitClaimed: string
    waitUncleared: string
    waitCancelRequested: string
    waitNoInstructions: string
    // Slice 4: the sender tapped "I've sent the payment" — verify the deposit
    // at the provider, then release. The strongest "your move" on a
    // PENDING_PAYMENT row once instructions are attached.
    waitSenderClaimed: string
    floatCeiling: string
    floatNotConfigured: string
    floatTripped: string
    floatOk: string
    floatBalance: string
    floatCeilingValue: string
    latestFindings: string
    findingsEmpty: string
    findingsNone: string
    checksSkipped: string
    checkError: string
    transferCounts: string
    transferCountsEmpty: string
    ledgerBalances: string
    ledgerBalancesAsOf: string
    ledgerBalancesEmpty: string
    reconRuns: string
    reconRunsEmpty: string
    reconStatus: { pass: string; findings: string; error: string }
    findingsCount: string
    workerHeartbeat: string
    workerHeartbeatEmpty: string
    heartbeatLive: string
    heartbeatStale: string
    heartbeatDead: string
    // v1.1 resolve-cancellation actions. Operator jargon, not consumer copy —
    // no legal-review markers needed (the consumer-facing Reg E strings live
    // in send.*; these render only on the admin-gated ops board).
    actions: {
      refund: string
      settleRefund: string
      deny: string
      cancel: string
      close: string
      confirmRefund: string
      confirmDeny: string
      working: string
      amountLabel: string
      requestedAtLabel: string
      refundConsequence: string
      settleNote: string
      denyEvidenceLabel: string
      denyEvidenceHint: string
      denyComparedNote: string
      denyTypoWarning: string
      denyInvalidTimestamp: string
      outcomes: {
        refunded: string
        denied: string
        already_disbursed: string
        already_refunded: string
      }
      errors: {
        claim_abandoned: string
        refund_owed: string
        evidence_conflict: string
        conflict: string
        not_found: string
        validation: string
        generic: string
      }
      // funding-ops-automation slice 1: per-row transfer actions (attach /
      // release / deposit-landed). Operator jargon, same posture as above.
      transfer: {
        attach: string
        release: string
        depositLanded: string
        confirmAttach: string
        confirmRelease: string
        confirmDepositLanded: string
        totalLabel: string
        onrampIdLabel: string
        onrampIdInvalid: string
        refLabel: string
        refRequired: string
        attachNote: string
        releaseConsequence: string
        depositLandedConsequence: string
        outcomes: {
          funded: string
          cleared: string
          cleared_skipped: string
          attached: string
        }
      }
    }
    // funding-ops-automation slice 2: the ad-hoc treasury top-up card.
    // Operator jargon, same posture as actions.*.
    topUp: {
      title: string
      amountLabel: string
      amountInvalid: string
      refLabel: string
      refHint: string
      prefundNote: string
      confirm: string
      booked: (balance: string) => string
    }
  }
  // Native-app-only copy. The web equivalents of these states are handled by
  // Next's error boundaries and server-side redirects, so there is nothing on
  // web to share with — but they still belong in the one string table, because
  // parity is what the `Record<Lang, Translations>` type enforces.
  mobile: {
    connection: { error: string; retry: string }
    signOut: string
  }
}

const en: Translations = {
  nav: { remit: 'Remittances', how: 'How it works', cta: 'Join the Waitlist', signIn: 'Sign in' },
  hero: {
    eyebrow: 'Remittances + credit building',
    h1: [
      ['Send', 'money.'],
      ['Build', 'credit.'],
    ],
    sub: 'Send money the way you already do, and build real U.S. credit with every transfer. All in one app.',
    cta1: 'Join the Waitlist',
    cta2: 'See how it works',
    elig: 'Works with your ITIN or SSN.',
    pills: ['Reports to all 3 credit bureaus', 'Set up in minutes', 'No credit card needed'],
    notes: ['Real exchange rate', 'Built for newcomers'],
  },
  phone: {
    greeting: 'Hi,',
    name: 'María',
    scoreLabel: 'Your credit score',
    delta: '▲ +132',
    remitLabel: 'Your remittances',
    remitNote: 'Each one counts ↑',
    reported: 'Reported on time · bureau',
    onTime: '✓ on time',
    sends: [
      { who: 'To Rosa Santos', amt: '−$200' },
      { who: 'To Miguel Ángel', amt: '−$150' },
    ],
    cta: 'Send money',
  },
  remit: {
    eyebrow: 'Remittances',
    h2: 'Money home, the moment you tap send.',
    sub: 'Secure international transfers in minutes. Every time you send using your Puente account, your U.S. credit history grows.',
    calc: {
      to: 'Sending to',
      you: 'You send',
      they: 'They receive',
      rate: '1 USD = 17.20 MXN',
      cta: 'Sign Up',
    },
  },
  how: {
    eyebrow: 'How it works',
    h2: [['Build credit ', 'without thinking about it.']],
    sub: 'Send money and watch your credit score grow. For only $5/month, each payment builds your U.S. credit history, automatically. No credit card required.',
    heroAlt:
      'The Puente app on a desktop screen, showing a send-money form next to a credit score of 712 rising over time.',
    steps: [
      {
        t: 'Send money home',
        d: 'Send like you always do. Transparent pricing. International transfers in minutes.',
      },
      {
        t: 'We report your on-time payments',
        d: 'Puente reports payments on your account to the 3 major U.S. credit bureaus.',
      },
      {
        t: 'Your credit history grows',
        d: 'Monitor your credit score growth in real time, all from the app. No credit card or confusing terms. Just credit building.',
      },
    ],
    privacyTitle: 'Commitment to privacy',
    privacy: 'Puente keeps sensitive personal information and account data protected and private.',
    eligTitle: 'Get started in minutes',
    elig: 'Works with ITIN or SSN',
    cta: 'Join the Waitlist',
  },
  wl: {
    eyebrow: 'Get started',
    h2: 'Sign up today',
    cta: 'Join the Waitlist',
    points: [
      'Get more out of your remittances',
      'Start building U.S. credit from your first transfer',
      'Build a better financial future',
    ],
    f: {
      name: 'Name',
      phone: 'Phone number or WhatsApp',
      country: 'Where do you send money?',
      referralSource: 'How did you hear about us?',
      referralSourceOther: 'Please specify',
    },
    referralSourceOptions: [
      'Facebook',
      'Instagram',
      'Friend or Family',
      'Google Search',
      'In Person',
      'Physical Advertisement',
      'Other',
    ],
    countries: ['Mexico', 'Other'],
    ph: { name: 'María Santos', phone: '(555) 123-4567', referralSourceOther: 'Tell us more' },
    select: 'Select…',
    submit: 'Join the waitlist',
    fine: 'Puente is in early validation and not yet available. Joining adds you to the early-access list.',
    success: {
      title: "You're on the list!",
      body: "We'll reach out the moment Puente is ready. Want to move up the line?",
      refLabel: 'Share your invite link and skip ahead',
      copy: 'Copy',
      copied: 'Copied!',
      wa: 'Share on WhatsApp',
      waText: 'I just joined the Puente waitlist. Send money home and build credit. Join me:',
    },
    steps: [{ h: 'Tell us about yourself' }, { h: 'Just a couple more questions' }],
    next: 'Next',
    back: 'Back',
    errors: {
      generic: 'Something went wrong on our end. Please try again.',
      validation: 'Please check your answers and try again.',
    },
  },
  footer: {
    tagline: 'Send money.\nBuild credit.',
    privacyLink: 'Privacy Policy',
    termsLink: 'Terms of Service',
    disclosures: {
      entity: [
        'Puente Financial, Inc. ("Puente") is a financial technology company, not a bank. Money transmission and payment services are provided by our U.S.-licensed partners. Money transmission is provided by Bridge Building Inc.; payment and funds-transfer services are provided by Stripe. Puente is an authorized agent of Bridge Building Inc. For partner state licensing information, see ',
        ' (Bridge, NMLS #2450917) and ',
        ' (Stripe).',
      ],
      fincen:
        'In the United States, Puente is registered with the U.S. Department of the Treasury Financial Crimes Enforcement Network (FinCEN) as a Money Services Business (BSA ID: 31000334222151).',
      fdic: 'Funds transferred through the Service are not deposits and are not insured by the FDIC.',
      creditRepair:
        'Puente is not a credit repair organization. Puente does not remove negative or inaccurate information from credit reports.',
      results:
        'Building credit takes time, and results are not guaranteed. Any credit scores, ranges, or improvements shown on this page are illustrative examples only. They do not reflect the actual experience of any specific customer and are not a promise, estimate, or guarantee of the results you will achieve. Individual results vary and depend on many factors, including your overall credit activity with Puente and with other creditors.',
    },
    rights: '© 2026 Puente Financial, Inc. All rights reserved.',
  },
  onboarding: {
    signup: {
      // Single door: this flow signs in returning users too — the copy
      // must not tell them they're creating an account
      title: 'Sign in or create your account',
      sub: 'Enter your mobile number and we’ll text you a verification code.',
      phone: 'Mobile number',
      phonePh: '(555) 555-5555',
      // NEEDS LEGAL REVIEW (EN + ES): TCPA consent language.
      //
      // A2P 10DLC: this campaign is registered as 2FA, so the consent scope must
      // name ONE message type — one-time codes. An earlier version added "and
      // account notices", which read as a second, unregistered category and was
      // rejected by TCR (error 30896, "opt-in does not align with the use case").
      // Do not widen this without re-registering the campaign for the wider use
      // case first. This exact string is also quoted verbatim in the campaign's
      // message_flow field in the Twilio console — the two must stay in sync.
      //
      // "Consent is not a condition of using Puente" was also dropped: it is a
      // marketing-consent construct, and it contradicted the checkbox, which is
      // `required` on the form.
      smsConsent:
        'I agree to receive automated one-time verification codes by text message from Puente Financial at this number. Codes are sent only when you request one. We send no marketing or promotional messages. Message and data rates may apply. Reply STOP to opt out or HELP for help.',
      // CTIA web opt-in: the privacy policy and terms must be reachable from the
      // point of consent. The site-wide Footer renders only on the homepage, so
      // /signup carried no legal links at all until these were added.
      legal: {
        pre: 'See our',
        privacyLink: 'Privacy Policy',
        and: 'and',
        termsLink: 'Terms of Service',
        post: 'for how we handle your mobile information.',
      },
      cta: 'Send code',
      sending: 'Sending…',
      error: 'We couldn’t send the code. Check the number and try again.',
    },
    verify: {
      title: 'Enter your code',
      sub: 'We sent a 6-digit code to your phone.',
      code: 'Verification code',
      cta: 'Verify',
      verifying: 'Verifying…',
      resend: 'Resend code',
      // Every resend is a real, billed SMS. The countdown is a client-side
      // courtesy only — there is no per-phone rate limit on the API yet
      // (docs/pre-implementation-todo.md), so it slows an impatient user, not
      // a hostile one.
      resendIn: (seconds: number) => `Resend code in ${seconds}s`,
      resent: 'Code sent again',
      error: 'That code didn’t work. Try again or resend it.',
    },
    profile: {
      title: 'Tell us about you',
      sub: 'Use your legal name. It must match your ID for identity verification.',
      firstName: 'First name',
      lastName: 'Last name',
      email: 'Email',
      emailNote: 'We’ll send you a verification email. You can keep going in the meantime.',
      address: {
        heading: 'Your U.S. home address',
        note: 'Use the address where you live. It must match your ID for identity verification.',
        line1: 'Street address',
        line2: 'Apt, suite, unit (optional)',
        city: 'City',
        state: 'State',
        statePh: 'Select state',
        zip: 'ZIP code',
      },
      cta: 'Continue',
      saving: 'Saving…',
      error: 'We couldn’t save your info. Please try again.',
    },
    // NEEDS LEGAL REVIEW (EN + ES): consent-page copy. The two checkbox
    // sentences are the operative assent language for E-SIGN and for the
    // TOS/Privacy contract — placeholder until the K7 counsel pass, which
    // reviews these strings together with the documents they reference.
    consent: {
      title: 'Review and agree',
      sub: 'Before you continue, please review and accept the following.',
      esign: {
        pre: 'I agree to receive all agreements, disclosures, receipts, and other records from Puente electronically, as described in the ',
        link: 'Consent to Electronic Records (E-SIGN)',
        post: '.',
      },
      policies: {
        pre: 'I have read and agree to Puente’s ',
        termsLink: 'Terms of Service',
        and: ' and ',
        privacyLink: 'Privacy Policy',
        post: '.',
      },
      providers: {
        intro:
          'Puente works with licensed partners to move your money: Stripe (payments) and Bridge (money transmission). Their terms apply when you use those services and are presented on their own screens.',
        stripeLink: 'Stripe legal terms',
        bridgeLink: 'Bridge legal terms',
      },
      cta: 'Agree and continue',
      saving: 'Saving…',
      error: 'We couldn’t save your agreement. Please try again.',
      stale: 'This page is out of date. Please reload it and try again.',
    },
    // NEEDS LEGAL REVIEW (ES): identity-verification requirement wording
    kyc: {
      title: 'Verify your identity',
      body: 'Federal law requires us to verify your identity before you can send money. Our secure partner Bridge handles this. It takes about 2 minutes. Have your ID handy.',
      // NEEDS LEGAL REVIEW (EN + ES): GLBA data-sharing disclosure
      dataNotice:
        'When you continue, we’ll share your name and email with Bridge (bridge.xyz), a licensed money transmitter that verifies your identity and processes transfers. Bridge will collect the rest (date of birth, address, SSN or ITIN, and an ID photo) directly from you.',
      cta: 'Verify my identity',
      starting: 'Starting…',
      error: 'We couldn’t start verification. Please try again.',
    },
    pending: {
      title: 'Your identity is being verified',
      body: 'This usually takes a few minutes but can take up to 1 business day.',
      autoNote: 'This page updates automatically, no need to refresh.',
    },
    // NEEDS LEGAL REVIEW (EN + ES): identity-verification outcome wording.
    // Must never read as a credit or account denial (no adverse-action
    // implication) — this is strictly about identity verification.
    // reasonLabel prefixes Bridge's reason strings, which arrive in English.
    rejected: {
      title: 'We couldn’t verify your identity',
      body: 'Some of the information or documents you provided couldn’t be confirmed. You can try again. It only takes a few minutes.',
      reasonLabel: 'What happened:',
      retryCta: 'Try again',
      retrying: 'Starting…',
      retryError: 'We couldn’t restart verification. Please try again.',
      exhaustedBody:
        'We weren’t able to verify your identity after several tries. Contact us and we’ll help you sort it out.',
      supportCta: 'Contact support',
    },
    dashboard: {
      title: 'You’re verified',
      readyTitle: 'You’re all set',
      body: 'Sending money is coming soon. We’ll let you know the moment it’s live.',
      recipientsCta: 'Manage recipients',
      historyCta: 'Transfer history',
    },
  },
  // The persistent dashboard nav (#202) — the structural fix for the
  // dead-end family (#194 and friends): every /dashboard screen shares this
  // chrome, so no screen needs its own way out.
  dashNav: {
    send: 'Send money',
    transfers: 'Transfers',
    recipients: 'Recipients',
  },
  recipients: {
    title: 'Your recipients',
    sub: 'The people you send money to, and where it arrives.',
    empty: 'No recipients yet. Add the first person you want to send money to.',
    addRecipient: 'Add a recipient',
    firstName: 'First name(s)',
    lastName: 'Last name(s)',
    lastNameNote: 'Include both last names exactly as they appear on their bank account.',
    relationship: 'Relationship',
    relationshipPh: 'Mother, brother, friend…',
    country: 'Country',
    countryMx: 'Mexico',
    save: 'Save',
    saving: 'Saving…',
    cancel: 'Cancel',
    addAccount: 'Add bank account',
    bankAccount: 'Bank account',
    label: 'Nickname (optional)',
    labelPh: 'BBVA account',
    clabe: 'CLABE (18 digits)',
    clabeConfirm: 'Confirm CLABE',
    clabeNote:
      'Ask your recipient for their 18-digit CLABE. Money sent to a wrong but valid account number can’t be recovered.',
    clabeMismatch: 'The CLABE numbers don’t match.',
    accountEnding: '····{last4}',
    archive: 'Archive',
    confirmArchive: 'Tap again to confirm',
    archived: 'Archived',
    archiveFailed: "Couldn't archive. Try again",
    errors: {
      invalidClabe: 'That CLABE doesn’t look right. Check the 18-digit number.',
      bankRejected: 'The bank rejected this account. Verify the CLABE with your recipient.',
      alreadySaved: 'This account is already saved.',
      providerDown: 'We couldn’t reach our payout provider. Try again in a moment.',
      generic: 'Something went wrong. Please try again.',
    },
  },
  send: {
    cta: 'Send money',
    title: 'Send money',
    sub: 'Choose who to pay and how much. We’ll show you the rate before anything is sent.',
    dashboardReady: 'Send money to your recipients, or manage who you send to.',
    limitsBanner: {
      title: 'Quick identity check at payment',
      body: 'You’ll verify your identity when you pay, right on this page. It usually takes under a minute.',
      limitLine: (max: string) => `Transfers over ${max} may also need a photo ID.`,
    },
    recipient: 'Recipient',
    recipientPh: 'Choose a recipient',
    account: 'Account',
    accountPh: 'Choose an account',
    noRecipients: 'You don’t have any recipients yet.',
    manageRecipients: 'Add a recipient',
    amount: 'Amount to send (USD)',
    amountPh: '0.00',
    getQuote: 'Get a quote',
    quoting: 'Getting your rate…',
    youPay: 'You pay',
    fee: 'Fee',
    theyReceive: 'They receive',
    rate: 'Exchange rate',
    rateValue: '1 USD = {rate} MXN',
    expiresIn: 'Rate locked for {time}',
    expiredNotice: 'This rate expired. Get a new quote to continue.',
    newQuote: 'New quote',
    continue: 'Continue',
    review: {
      title: 'Review and confirm',
      sub: 'Read the disclosure below, then confirm to send your money.',
      accept: 'I have read and accept this disclosure.',
      confirm: 'Confirm transfer',
      confirming: 'Confirming…',
      back: 'Back',
      confirmedTitle: 'Transfer confirmed',
      confirmedBody: 'Your transfer is confirmed and waiting for payment.',
      loading: 'Loading disclosure…',
      loadError: 'We couldn’t load the disclosure. Try again, or go back.',
      retry: 'Retry',
    },
    track: {
      title: 'Your transfer',
      youSend: 'You send',
      theyReceive: 'They receive',
      steps: {
        PENDING_PAYMENT: 'Waiting for payment',
        FUNDED: 'Payment received',
        // PR7: "Sent for payout" taught the wrong Reg E extinguishing event
        // (the right survives until pickup/deposit, not submission).
        SUBMITTED: 'Sending',
        IN_FLIGHT: 'On its way',
        COMPLETED: 'Delivered',
      },
      cancelWindow: 'You have {time} left to cancel this transfer.',
      // PR7: the old note named "sent for payout" — a step label that no longer
      // exists and the exact misstatement §4.1 corrects. This states the
      // MECHANISM (self-service ends when sending starts), not the legal rule.
      cancelWindowNote:
        'Once we start sending it, cancelling isn’t automatic. Contact us and we’ll take it from there.',
      cancel: 'Cancel transfer',
      cancelConfirm: 'Tap again to cancel',
      canceling: 'Canceling…',
      simulate: 'Simulate payment',
      simulating: 'Simulating…',
      simulateNote: 'Test environment only, stands in for card and bank payment.',
      pay: {
        payTitle: 'Pay with your bank',
        payNow: 'Pay {amount}',
        paying: 'Sending payment…',
        // NOT "paid": the ACH debit was submitted, settlement is days away.
        submittedTitle: 'Payment submitted',
        submittedBody:
          'We are confirming your payment with your bank. This usually takes a moment.',
        sessionError: 'We could not load the payment form. Please try again.',
        bankNote:
          "If you don't see your bank, we can't accept payments from it yet. You haven't been charged.",
        paymentError: 'Something went wrong with your payment. Please try again.',
        onrampTitle: 'Pay with card or bank',
        onrampBody:
          'Complete your payment securely with Stripe. Stripe will verify your identity and show you its processing fee before you confirm.',
        offlineTitle: 'Waiting for your deposit',
        // The deposit instructions live with the ops team, not in the app —
        // nothing in the schema stores them, so this copy must not promise
        // them here (#195).
        offlineBody:
          'Send your payment using the deposit instructions our team shared with you, including the reference code. This transfer moves as soon as we confirm the money arrived.',
        // Rendered instead of offlineBody once ops attaches the coordinates
        // (#199). The reference code is what ties the deposit to this
        // transfer at our partner — hence the warning line.
        offlineInstructions: {
          lead: 'Send your deposit to this account. This transfer moves as soon as we confirm the money arrived.',
          bank: 'Bank',
          routing: 'Routing number',
          account: 'Account number',
          beneficiary: 'Account name',
          reference: 'Reference code',
          amount: 'Amount to send',
          referenceWarning:
            'Include the reference code with your payment. Without it, we can’t match your deposit to this transfer.',
        },
        claim: {
          button: 'I’ve sent the payment',
          claiming: 'Recording…',
          claimedTitle: 'Thanks, we’ve noted your payment',
          claimedBody:
            'We’ll release your transfer once we confirm the payment is on its way. This page will update when it moves.',
          error: 'We couldn’t record that just now. Please try again.',
        },
      },
      crypto: {
        intro: {
          title: 'Verify and pay',
          // NEEDS LEGAL REVIEW (EN + ES)
          expectation:
            'Payments are processed by Stripe and its Link service, which convert your dollars to USDC, a digital dollar, to deliver your transfer. You may get confirmation emails from Stripe and from Link.',
          // NEEDS LEGAL REVIEW (EN + ES)
          methodsNote:
            'You can pay with a debit card or your bank account. Credit cards work too, but some card issuers treat this kind of payment as a cash advance and charge their own fees.',
          continueCta: 'Continue',
        },
        link: {
          starting: 'Connecting…',
          registering: 'Setting up your secure account…',
          modalHint: 'Verify with the code sent to your phone.',
          abandonedTitle: 'Verification not finished',
          abandonedBody:
            'No problem, nothing was charged. Pick up where you left off when you’re ready.',
          resumeCta: 'Continue verifying',
          declined:
            'To send money, you’ll need to allow the connection with Link. Nothing was charged. You can try again whenever you’re ready.',
          reauthNote: 'Your secure session expired. Please verify with Link again.',
        },
        kyc: {
          formTitle: 'Verify your identity',
          formTitleStepUp: 'A few more details',
          sub: 'Federal law requires us to verify who’s sending money. This usually takes seconds.',
          firstName: 'Legal first name',
          lastName: 'Legal last name',
          addressLine1: 'Street address',
          addressLine2: 'Apt, suite, unit (optional)',
          city: 'City',
          state: 'State',
          postalCode: 'ZIP code',
          dobLegend: 'Date of birth',
          dobMonth: 'Month',
          dobDay: 'Day',
          dobYear: 'Year',
          ssn: 'Social Security number',
          // NEEDS LEGAL REVIEW (EN + ES)
          ssnPrivacyNote:
            'Your SSN and date of birth go directly to Stripe for identity verification. Puente never receives or stores them.',
          submitCta: 'Verify my identity',
          submitting: 'Submitting…',
          verifying: 'Verifying your identity…',
          verifyTimeout: 'This is taking longer than usual. We’re still checking.',
          retryCta: 'Check again',
          rejectedTitle: 'We couldn’t verify your identity',
          // NEEDS LEGAL REVIEW (EN + ES)
          rejectedBody:
            'This transfer can’t continue and you haven’t been charged. Contact us at support@puentefinancial.com and we’ll help you sort it out.',
          docsTitle: 'Verify with a photo ID',
          docsBody:
            'Stripe will ask you to upload an ID document and take a selfie. It usually takes under a minute.',
          docsCta: 'Start ID verification',
          docsAbandoned: 'ID verification was closed before finishing. You can start it again.',
          achRequiresDocs: 'Paying from your bank account requires a photo ID first.',
        },
        bridge: {
          title: 'One more verification step',
          // NEEDS LEGAL REVIEW (EN + ES) — names the partner AT the handoff,
          // matching the onboarding disclosure's precedent. Compliance review
          // 2026-08-31 flagged "our delivery partner" as under-specific at the
          // moment the user leaves our surface, even though the consent page
          // names Bridge upstream.
          body: 'Bridge (bridge.xyz), the licensed money transmitter that delivers your money, also needs to verify your identity. You’ll complete it on Bridge’s secure page and come right back here.',
          tosCta: 'Continue verification',
          waitingTitle: 'Finishing verification',
          waitingBody:
            'We’re waiting for Bridge to confirm your verification. This page will update as soon as it’s done.',
        },
        collect: {
          title: 'Choose how to pay',
          debitNote: 'Debit is usually the cheaper option.',
        },
        pay: {
          creatingSession: 'Preparing your payment…',
          startingCheckout: 'Finishing your payment…',
        },
        errors: {
          restartPayment:
            'That payment attempt expired, so nothing was charged. Choose how to pay to try again.',
          retryCta: 'Try again',
        },
      },
      loadError: 'We couldn’t load this transfer. Try again.',
      retry: 'Retry',
      done: 'Back to dashboard',
      viewReceipt: 'View receipt',
      supportCta: 'Contact support',
      cancellationRequested: {
        title: 'Cancellation requested',
        body: 'We got your request to cancel this transfer. It was already on its way, so we’re working through it. This page will update when it’s resolved.',
      },
      outcomes: {
        completed: {
          title: 'Delivered',
          body: 'Your money reached your recipient’s account.',
        },
        canceled: {
          title: 'Canceled',
          // NOT "issued": CANCELED is now also the resting state for a refund
          // that still needs a human to send the money back (out-of-band
          // funding), where nothing has been disbursed at all. REFUNDED is
          // where issuance is asserted; this state only promises it is coming.
          // ("Issued", not "back", remains the rule there: a real ACH refund
          // posts days later and asserting arrival is unverifiable — PR7.)
          body: 'This transfer was canceled. Your full refund, including the fee, is on its way. Depending on your bank, it can take a few business days to appear.',
        },
        refunded: {
          title: 'Refunded',
          // Path-neutral on purpose: REFUNDED is reachable from cancel,
          // payout-failure, and review-resolution paths (PR7).
          body: 'Your full refund for this transfer, including the fee, has been issued. Depending on your bank, it can take a few business days to appear.',
        },
        paymentFailed: {
          title: 'Payment failed',
          // PAYMENT_FAILED is also set on webhook SILENCE (reconcile-pending
          // 30-min timeout) — not proof of no charge, so don't claim it (PR7).
          body: 'We couldn’t confirm your payment, so this transfer was not sent. If your bank shows a charge for it, contact us at support@puentefinancial.com and we’ll make it right. Start a new transfer to try again.',
        },
        payoutFailed: {
          title: 'Couldn’t be delivered',
          // PR7 truthfulness pass: states the ENTITLEMENT (owed in full, incl.
          // fee) without asserting execution status — AUTO_REFUND is off by
          // prod default, so issuance may await an operator. The page flips to
          // the refunded outcome when it actually issues.
          body: 'Your recipient’s bank couldn’t accept this transfer, so nothing was delivered. You’ll receive a full refund, including the fee. This page will update when it’s been issued. Contact support if you have questions.',
        },
        fundingReversed: {
          title: 'Payment reversed',
          body: 'Your bank reversed the payment for this transfer. Contact support so we can sort it out with you.',
        },
        underReview: {
          title: 'Working on your cancellation',
          // Promises ONLY what exists. The previous body said "we'll contact
          // you as soon as the review is done" — there is no outbound
          // notification mechanism in this codebase (no email service, no SMS
          // path outside Supabase Auth), so that was a promise nothing could
          // keep. The polling tracker DOES update in place, so that is what we
          // say. See the glossary's "Truthful pending copy".
          // Outcome-neutral on purpose (compliance review 2026-07-28): a
          // review can lawfully end in denial — the request beat our deposit
          // EVIDENCE but Bridge's authoritative timestamp can still show the
          // deposit came first — so "your refund" would pre-promise the very
          // question the review decides.
          body: 'Your transfer was delivered, and you asked to cancel it. We’re reviewing your request. This page will update when it’s resolved.',
        },
      },
    },
    receipt: {
      title: 'Transfer receipt',
      viewHistory: 'View all transfers',
    },
    history: {
      title: 'Transfer history',
      empty: 'You haven’t sent any transfers yet.',
      loadMore: 'Load more',
      loading: 'Loading…',
      loadError: 'We couldn’t load your transfers. Try again.',
      retry: 'Retry',
    },
    errors: {
      validation_error: 'Please check the details and try again.',
      unauthorized: 'Your session expired. Please sign in again.',
      forbidden: 'You don’t have access to do that.',
      not_found: 'We couldn’t find that. Refresh and try again.',
      kyc_required: 'You’ll need to verify your identity before sending money.',
      limit_exceeded:
        'This goes over your sending limit right now. Try a smaller amount or come back later.',
      transfer_in_progress:
        'You already have a transfer in progress. You can send again once it clears, usually within a few business days.',
      quote_expired: 'This rate expired. Get a new quote to continue.',
      transfer_not_cancelable: 'This transfer can no longer be canceled.',
      conflict: 'This can’t be updated right now. Refresh and try again.',
      idempotency_conflict:
        'We’re still processing your last request. Give it a moment before trying again.',
      link_auth_required: 'Please verify with Link again to continue.',
      not_configured: 'Sending money isn’t available yet. We’ll let you know the moment it’s live.',
      funding_unsupported:
        'Our payment provider can’t accept payments from your location right now, so this transfer can’t be completed. You haven’t been charged.',
      rate_limited: 'Too many attempts. Please wait a moment and try again.',
      rate_unavailable: 'We couldn’t get an exchange rate right now. Try again in a moment.',
      provider_rejected:
        'Our payout partner couldn’t accept this. Check the recipient’s account details.',
      provider_unavailable: 'We couldn’t reach our payout partner. Try again in a moment.',
      internal_error: 'Something went wrong on our end. Please try again.',
      cancellation_requires_support: 'Please contact support to cancel this transfer.',
      generic: 'Something went wrong. Please try again.',
    },
  },
  /* eslint-disable no-restricted-syntax -- operator jargon, not consumer copy; the em dash ban covers customer-facing strings only. */
  ops: {
    title: 'Operations overview',
    generatedAt: 'Generated',
    loadFailed: 'We couldn\u2019t load the ops overview.',
    retry: 'Retry',
    needsYou: 'Needs you',
    stateOfWorld: 'State of the world',
    pendingCancellations: 'Pending cancellation requests',
    pendingCancellationsEmpty: 'No pending cancellation requests.',
    withinWindow: 'within window',
    outOfWindow: 'out of window',
    actions: {
      refund: 'Refund',
      settleRefund: 'Settle refund',
      deny: 'Deny',
      cancel: 'Cancel',
      close: 'Close',
      confirmRefund: 'Confirm refund',
      confirmDeny: 'Confirm denial',
      working: 'Working…',
      amountLabel: 'Correction payment',
      requestedAtLabel: 'Requested at',
      refundConsequence:
        'Pays the sender this amount again as a correction payment — the recipient keeps the delivery.',
      settleNote:
        'A prior run already disbursed this refund; confirming settles the record — no money moves.',
      denyEvidenceLabel: 'Deposit time from the Bridge dashboard (ISO 8601 with timezone)',
      denyEvidenceHint: 'Example: 2026-08-01T15:04:05Z — the denial stands or falls on this value.',
      denyComparedNote:
        'It is compared against the request time above: deny only if the request came AFTER the deposit.',
      denyTypoWarning:
        'Careful: an EARLIER timestamp makes a wrongful denial MORE likely. Copy the dashboard value exactly, timezone included.',
      denyInvalidTimestamp: 'Enter a parseable ISO 8601 timestamp with an explicit timezone.',
      outcomes: {
        refunded: 'Refunded — correction payment sent.',
        denied: 'Denied — request closed.',
        already_disbursed: 'Settled — a prior run had already paid; no money moved now.',
        already_refunded: 'Already refunded — request closed; no money moved now.',
      },
      errors: {
        claim_abandoned:
          'DANGER: a prior refund run abandoned its claim and may have disbursed without recording it. Do NOT retry — follow runbooks/manual-refund.md (abandoned claims).',
        refund_owed:
          'This request met both cancellation conditions — a refund is owed and it cannot be denied by any tool. Refund it instead.',
        evidence_conflict: 'The cited deposit time conflicts with recorded evidence:',
        conflict: 'The board is stale — the transfer changed underneath. Refresh and re-check.',
        not_found: 'Transfer not found — refresh the board.',
        validation: 'The request was rejected as invalid — check the inputs.',
        generic:
          'The action failed. Nothing was changed silently — refresh and re-check the row before retrying.',
      },
      transfer: {
        attach: 'Attach instructions',
        release: 'Release payout',
        depositLanded: 'Deposit landed',
        confirmAttach: 'Confirm attach',
        confirmRelease: 'Confirm release',
        confirmDepositLanded: 'Confirm deposit landed',
        totalLabel: 'Transfer total',
        onrampIdLabel: 'Bridge onramp transfer id',
        onrampIdInvalid:
          'Enter the onramp id as a UUID — it is the deposit-side transfer, NOT the payout id.',
        refLabel: 'Deposit reference (the Bridge onramp id)',
        refRequired: 'The reference is required — it is the audit tie to the money that moved.',
        attachNote:
          'Pulls the deposit coordinates off the onramp and renders them on the sender’s pay step. Re-attaching overwrites.',
        releaseConsequence:
          'Releases the payout NOW against the treasury float for this amount — release only on evidence the sender’s ACH was initiated.',
        depositLandedConsequence:
          'Books ARRIVAL, not intent: settles the receivable and tops up the float. Run when the wallet balance actually moved. Re-tapping is safe.',
        outcomes: {
          funded: 'Released — the worker submits the payout within about a minute.',
          cleared: 'Deposit recorded — receivable settled and float topped up.',
          cleared_skipped:
            'Already recorded — the top-up re-posted as a no-op; nothing double-counted.',
          attached: 'Instructions attached — the sender’s pay step now shows the coordinates.',
        },
      },
    },
    topUp: {
      title: 'Record a float top-up',
      amountLabel: 'Amount added to the treasury wallet (USD)',
      amountInvalid: 'Enter dollars like 100 or 100.00.',
      refLabel: 'Reference (optional — the Bridge transaction id if you have one)',
      refHint:
        'Same reference = recorded once, ever; re-submitting is a no-op. Left blank, this booking gets its own one-off reference.',
      prefundNote:
        'For out-of-band wallet funding (prefunds), AFTER the balance actually moved — the ledger records arrival, not intent. If this deposit belongs to a transfer, use Deposit landed on its row instead; recording it here too would overstate the float.',
      confirm: 'Confirm top-up',
      booked: (balance: string) => `Booked — bridge_wallet_float is now ${balance}.`,
    },
    refundMoving: 'refund in motion',
    openTransfers: 'Open transfers',
    openTransfersEmpty: 'No open transfers.',
    openTransfersNote:
      'Dwell over threshold is a marker, not a verdict \u2014 check the wait annotations; Sentry pages own stuck calls.',
    dwell: 'Dwell',
    threshold: 'Threshold',
    holdLabel: 'Hold',
    holdReasons: {
      fx_drift: 'FX drift',
      payability: 'Payability',
      submit_error: 'Submit error',
      velocity_review: 'Velocity review',
    },
    waitClaimed: 'claimed (crash recovery)',
    waitUncleared: 'awaiting ACH clearing',
    waitCancelRequested: 'cancellation requested',
    waitNoInstructions: 'no deposit instructions attached',
    waitSenderClaimed: 'sender says payment sent — verify & release',
    floatCeiling: 'Float ceiling',
    floatNotConfigured: 'Float ceiling not configured in this environment.',
    floatTripped: 'Float ceiling tripped \u2014 payout submission paused',
    floatOk: 'Below ceiling',
    floatBalance: 'Fronted (funding receivable)',
    floatCeilingValue: 'Ceiling',
    latestFindings: 'Latest reconciliation findings',
    findingsEmpty: 'No reconciliation runs yet.',
    findingsNone: 'Latest run was clean.',
    checksSkipped: 'checks skipped (not run)',
    checkError: 'check failed',
    transferCounts: 'Transfers by state',
    transferCountsEmpty: 'No transfers yet.',
    ledgerBalances: 'Ledger balances',
    ledgerBalancesAsOf: 'as of last reconciliation run',
    ledgerBalancesEmpty: 'No reconciliation runs yet \u2014 balances appear after the first run.',
    reconRuns: 'Reconciliation runs',
    reconRunsEmpty: 'No runs recorded yet.',
    reconStatus: { pass: 'pass', findings: 'findings', error: 'error' },
    findingsCount: 'findings',
    workerHeartbeat: 'Worker heartbeat',
    workerHeartbeatEmpty: 'No heartbeat recorded yet.',
    heartbeatLive: 'beating',
    heartbeatStale: 'no beat in 15+ min',
    heartbeatDead: 'Worker heartbeat stopped — scheduled jobs are probably not running',
  },
  /* eslint-enable no-restricted-syntax */
  mobile: {
    connection: {
      // Deliberately not "signed out" or "session expired": a failed request
      // here is almost always the phone's network, and telling a user their
      // session died sends them back through SMS for nothing.
      error: 'We couldn’t reach Puente. Check your connection and try again.',
      retry: 'Try again',
    },
    signOut: 'Sign out',
  },
}

const es: Translations = {
  nav: {
    remit: 'Remesas',
    how: 'Cómo funciona',
    cta: 'Únete a la Lista de Espera',
    signIn: 'Iniciar sesión',
  },
  hero: {
    eyebrow: 'Remesas + historial de crédito',
    h1: [
      ['Envía', 'dinero.'],
      ['Crea', 'crédito.'],
    ],
    sub: 'Envía dinero como ya lo haces, y construye crédito real en EE. UU. con cada transferencia. Todo en una sola app.',
    cta1: 'Únete a la Lista de Espera',
    cta2: 'Mira cómo funciona',
    elig: 'Funciona con tu ITIN o SSN.',
    pills: [
      'Reporta a los 3 burós de crédito',
      'Configúralo en minutos',
      'No necesitas tarjeta de crédito',
    ],
    notes: ['Tipo de cambio real', 'Hecha para ti'],
  },
  phone: {
    greeting: 'Buenas,',
    name: 'María',
    scoreLabel: 'Tu puntaje de crédito',
    delta: '▲ +132',
    remitLabel: 'Tus remesas',
    remitNote: 'Cada una suma ↑',
    reported: 'Reportada a tiempo · buró',
    onTime: '✓ a tiempo',
    sends: [
      { who: 'Para Rosa Santos', amt: '−$200' },
      { who: 'Para Miguel Ángel', amt: '−$150' },
    ],
    cta: 'Enviar dinero',
  },
  remit: {
    eyebrow: 'Remesas',
    h2: 'Dinero a casa, en el momento en que tocas enviar.',
    sub: 'Transferencias internacionales seguras en minutos. Cada vez que envías usando tu cuenta de Puente, tu historial crediticio en EE. UU. crece.',
    calc: {
      to: 'Enviar a',
      you: 'Tú envías',
      they: 'Ellos reciben',
      rate: '1 USD = 17.20 MXN',
      cta: 'Regístrate',
    },
  },
  how: {
    eyebrow: 'Cómo funciona',
    h2: [['Crea crédito ', 'sin siquiera pensarlo.']],
    sub: 'Envía dinero y mira crecer tu puntaje de crédito. Por solo $5/mes, cada pago construye tu historial crediticio en EE. UU., automáticamente. No requiere tarjeta de crédito.',
    heroAlt:
      'La app de Puente en una pantalla de escritorio, con el formulario para enviar dinero junto a un puntaje de crédito de 712 que sube con el tiempo.',
    steps: [
      {
        t: 'Envía dinero a casa',
        d: 'Envía como siempre. Precios transparentes. Transferencias internacionales en minutos.',
      },
      {
        t: 'Reportamos tus pagos a tiempo',
        d: 'Puente reporta los pagos de tu cuenta a los 3 principales burós de crédito de EE. UU.',
      },
      {
        t: 'Tu historial de crédito crece',
        d: 'Monitorea el crecimiento de tu puntaje de crédito en tiempo real, todo desde la app. Sin tarjeta de crédito ni términos confusos. Solo construcción de crédito.',
      },
    ],
    privacyTitle: 'Compromiso con la privacidad',
    privacy: 'Puente mantiene tu información personal y datos de cuenta protegidos y privados.',
    eligTitle: 'Empieza en minutos',
    elig: 'Funciona con ITIN o SSN',
    cta: 'Únete a la Lista de Espera',
  },
  wl: {
    eyebrow: 'Empieza ya',
    h2: 'Regístrate hoy',
    cta: 'Únete a la Lista de Espera',
    points: [
      'Aprovecha más tus remesas',
      'Empieza a crear crédito desde tu primera transferencia',
      'Construye un mejor futuro financiero',
    ],
    f: {
      name: 'Nombre',
      phone: 'Teléfono o WhatsApp',
      country: '¿A dónde envías dinero?',
      referralSource: '¿Cómo te enteraste de nosotros?',
      referralSourceOther: 'Por favor especifica',
    },
    referralSourceOptions: [
      'Facebook',
      'Instagram',
      'Amigo o familiar',
      'Búsqueda en Google',
      'En persona',
      'Publicidad física',
      'Otro',
    ],
    countries: ['México', 'Otro'],
    ph: { name: 'María Santos', phone: '(555) 123-4567', referralSourceOther: 'Cuéntanos más' },
    select: 'Selecciona…',
    submit: 'Unirme a la lista',
    fine: 'Puente está en validación temprana y aún no está disponible. Al unirte entras a la lista de acceso anticipado.',
    success: {
      title: '¡Estás en la lista!',
      body: 'Te avisaremos en cuanto Puente esté listo. ¿Quieres adelantarte en la fila?',
      refLabel: 'Comparte tu enlace de invitación y avanza',
      copy: 'Copiar',
      copied: '¡Copiado!',
      wa: 'Compartir por WhatsApp',
      waText: 'Me uní a la lista de Puente. Envía dinero a casa y crea crédito. Únete:',
    },
    steps: [{ h: 'Cuéntanos sobre ti' }, { h: 'Un par de preguntas más' }],
    next: 'Siguiente',
    back: 'Atrás',
    errors: {
      generic: 'Algo salió mal de nuestro lado. Por favor, inténtalo de nuevo.',
      validation: 'Por favor revisa tus respuestas e inténtalo de nuevo.',
    },
  },
  footer: {
    tagline: 'Envía dinero.\nCrea crédito.',
    privacyLink: 'Política de Privacidad',
    termsLink: 'Términos de Servicio',
    disclosures: {
      entity: [
        'Puente Financial, Inc. ("Puente") es una empresa de tecnología financiera, no un banco. Los servicios de transmisión de dinero y de pagos son proporcionados por nuestros socios con licencia en EE. UU. La transmisión de dinero es proporcionada por Bridge Building Inc.; los servicios de pago y de transferencia de fondos son proporcionados por Stripe. Puente es un agente autorizado de Bridge Building Inc. Para información sobre las licencias estatales de nuestros socios, consulte ',
        ' (Bridge, NMLS #2450917) y ',
        ' (Stripe).',
      ],
      fincen:
        'En los Estados Unidos, Puente está registrada ante la Red de Control de Delitos Financieros del Departamento del Tesoro de EE. UU. (FinCEN) como un Negocio de Servicios Monetarios (BSA ID: 31000334222151).',
      fdic: 'Los fondos transferidos a través del Servicio no son depósitos y no están asegurados por la FDIC.',
      creditRepair:
        'Puente no es una organización de reparación de crédito. Puente no elimina información negativa o inexacta de los reportes de crédito.',
      results:
        'Construir crédito toma tiempo y los resultados no están garantizados. Los puntajes, rangos o mejoras de crédito que se muestran en esta página son únicamente ejemplos ilustrativos. No reflejan la experiencia real de ningún cliente en particular y no son una promesa, estimación ni garantía de los resultados que usted obtendrá. Los resultados individuales varían y dependen de muchos factores, incluida su actividad crediticia general con Puente y con otros acreedores.',
    },
    rights: '© 2026 Puente Financial, Inc. Todos los derechos reservados.',
  },
  onboarding: {
    signup: {
      // Puerta única: este flujo también inicia sesión para usuarios que
      // regresan — el texto no debe decirles que están creando una cuenta
      title: 'Inicia sesión o crea tu cuenta',
      sub: 'Ingresa tu número de celular y te enviaremos un código de verificación por SMS.',
      phone: 'Número de celular',
      phonePh: '(555) 555-5555',
      // NEEDS LEGAL REVIEW (EN + ES): texto de consentimiento TCPA.
      // Ver la nota en la versión en inglés: el alcance del consentimiento debe
      // nombrar únicamente los códigos de un solo uso (A2P 10DLC, error 30896).
      smsConsent:
        'Acepto recibir códigos de verificación de un solo uso por mensaje de texto automatizado de Puente Financial en este número. Los códigos se envían solo cuando los solicitas; no enviamos mensajes de marketing ni promocionales. Pueden aplicar tarifas de mensajes y datos. Responde STOP para cancelar o HELP para obtener ayuda.',
      legal: {
        pre: 'Consulta nuestra',
        privacyLink: 'Política de Privacidad',
        and: 'y nuestros',
        termsLink: 'Términos de Servicio',
        post: 'para saber cómo tratamos tu información móvil.',
      },
      cta: 'Enviar código',
      sending: 'Enviando…',
      error: 'No pudimos enviar el código. Revisa el número e inténtalo de nuevo.',
    },
    verify: {
      title: 'Ingresa tu código',
      sub: 'Enviamos un código de 6 dígitos a tu teléfono.',
      code: 'Código de verificación',
      cta: 'Verificar',
      verifying: 'Verificando…',
      resend: 'Reenviar código',
      resendIn: (seconds: number) => `Reenviar código en ${seconds}s`,
      resent: 'Código reenviado',
      error: 'Ese código no funcionó. Inténtalo de nuevo o reenvíalo.',
    },
    profile: {
      title: 'Cuéntanos sobre ti',
      sub: 'Usa tu nombre legal. Debe coincidir con tu identificación para la verificación de identidad.',
      firstName: 'Nombre',
      lastName: 'Apellido',
      email: 'Correo electrónico',
      emailNote: 'Te enviaremos un correo de verificación. Puedes continuar mientras tanto.',
      address: {
        heading: 'Tu dirección en EE. UU.',
        note: 'Usa la dirección donde vives. Debe coincidir con tu identificación para la verificación de identidad.',
        line1: 'Dirección',
        line2: 'Apto, suite, unidad (opcional)',
        city: 'Ciudad',
        state: 'Estado',
        statePh: 'Selecciona el estado',
        zip: 'Código postal (ZIP)',
      },
      cta: 'Continuar',
      saving: 'Guardando…',
      error: 'No pudimos guardar tu información. Inténtalo de nuevo.',
    },
    // NEEDS LEGAL REVIEW (EN + ES): texto de la página de consentimiento —
    // las dos casillas son lenguaje de asentimiento legalmente operativo
    // (E-SIGN y contrato TOS/Privacidad); provisional hasta la revisión de
    // abogados en K7, junto con los documentos que referencia.
    consent: {
      title: 'Revisa y acepta',
      sub: 'Antes de continuar, revisa y acepta lo siguiente.',
      esign: {
        pre: 'Acepto recibir electrónicamente todos los acuerdos, avisos, recibos y demás documentos de Puente, como se describe en el ',
        link: 'Consentimiento para Documentos Electrónicos (E-SIGN)',
        post: '.',
      },
      policies: {
        pre: 'He leído y acepto los ',
        termsLink: 'Términos de Servicio',
        and: ' y el ',
        privacyLink: 'Aviso de Privacidad',
        post: ' de Puente.',
      },
      providers: {
        intro:
          'Puente trabaja con socios con licencia para mover tu dinero: Stripe (pagos) y Bridge (transmisión de dinero). Sus términos aplican cuando usas esos servicios y se presentan en sus propias pantallas.',
        stripeLink: 'Términos legales de Stripe',
        bridgeLink: 'Términos legales de Bridge',
      },
      cta: 'Aceptar y continuar',
      saving: 'Guardando…',
      error: 'No pudimos guardar tu aceptación. Inténtalo de nuevo.',
      stale: 'Esta página no está actualizada. Recárgala e inténtalo de nuevo.',
    },
    // NEEDS LEGAL REVIEW (ES): texto sobre el requisito de verificación de identidad
    kyc: {
      title: 'Verifica tu identidad',
      body: 'La ley federal nos exige verificar tu identidad antes de que puedas enviar dinero. Nuestro socio seguro Bridge se encarga de esto. Toma unos 2 minutos. Ten tu identificación a la mano.',
      // NEEDS LEGAL REVIEW (EN + ES): aviso de compartición de datos (GLBA)
      dataNotice:
        'Al continuar, compartiremos tu nombre y correo electrónico con Bridge (bridge.xyz), un transmisor de dinero con licencia que verifica tu identidad y procesa las transferencias. Bridge te pedirá el resto (fecha de nacimiento, dirección, SSN o ITIN y una foto de tu identificación) directamente a ti.',
      cta: 'Verificar mi identidad',
      starting: 'Iniciando…',
      error: 'No pudimos iniciar la verificación. Inténtalo de nuevo.',
    },
    pending: {
      title: 'Estamos verificando tu identidad',
      body: 'Normalmente toma unos minutos, pero puede tardar hasta 1 día hábil.',
      autoNote: 'Esta página se actualiza automáticamente, no necesitas recargarla.',
    },
    // NEEDS LEGAL REVIEW (EN + ES): resultado de verificación de identidad.
    // Nunca debe leerse como una denegación de crédito o de cuenta — trata
    // estrictamente de la verificación de identidad.
    // Las razones de Bridge llegan en inglés y se muestran tal cual.
    rejected: {
      title: 'No pudimos verificar tu identidad',
      body: 'Parte de la información o los documentos que proporcionaste no se pudieron confirmar. Puedes intentarlo de nuevo. Solo toma unos minutos.',
      reasonLabel: 'Qué pasó (detalle del proveedor de verificación, en inglés):',
      retryCta: 'Intentar de nuevo',
      retrying: 'Iniciando…',
      retryError: 'No pudimos reiniciar la verificación. Inténtalo de nuevo.',
      exhaustedBody:
        'No pudimos verificar tu identidad después de varios intentos. Contáctanos y te ayudaremos a resolverlo.',
      supportCta: 'Contactar soporte',
    },
    dashboard: {
      title: 'Estás verificado',
      readyTitle: 'Todo listo',
      body: 'Muy pronto podrás enviar dinero. Te avisaremos en cuanto esté disponible.',
      recipientsCta: 'Administrar destinatarios',
      historyCta: 'Historial de transferencias',
    },
  },
  dashNav: {
    send: 'Enviar dinero',
    transfers: 'Transferencias',
    recipients: 'Destinatarios',
  },
  recipients: {
    title: 'Tus destinatarios',
    sub: 'Las personas a quienes envías dinero, y dónde les llega.',
    empty:
      'Aún no tienes destinatarios. Agrega a la primera persona a la que quieras enviar dinero.',
    addRecipient: 'Agregar destinatario',
    firstName: 'Nombre(s)',
    lastName: 'Apellidos',
    lastNameNote: 'Incluye ambos apellidos tal como aparecen en su cuenta bancaria.',
    relationship: 'Parentesco',
    relationshipPh: 'Mamá, hermano, amiga…',
    country: 'País',
    countryMx: 'México',
    save: 'Guardar',
    saving: 'Guardando…',
    cancel: 'Cancelar',
    addAccount: 'Agregar cuenta bancaria',
    bankAccount: 'Cuenta bancaria',
    label: 'Alias (opcional)',
    labelPh: 'Cuenta BBVA',
    clabe: 'CLABE (18 dígitos)',
    clabeConfirm: 'Confirma la CLABE',
    clabeNote:
      'Pídele a tu destinatario su CLABE de 18 dígitos. El dinero enviado a una cuenta equivocada pero válida no se puede recuperar.',
    clabeMismatch: 'Las CLABE no coinciden.',
    accountEnding: '····{last4}',
    archive: 'Archivar',
    confirmArchive: 'Toca de nuevo para confirmar',
    archived: 'Archivado',
    archiveFailed: 'No se pudo archivar. Intenta de nuevo',
    errors: {
      invalidClabe: 'Esa CLABE no parece correcta. Revisa el número de 18 dígitos.',
      bankRejected: 'El banco rechazó esta cuenta. Verifica la CLABE con tu destinatario.',
      alreadySaved: 'Esta cuenta ya está guardada.',
      providerDown: 'No pudimos conectar con nuestro proveedor de pagos. Inténtalo en un momento.',
      generic: 'Algo salió mal. Inténtalo de nuevo.',
    },
  },
  send: {
    cta: 'Enviar dinero',
    title: 'Enviar dinero',
    sub: 'Elige a quién pagar y cuánto. Te mostramos el tipo de cambio antes de enviar nada.',
    dashboardReady: 'Envía dinero a tus destinatarios, o administra a quién le envías.',
    limitsBanner: {
      title: 'Verificación rápida al pagar',
      body: 'Verificarás tu identidad al momento de pagar, aquí mismo en esta página. Normalmente toma menos de un minuto.',
      limitLine: (max: string) =>
        `Las transferencias de más de ${max} también pueden requerir una identificación con foto.`,
    },
    recipient: 'Destinatario',
    recipientPh: 'Elige un destinatario',
    account: 'Cuenta',
    accountPh: 'Elige una cuenta',
    noRecipients: 'Aún no tienes destinatarios.',
    manageRecipients: 'Agregar un destinatario',
    amount: 'Monto a enviar (USD)',
    amountPh: '0.00',
    getQuote: 'Obtener cotización',
    quoting: 'Obteniendo tu tipo de cambio…',
    youPay: 'Tú pagas',
    fee: 'Comisión',
    theyReceive: 'Ellos reciben',
    rate: 'Tipo de cambio',
    rateValue: '1 USD = {rate} MXN',
    expiresIn: 'Tipo de cambio fijo por {time}',
    expiredNotice: 'Este tipo de cambio expiró. Obtén una nueva cotización para continuar.',
    newQuote: 'Nueva cotización',
    continue: 'Continuar',
    review: {
      title: 'Revisa y confirma',
      sub: 'Lee la divulgación abajo y confirma para enviar tu dinero.',
      accept: 'He leído y acepto esta divulgación.',
      confirm: 'Confirmar transferencia',
      confirming: 'Confirmando…',
      back: 'Atrás',
      confirmedTitle: 'Transferencia confirmada',
      confirmedBody: 'Tu transferencia está confirmada y esperando el pago.',
      loading: 'Cargando la divulgación…',
      loadError: 'No pudimos cargar la divulgación. Inténtalo de nuevo o regresa.',
      retry: 'Reintentar',
    },
    track: {
      title: 'Tu transferencia',
      youSend: 'Tú envías',
      theyReceive: 'Ellos reciben',
      steps: {
        PENDING_PAYMENT: 'Esperando el pago',
        FUNDED: 'Pago recibido',
        // PR7: ver nota en la versión en inglés. NEEDS LEGAL REVIEW (ES).
        SUBMITTED: 'Enviando',
        IN_FLIGHT: 'En camino',
        COMPLETED: 'Entregada',
      },
      cancelWindow: 'Te quedan {time} para cancelar esta transferencia.',
      // NEEDS LEGAL REVIEW (ES) — PR7, mirrors en.
      cancelWindowNote:
        'Una vez que comenzamos a enviarla, la cancelación no es automática. Comunícate con nosotros y lo resolvemos.',
      cancel: 'Cancelar transferencia',
      cancelConfirm: 'Toca de nuevo para cancelar',
      canceling: 'Cancelando…',
      simulate: 'Simular pago',
      simulating: 'Simulando…',
      simulateNote: 'Solo en el entorno de pruebas, sustituye el pago con tarjeta o banco.',
      // NEEDS LEGAL REVIEW (ES)
      pay: {
        payTitle: 'Paga con tu banco',
        payNow: 'Pagar {amount}',
        paying: 'Enviando el pago…',
        // NO "pagado": el cargo ACH fue enviado, la liquidación tarda días.
        submittedTitle: 'Pago enviado',
        submittedBody: 'Estamos confirmando tu pago con tu banco. Esto suele tomar un momento.',
        sessionError: 'No pudimos cargar el formulario de pago. Inténtalo de nuevo.',
        bankNote:
          'Si no ves tu banco, aún no podemos aceptar pagos desde ese banco. No se te ha cobrado.',
        paymentError: 'Algo salió mal con tu pago. Inténtalo de nuevo.',
        onrampTitle: 'Paga con tarjeta o banco',
        onrampBody:
          'Completa tu pago de forma segura con Stripe. Stripe verificará tu identidad y te mostrará su comisión de procesamiento antes de confirmar.',
        offlineTitle: 'Esperando tu depósito',
        offlineBody:
          'Envía tu pago con las instrucciones de depósito que te compartió nuestro equipo, incluyendo el código de referencia. Esta transferencia avanza en cuanto confirmemos que el dinero llegó.',
        offlineInstructions: {
          lead: 'Envía tu depósito a esta cuenta. Esta transferencia avanza en cuanto confirmemos que el dinero llegó.',
          bank: 'Banco',
          routing: 'Número de ruta (routing)',
          account: 'Número de cuenta',
          beneficiary: 'Nombre de la cuenta',
          reference: 'Código de referencia',
          amount: 'Monto a enviar',
          referenceWarning:
            'Incluye el código de referencia con tu pago. Sin él, no podemos vincular tu depósito con esta transferencia.',
        },
        claim: {
          button: 'Ya envié el pago',
          claiming: 'Registrando…',
          claimedTitle: 'Gracias, tomamos nota de tu pago',
          claimedBody:
            'Liberaremos tu transferencia en cuanto confirmemos que el pago va en camino. Esta página se actualizará cuando avance.',
          error: 'No pudimos registrarlo en este momento. Inténtalo de nuevo.',
        },
      },
      crypto: {
        intro: {
          title: 'Verifica y paga',
          // NEEDS LEGAL REVIEW (EN + ES)
          expectation:
            'Los pagos son procesados por Stripe y su servicio Link, que convierten tus dólares a USDC, un dólar digital, para entregar tu transferencia. Es posible que recibas correos de confirmación de Stripe y de Link.',
          // NEEDS LEGAL REVIEW (EN + ES)
          methodsNote:
            'Puedes pagar con tarjeta de débito o con tu cuenta bancaria. Las tarjetas de crédito también funcionan, pero algunos emisores tratan este tipo de pago como adelanto de efectivo y cobran sus propias comisiones.',
          continueCta: 'Continuar',
        },
        link: {
          starting: 'Conectando…',
          registering: 'Preparando tu cuenta segura…',
          modalHint: 'Verifica con el código que llegó a tu teléfono.',
          abandonedTitle: 'Verificación sin terminar',
          abandonedBody:
            'No hay problema, no se hizo ningún cargo. Continúa donde quedaste cuando estés listo.',
          resumeCta: 'Seguir verificando',
          declined:
            'Para enviar dinero, necesitas permitir la conexión con Link. No se hizo ningún cargo. Puedes intentarlo de nuevo cuando quieras.',
          reauthNote: 'Tu sesión segura expiró. Verifica con Link de nuevo.',
        },
        kyc: {
          formTitle: 'Verifica tu identidad',
          formTitleStepUp: 'Unos datos más',
          sub: 'La ley federal nos exige verificar quién envía dinero. Normalmente toma unos segundos.',
          firstName: 'Nombre legal',
          lastName: 'Apellido legal',
          addressLine1: 'Dirección',
          addressLine2: 'Apto, interior, unidad (opcional)',
          city: 'Ciudad',
          state: 'Estado',
          postalCode: 'Código postal (ZIP)',
          dobLegend: 'Fecha de nacimiento',
          dobMonth: 'Mes',
          dobDay: 'Día',
          dobYear: 'Año',
          ssn: 'Número de Seguro Social (SSN)',
          // NEEDS LEGAL REVIEW (EN + ES)
          ssnPrivacyNote:
            'Tu SSN y tu fecha de nacimiento van directamente a Stripe para verificar tu identidad. Puente nunca los recibe ni los guarda.',
          submitCta: 'Verificar mi identidad',
          submitting: 'Enviando…',
          verifying: 'Verificando tu identidad…',
          verifyTimeout: 'Está tardando más de lo normal. Seguimos verificando.',
          retryCta: 'Revisar de nuevo',
          rejectedTitle: 'No pudimos verificar tu identidad',
          // NEEDS LEGAL REVIEW (EN + ES)
          rejectedBody:
            'Esta transferencia no puede continuar y no se te hizo ningún cargo. Escríbenos a support@puentefinancial.com y te ayudamos a resolverlo.',
          docsTitle: 'Verifica con una identificación',
          docsBody:
            'Stripe te pedirá subir un documento de identidad y tomarte una selfie. Normalmente toma menos de un minuto.',
          docsCta: 'Iniciar verificación de identificación',
          docsAbandoned:
            'La verificación de identificación se cerró antes de terminar. Puedes iniciarla de nuevo.',
          achRequiresDocs:
            'Para pagar desde tu cuenta bancaria, primero necesitas verificar una identificación.',
        },
        bridge: {
          title: 'Un paso más de verificación',
          // NEEDS LEGAL REVIEW (EN + ES) — ver la nota en la versión en inglés.
          body: 'Bridge (bridge.xyz), el transmisor de dinero con licencia que entrega tu dinero, también necesita verificar tu identidad. Lo completarás en la página segura de Bridge y volverás aquí.',
          tosCta: 'Continuar verificación',
          waitingTitle: 'Terminando la verificación',
          waitingBody:
            'Estamos esperando que Bridge confirme tu verificación. Esta página se actualizará en cuanto termine.',
        },
        collect: {
          title: 'Elige cómo pagar',
          debitNote: 'El débito suele ser la opción más económica.',
        },
        pay: {
          creatingSession: 'Preparando tu pago…',
          startingCheckout: 'Terminando tu pago…',
        },
        errors: {
          restartPayment:
            'Ese intento de pago expiró, así que no se hizo ningún cargo. Elige cómo pagar para intentarlo de nuevo.',
          retryCta: 'Intentar de nuevo',
        },
      },
      loadError: 'No pudimos cargar esta transferencia. Inténtalo de nuevo.',
      retry: 'Reintentar',
      done: 'Volver al panel',
      viewReceipt: 'Ver recibo',
      supportCta: 'Comunícate con soporte',
      cancellationRequested: {
        title: 'Cancelación solicitada',
        body: 'Recibimos tu solicitud para cancelar esta transferencia. Ya iba en camino, así que la estamos gestionando; esta página se actualizará cuando se resuelva.',
      },
      outcomes: {
        completed: {
          title: 'Entregada',
          body: 'Tu dinero llegó a la cuenta de tu destinatario.',
        },
        canceled: {
          title: 'Cancelada',
          // NEEDS LEGAL REVIEW (ES) — PR7 truthfulness pass, mirrors en.
          // NO "ya fue emitido": esta ahora es también la etapa de un reembolso
          // que aún requiere que una persona devuelva el dinero.
          body: 'Esta transferencia fue cancelada. Tu reembolso completo, incluida la comisión, está en camino; según tu banco, puede tardar unos días hábiles en aparecer.',
        },
        refunded: {
          title: 'Reembolsada',
          // NEEDS LEGAL REVIEW (ES) — PR7 truthfulness pass, mirrors en.
          body: 'Tu reembolso completo por esta transferencia, incluida la comisión, ya fue emitido. Según tu banco, puede tardar unos días hábiles en aparecer.',
        },
        paymentFailed: {
          title: 'El pago falló',
          // NEEDS LEGAL REVIEW (ES) — PR7 truthfulness pass, mirrors en.
          body: 'No pudimos confirmar tu pago, así que esta transferencia no se envió. Si tu banco muestra un cargo por ella, escríbenos a support@puentefinancial.com y lo resolveremos. Inicia una nueva transferencia para intentarlo otra vez.',
        },
        payoutFailed: {
          title: 'No se pudo entregar',
          // NEEDS LEGAL REVIEW (ES) — PR7 truthfulness pass, mirrors en.
          body: 'El banco de tu destinatario no pudo aceptar esta transferencia, así que no se entregó nada. Recibirás un reembolso completo, incluida la comisión; esta página se actualizará cuando se haya emitido. Comunícate con soporte si tienes preguntas.',
        },
        fundingReversed: {
          title: 'Pago revertido',
          body: 'Tu banco revirtió el pago de esta transferencia. Comunícate con soporte para que lo resolvamos juntos.',
        },
        underReview: {
          title: 'Procesando tu cancelación',
          body: 'Tu transferencia se entregó y pediste cancelarla. Estamos revisando tu solicitud; esta página se actualizará cuando se resuelva.',
        },
      },
    },
    receipt: {
      title: 'Recibo de transferencia',
      viewHistory: 'Ver todas las transferencias',
    },
    history: {
      title: 'Historial de transferencias',
      empty: 'Aún no has enviado ninguna transferencia.',
      loadMore: 'Cargar más',
      loading: 'Cargando…',
      loadError: 'No pudimos cargar tus transferencias. Inténtalo de nuevo.',
      retry: 'Reintentar',
    },
    errors: {
      validation_error: 'Revisa los datos e inténtalo de nuevo.',
      unauthorized: 'Tu sesión expiró. Inicia sesión de nuevo.',
      forbidden: 'No tienes acceso para hacer eso.',
      not_found: 'No encontramos eso. Actualiza e inténtalo de nuevo.',
      kyc_required: 'Necesitas verificar tu identidad antes de enviar dinero.',
      limit_exceeded:
        'Esto supera tu límite de envío por ahora. Prueba con un monto menor o vuelve más tarde.',
      transfer_in_progress:
        'Ya tienes una transferencia en curso. Podrás enviar otra cuando se procese tu pago, normalmente en unos días hábiles.',
      quote_expired: 'Este tipo de cambio expiró. Obtén una nueva cotización para continuar.',
      transfer_not_cancelable: 'Esta transferencia ya no se puede cancelar.',
      conflict: 'Esto no se puede actualizar ahora. Actualiza e inténtalo de nuevo.',
      idempotency_conflict:
        'Todavía estamos procesando tu solicitud anterior. Espera un momento antes de intentar de nuevo.',
      link_auth_required: 'Verifica con Link de nuevo para continuar.',
      not_configured: 'Enviar dinero aún no está disponible. Te avisaremos en cuanto esté listo.',
      funding_unsupported:
        'Nuestro proveedor de pagos no puede aceptar pagos desde tu ubicación por ahora, así que esta transferencia no se puede completar. No se te ha cobrado.',
      rate_limited: 'Demasiados intentos. Espera un momento e inténtalo de nuevo.',
      rate_unavailable: 'No pudimos obtener el tipo de cambio ahora. Inténtalo en un momento.',
      provider_rejected:
        'Nuestro socio de pagos no pudo aceptar esto. Revisa los datos de la cuenta del destinatario.',
      provider_unavailable:
        'No pudimos conectar con nuestro socio de pagos. Inténtalo en un momento.',
      internal_error: 'Algo salió mal de nuestro lado. Inténtalo de nuevo.',
      cancellation_requires_support: 'Comunícate con soporte para cancelar esta transferencia.',
      generic: 'Algo salió mal. Inténtalo de nuevo.',
    },
  },
  /* eslint-disable no-restricted-syntax -- operator jargon, not consumer copy; the em dash ban covers customer-facing strings only. */
  ops: {
    title: 'Panel de operaciones',
    generatedAt: 'Generado',
    loadFailed: 'No pudimos cargar el panel de operaciones.',
    retry: 'Reintentar',
    needsYou: 'Requiere tu atenci\u00f3n',
    stateOfWorld: 'Estado general',
    pendingCancellations: 'Solicitudes de cancelaci\u00f3n pendientes',
    pendingCancellationsEmpty: 'No hay solicitudes de cancelaci\u00f3n pendientes.',
    withinWindow: 'dentro del plazo',
    outOfWindow: 'fuera del plazo',
    actions: {
      refund: 'Reembolsar',
      settleRefund: 'Asentar reembolso',
      deny: 'Denegar',
      cancel: 'Cancelar',
      close: 'Cerrar',
      confirmRefund: 'Confirmar reembolso',
      confirmDeny: 'Confirmar denegaci\u00f3n',
      working: 'Procesando\u2026',
      amountLabel: 'Pago de correcci\u00f3n',
      requestedAtLabel: 'Solicitada',
      refundConsequence:
        'Paga al remitente este monto de nuevo como pago de correcci\u00f3n \u2014 el destinatario conserva la entrega.',
      settleNote:
        'Una ejecuci\u00f3n anterior ya desembols\u00f3 este reembolso; confirmar solo asienta el registro \u2014 no se mueve dinero.',
      denyEvidenceLabel:
        'Hora del dep\u00f3sito seg\u00fan el panel de Bridge (ISO 8601 con zona horaria)',
      denyEvidenceHint:
        'Ejemplo: 2026-08-01T15:04:05Z \u2014 la denegaci\u00f3n depende de este valor.',
      denyComparedNote:
        'Se compara contra la hora de la solicitud de arriba: deniega solo si la solicitud lleg\u00f3 DESPU\u00c9S del dep\u00f3sito.',
      denyTypoWarning:
        'Cuidado: un valor M\u00c1S TEMPRANO hace m\u00e1s probable una denegaci\u00f3n indebida. Copia el valor del panel exactamente, incluida la zona horaria.',
      denyInvalidTimestamp:
        'Ingresa una marca de tiempo ISO 8601 v\u00e1lida con zona horaria expl\u00edcita.',
      outcomes: {
        refunded: 'Reembolsado \u2014 pago de correcci\u00f3n enviado.',
        denied: 'Denegada \u2014 solicitud cerrada.',
        already_disbursed:
          'Asentado \u2014 una ejecuci\u00f3n anterior ya hab\u00eda pagado; ahora no se movi\u00f3 dinero.',
        already_refunded: 'Ya reembolsado \u2014 solicitud cerrada; ahora no se movi\u00f3 dinero.',
      },
      errors: {
        claim_abandoned:
          'PELIGRO: una ejecuci\u00f3n anterior abandon\u00f3 su claim de reembolso y pudo haber desembolsado sin registrarlo. NO reintentes \u2014 sigue runbooks/manual-refund.md (claims abandonados).',
        refund_owed:
          'La solicitud cumpli\u00f3 ambas condiciones de cancelaci\u00f3n \u2014 se debe un reembolso y ninguna herramienta puede denegarla. Reemb\u00f3lsala.',
        evidence_conflict: 'La hora de dep\u00f3sito citada contradice la evidencia registrada:',
        conflict:
          'El tablero est\u00e1 desactualizado \u2014 la transferencia cambi\u00f3. Actualiza y verifica de nuevo.',
        not_found: 'Transferencia no encontrada \u2014 actualiza el tablero.',
        validation: 'La solicitud fue rechazada como inv\u00e1lida \u2014 revisa los datos.',
        generic:
          'La acci\u00f3n fall\u00f3. Nada cambi\u00f3 silenciosamente \u2014 actualiza y verifica la fila antes de reintentar.',
      },
      transfer: {
        attach: 'Adjuntar instrucciones',
        release: 'Liberar pago',
        depositLanded: 'Dep\u00f3sito recibido',
        confirmAttach: 'Confirmar adjuntar',
        confirmRelease: 'Confirmar liberaci\u00f3n',
        confirmDepositLanded: 'Confirmar dep\u00f3sito recibido',
        totalLabel: 'Total de la transferencia',
        onrampIdLabel: 'Id del onramp de Bridge',
        onrampIdInvalid:
          'Ingresa el id del onramp como UUID \u2014 es la transferencia del lado del dep\u00f3sito, NO el id del payout.',
        refLabel: 'Referencia del dep\u00f3sito (id del onramp de Bridge)',
        refRequired:
          'La referencia es obligatoria \u2014 es el v\u00ednculo de auditor\u00eda con el dinero que se movi\u00f3.',
        attachNote:
          'Toma las coordenadas de dep\u00f3sito del onramp y las muestra en el paso de pago del remitente. Re-adjuntar sobrescribe.',
        releaseConsequence:
          'Libera el pago AHORA contra el float de tesorer\u00eda por este monto \u2014 libera solo con evidencia de que el ACH del remitente fue iniciado.',
        depositLandedConsequence:
          'Registra LLEGADA, no intenci\u00f3n: liquida la cuenta por cobrar y repone el float. Ejecuta cuando el saldo de la billetera realmente cambi\u00f3. Volver a tocar es seguro.',
        outcomes: {
          funded: 'Liberado \u2014 el worker env\u00eda el payout en aproximadamente un minuto.',
          cleared: 'Dep\u00f3sito registrado \u2014 cuenta por cobrar liquidada y float repuesto.',
          cleared_skipped:
            'Ya registrado \u2014 la reposici\u00f3n se re-public\u00f3 como no-op; nada se cont\u00f3 doble.',
          attached:
            'Instrucciones adjuntadas \u2014 el paso de pago del remitente ya muestra las coordenadas.',
        },
      },
    },
    topUp: {
      title: 'Registrar reposici\u00f3n de float',
      amountLabel: 'Monto agregado a la billetera de tesorer\u00eda (USD)',
      amountInvalid: 'Ingresa d\u00f3lares como 100 o 100.00.',
      refLabel: 'Referencia (opcional \u2014 el id de la transacci\u00f3n de Bridge si lo tienes)',
      refHint:
        'Misma referencia = se registra una sola vez; reenviar es un no-op. En blanco, este registro recibe su propia referencia \u00fanica.',
      prefundNote:
        'Para fondeo out-of-band de la billetera (prefondos), DESPU\u00c9S de que el saldo realmente cambi\u00f3 \u2014 el libro registra llegada, no intenci\u00f3n. Si este dep\u00f3sito pertenece a una transferencia, usa Dep\u00f3sito recibido en su fila; registrarlo aqu\u00ed tambi\u00e9n sobreestimar\u00eda el float.',
      confirm: 'Confirmar reposici\u00f3n',
      booked: (balance: string) => `Registrado \u2014 bridge_wallet_float ahora es ${balance}.`,
    },
    refundMoving: 'reembolso en curso',
    openTransfers: 'Transferencias abiertas',
    openTransfersEmpty: 'No hay transferencias abiertas.',
    openTransfersNote:
      'Superar el umbral es un indicador, no un veredicto \u2014 revisa las anotaciones de espera; las alertas de Sentry deciden qu\u00e9 est\u00e1 atascado.',
    dwell: 'Tiempo en estado',
    threshold: 'Umbral',
    holdLabel: 'Retenci\u00f3n',
    holdReasons: {
      fx_drift: 'Deriva de tipo de cambio',
      payability: 'Cuenta no pagable',
      submit_error: 'Error de env\u00edo',
      velocity_review: 'Revisi\u00f3n de velocidad',
    },
    waitClaimed: 'reclamada (recuperaci\u00f3n tras fallo)',
    waitUncleared: 'esperando liquidaci\u00f3n ACH',
    waitCancelRequested: 'cancelaci\u00f3n solicitada',
    waitNoInstructions: 'sin instrucciones de dep\u00f3sito adjuntas',
    waitSenderClaimed: 'el remitente dice que envi\u00f3 el pago \u2014 verifica y libera',
    floatCeiling: 'Techo de flotaci\u00f3n',
    floatNotConfigured: 'El techo de flotaci\u00f3n no est\u00e1 configurado en este entorno.',
    floatTripped: 'Techo de flotaci\u00f3n alcanzado \u2014 env\u00edo de pagos en pausa',
    floatOk: 'Bajo el techo',
    floatBalance: 'Adelantado (cuentas por cobrar)',
    floatCeilingValue: 'Techo',
    latestFindings: '\u00daltimos hallazgos de conciliaci\u00f3n',
    findingsEmpty: 'A\u00fan no hay corridas de conciliaci\u00f3n.',
    findingsNone: 'La \u00faltima corrida sali\u00f3 limpia.',
    checksSkipped: 'verificaciones omitidas (no ejecutadas)',
    checkError: 'verificaci\u00f3n fallida',
    transferCounts: 'Transferencias por estado',
    transferCountsEmpty: 'A\u00fan no hay transferencias.',
    ledgerBalances: 'Saldos del libro contable',
    ledgerBalancesAsOf: 'al cierre de la \u00faltima conciliaci\u00f3n',
    ledgerBalancesEmpty:
      'A\u00fan no hay corridas de conciliaci\u00f3n \u2014 los saldos aparecen tras la primera.',
    reconRuns: 'Corridas de conciliaci\u00f3n',
    reconRunsEmpty: 'A\u00fan no hay corridas registradas.',
    reconStatus: { pass: 'limpia', findings: 'hallazgos', error: 'error' },
    findingsCount: 'hallazgos',
    workerHeartbeat: 'Latido del worker',
    workerHeartbeatEmpty: 'A\u00fan no se registra ning\u00fan latido.',
    heartbeatLive: 'activo',
    heartbeatStale: 'sin latido hace 15+ min',
    heartbeatDead:
      'El latido del worker se detuvo \u2014 es probable que los trabajos programados no se est\u00e9n ejecutando',
  },
  /* eslint-enable no-restricted-syntax */
  mobile: {
    connection: {
      error: 'No pudimos conectar con Puente. Revisa tu conexi\u00f3n e int\u00e9ntalo de nuevo.',
      retry: 'Intentar de nuevo',
    },
    signOut: 'Cerrar sesi\u00f3n',
  },
}

export const translations: Record<Lang, Translations> = { en, es }
