export type Lang = 'en' | 'es'

export type Translations = {
  announce: { pre: string; link: string }
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
    greeting: string; name: string
    scoreLabel: string; delta: string
    remitLabel: string; remitNote: string
    reported: string; onTime: string
    sends: { who: string; amt: string }[]
    cta: string
  }
  remit: {
    eyebrow: string
    h2: string
    sub: string
    calc: {
      to: string
      you: string; they: string
      rate: string
      note: string; cta: string
    }
  }
  how: {
    eyebrow: string
    h2: [string, string][]
    sub: string
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
    sub: [string, string, string]
    subFine: string
    cta: string
    points: string[]
    f: { name: string; phone: string; country: string; referralSource: string; referralSourceOther: string }
    referralSourceOptions: string[]
    countries: string[]
    ph: { name: string; phone: string; referralSourceOther: string }
    select: string
    submit: string
    fine: string
    success: {
      title: string; body: string; refLabel: string
      copy: string; copied: string; wa: string; waText: string
    }
    steps: { h: string }[]
    next: string
    back: string
  }
  footer: { tagline: string; privacyLink: string; termsLink: string; disclaimer: [string, string]; disclaimer2: string; rights: string; note: string }
  onboarding: {
    signup: { title: string; sub: string; phone: string; phonePh: string; smsConsent: string; cta: string; sending: string; error: string }
    verify: { title: string; sub: string; code: string; cta: string; verifying: string; resend: string; resent: string; error: string }
    profile: { title: string; sub: string; firstName: string; lastName: string; email: string; emailNote: string; cta: string; saving: string; error: string }
    kyc: { title: string; body: string; dataNotice: string; cta: string; starting: string; error: string }
    pending: { title: string; body: string; autoNote: string }
    rejected: {
      title: string; body: string; reasonLabel: string
      retryCta: string; retrying: string; retryError: string
      exhaustedBody: string; supportCta: string
    }
    dashboard: { title: string; body: string; recipientsCta: string }
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
    // code → user-facing message; the apiError layer maps the API error
    // envelope's stable `code` onto these (unmapped codes fall back to generic)
    errors: {
      validation_error: string
      unauthorized: string
      forbidden: string
      not_found: string
      kyc_required: string
      limit_exceeded: string
      quote_expired: string
      transfer_not_cancelable: string
      conflict: string
      idempotency_conflict: string
      not_configured: string
      rate_limited: string
      rate_unavailable: string
      provider_rejected: string
      provider_unavailable: string
      internal_error: string
      cancellation_requires_support: string
      generic: string
    }
  }
}

const en: Translations = {
  announce: { pre: 'Join before August 31 - no transfer fees for your first 6 months.', link: 'join the waitlist' },
  nav: { remit: 'Remittances', how: 'How it works', cta: 'Join the Waitlist', signIn: 'Sign in' },
  hero: {
    eyebrow: 'Remittances + credit building',
    h1: [['Send', 'money.'], ['Build', 'credit.']],
    sub: 'Send money the way you already do, and build real U.S. credit with every transfer. All in one app.',
    cta1: 'Join the Waitlist',
    cta2: 'See how it works',
    elig: 'Works with your ITIN or SSN.',
    pills: ['Reports to all 3 credit bureaus', 'Set up in minutes', 'No credit card needed'],
    notes: ['Real exchange rate', 'Built for newcomers'],
  },
  phone: {
    greeting: 'Hi,', name: 'María',
    scoreLabel: 'Your credit score', delta: '▲ +132',
    remitLabel: 'Your remittances', remitNote: 'Each one counts ↑',
    reported: 'Reported on time · bureau', onTime: '✓ on time',
    sends: [{ who: 'To Rosa Santos', amt: '−$200' }, { who: 'To Miguel Ángel', amt: '−$150' }],
    cta: 'Send money',
  },
  remit: {
    eyebrow: 'Remittances',
    h2: 'Money home, the moment you tap send.',
    sub: 'Secure international transfers in minutes. Every time you send using your Puente account, your U.S. credit history grows.',
    calc: {
      to: 'Sending to',
      you: 'You send', they: 'They receive',
      rate: '1 USD = 17.20 MXN',
      note: 'Claim no transfer fees for your first 6 months',
      cta: 'Sign Up',
    },
  },
  how: {
    eyebrow: 'How it works',
    h2: [['Build credit ', 'without thinking about it.']],
    sub: 'Send money and watch your credit score grow. For only $5/month, each payment builds your U.S. credit history, automatically. No credit card required.',
    steps: [
      { t: 'Send money home', d: 'Send like you always do. Transparent pricing. International transfers in minutes.' },
      { t: 'We report your on-time payments', d: 'Puente reports payments on your account to the 3 major U.S. credit bureaus.' },
      { t: 'Your credit history grows', d: 'Monitor your credit score growth in real time, all from the app. No credit card or confusing terms. Just credit building.' },
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
    sub: ['Join the waitlist today, and lock in ', 'no transfer fees for your first 6 months', ' on a Puente credit building account.'],
    subFine: 'Offer ends August 31, 2026',
    cta: 'Join the Waitlist',
    points: ['Get more out of your remittances', 'Start building U.S. credit from your first transfer', 'Build a better financial future'],
    f: { name: 'Name', phone: 'Phone number or WhatsApp', country: 'Where do you send money?', referralSource: 'How did you hear about us?', referralSourceOther: 'Please specify' },
    referralSourceOptions: ['Facebook', 'Instagram', 'Friend or Family', 'Google Search', 'In Person', 'Physical Advertisement', 'Other'],
    countries: ['Mexico', 'Other'],
    ph: { name: 'María Santos', phone: '(555) 123-4567', referralSourceOther: 'Tell us more' },
    select: 'Select…',
    submit: 'Join the waitlist',
    fine: 'Puente is in early validation and not yet available. Joining adds you to the early-access list.',
    success: {
      title: "You're on the list!",
      body: "We'll reach out the moment Puente is ready. Want to move up the line?",
      refLabel: 'Share your invite link and skip ahead',
      copy: 'Copy', copied: 'Copied!',
      wa: 'Share on WhatsApp',
      waText: 'I just joined the Puente waitlist — send money home and build credit. Join me:',
    },
    steps: [
      { h: 'Tell us about yourself' },
      { h: 'Just a couple more questions' },
    ],
    next: 'Next',
    back: 'Back',
  },
  footer: {
    tagline: 'Send money.\nBuild credit.',
    privacyLink: 'Privacy Policy',
    termsLink: 'Terms of Service',
    disclaimer: ['Puente Financial, Inc. ("Puente") is a financial technology company, not a bank. Money remittance, payment, and banking services are provided by our partner U.S.-licensed financial institutions. Puente is an authorized agent of Bridge Building Inc (NMLS # 2450917). For US state licensing information, please see: ', '.'],
    disclaimer2: 'In the United States, Puente is registered with the U.S. Department of the Treasury Financial Crimes Enforcement Network (FinCEN) as a Money Services Business (BSA ID: 31000334222151).',
    rights: '© 2026 Puente Financial, Inc. All rights reserved.',
    note: 'Concept in validation — not yet available.',
  },
  onboarding: {
    signup: {
      // Single door: this flow signs in returning users too — the copy
      // must not tell them they're creating an account
      title: 'Sign in or create your account',
      sub: 'Enter your mobile number and we’ll text you a verification code.',
      phone: 'Mobile number',
      phonePh: '(555) 555-5555',
      // NEEDS LEGAL REVIEW (EN + ES): TCPA consent language
      smsConsent:
        'I agree to receive automated text messages from Puente Financial at this number, including verification codes and account notices. Message and data rates may apply. Consent is not a condition of using Puente.',
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
      resent: 'Code sent again',
      error: 'That code didn’t work. Try again or resend it.',
    },
    profile: {
      title: 'Tell us about you',
      sub: 'Use your legal name — it must match your ID for identity verification.',
      firstName: 'First name',
      lastName: 'Last name',
      email: 'Email',
      emailNote: 'We’ll send you a verification email — you can keep going in the meantime.',
      cta: 'Continue',
      saving: 'Saving…',
      error: 'We couldn’t save your info. Please try again.',
    },
    // NEEDS LEGAL REVIEW (ES): identity-verification requirement wording
    kyc: {
      title: 'Verify your identity',
      body: 'Federal law requires us to verify your identity before you can send money. Our secure partner Bridge handles this — it takes about 2 minutes. Have your ID handy.',
      // NEEDS LEGAL REVIEW (EN + ES): GLBA data-sharing disclosure
      dataNotice:
        'When you continue, we’ll share your name and email with Bridge (bridge.xyz), a licensed money transmitter that verifies your identity and processes transfers. Bridge will collect the rest — date of birth, address, SSN or ITIN, and an ID photo — directly from you.',
      cta: 'Verify my identity',
      starting: 'Starting…',
      error: 'We couldn’t start verification. Please try again.',
    },
    pending: {
      title: 'Your identity is being verified',
      body: 'This usually takes a few minutes but can take up to 1 business day.',
      autoNote: 'This page updates automatically — no need to refresh.',
    },
    // NEEDS LEGAL REVIEW (EN + ES): identity-verification outcome wording.
    // Must never read as a credit or account denial (no adverse-action
    // implication) — this is strictly about identity verification.
    // reasonLabel prefixes Bridge's reason strings, which arrive in English.
    rejected: {
      title: 'We couldn’t verify your identity',
      body: 'Some of the information or documents you provided couldn’t be confirmed. You can try again — it only takes a few minutes.',
      reasonLabel: 'What happened:',
      retryCta: 'Try again',
      retrying: 'Starting…',
      retryError: 'We couldn’t restart verification. Please try again.',
      exhaustedBody: 'We weren’t able to verify your identity after several tries. Contact us and we’ll help you sort it out.',
      supportCta: 'Contact support',
    },
    dashboard: {
      title: 'You’re verified',
      body: 'Sending money is coming soon. We’ll let you know the moment it’s live.',
      recipientsCta: 'Manage recipients',
    },
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
    clabeNote: 'Ask your recipient for their 18-digit CLABE — money sent to a wrong but valid account number can’t be recovered.',
    clabeMismatch: 'The CLABE numbers don’t match.',
    accountEnding: '····{last4}',
    archive: 'Archive',
    confirmArchive: 'Tap again to confirm',
    archived: 'Archived',
    archiveFailed: "Couldn't archive — try again",
    errors: {
      invalidClabe: 'That CLABE doesn’t look right — check the 18-digit number.',
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
    dashboardReady: 'Send money to your recipients — or manage who you send to.',
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
    errors: {
      validation_error: 'Please check the details and try again.',
      unauthorized: 'Your session expired. Please sign in again.',
      forbidden: 'You don’t have access to do that.',
      not_found: 'We couldn’t find that. Refresh and try again.',
      kyc_required: 'You’ll need to verify your identity before sending money.',
      limit_exceeded: 'This goes over your sending limit right now. Try a smaller amount or come back later.',
      quote_expired: 'This rate expired. Get a new quote to continue.',
      transfer_not_cancelable: 'This transfer can no longer be canceled.',
      conflict: 'This can’t be updated right now. Refresh and try again.',
      idempotency_conflict: 'We’re still processing your last request. Give it a moment before trying again.',
      not_configured: 'Sending money isn’t available yet. We’ll let you know the moment it’s live.',
      rate_limited: 'Too many attempts. Please wait a moment and try again.',
      rate_unavailable: 'We couldn’t get an exchange rate right now. Try again in a moment.',
      provider_rejected: 'Our payout partner couldn’t accept this. Check the recipient’s account details.',
      provider_unavailable: 'We couldn’t reach our payout partner. Try again in a moment.',
      internal_error: 'Something went wrong on our end. Please try again.',
      cancellation_requires_support: 'Please contact support to cancel this transfer.',
      generic: 'Something went wrong. Please try again.',
    },
  },
}

const es: Translations = {
  announce: { pre: 'Únete antes del 31 de agosto - sin comisiones de transferencia durante tus primeros 6 meses.', link: 'únete a la lista de espera' },
  nav: { remit: 'Remesas', how: 'Cómo funciona', cta: 'Únete a la Lista de Espera', signIn: 'Iniciar sesión' },
  hero: {
    eyebrow: 'Remesas + historial de crédito',
    h1: [['Envía', 'dinero.'], ['Crea', 'crédito.']],
    sub: 'Envía dinero como ya lo haces, y construye crédito real en EE. UU. con cada transferencia. Todo en una sola app.',
    cta1: 'Únete a la Lista de Espera',
    cta2: 'Mira cómo funciona',
    elig: 'Funciona con tu ITIN o SSN.',
    pills: ['Reporta a los 3 burós de crédito', 'Configúralo en minutos', 'No necesitas tarjeta de crédito'],
    notes: ['Tipo de cambio real', 'Hecha para ti'],
  },
  phone: {
    greeting: 'Buenas,', name: 'María',
    scoreLabel: 'Tu puntaje de crédito', delta: '▲ +132',
    remitLabel: 'Tus remesas', remitNote: 'Cada una suma ↑',
    reported: 'Reportada a tiempo · buró', onTime: '✓ a tiempo',
    sends: [{ who: 'Para Rosa Santos', amt: '−$200' }, { who: 'Para Miguel Ángel', amt: '−$150' }],
    cta: 'Enviar dinero',
  },
  remit: {
    eyebrow: 'Remesas',
    h2: 'Dinero a casa, en el momento en que tocas enviar.',
    sub: 'Transferencias internacionales seguras en minutos. Cada vez que envías usando tu cuenta de Puente, tu historial crediticio en EE. UU. crece.',
    calc: {
      to: 'Enviar a',
      you: 'Tú envías', they: 'Ellos reciben',
      rate: '1 USD = 17.20 MXN',
      note: 'Reclama 6 meses sin comisión de transferencia',
      cta: 'Regístrate',
    },
  },
  how: {
    eyebrow: 'Cómo funciona',
    h2: [['Crea crédito ', 'sin siquiera pensarlo.']],
    sub: 'Envía dinero y mira crecer tu puntaje de crédito. Por solo $5/mes, cada pago construye tu historial crediticio en EE. UU., automáticamente. No requiere tarjeta de crédito.',
    steps: [
      { t: 'Envía dinero a casa', d: 'Envía como siempre. Precios transparentes. Transferencias internacionales en minutos.' },
      { t: 'Reportamos tus pagos a tiempo', d: 'Puente reporta los pagos de tu cuenta a los 3 principales burós de crédito de EE. UU.' },
      { t: 'Tu historial de crédito crece', d: 'Monitorea el crecimiento de tu puntaje de crédito en tiempo real, todo desde la app. Sin tarjeta de crédito ni términos confusos. Solo construcción de crédito.' },
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
    sub: ['Únete a la lista de espera hoy y asegura ', '6 meses sin comisión de transferencia', ' en tu cuenta de construcción de crédito de Puente.'],
    subFine: 'La oferta termina el 31 de agosto de 2026',
    cta: 'Únete a la Lista de Espera',
    points: ['Aprovecha más tus remesas', 'Empieza a crear crédito desde tu primera transferencia', 'Construye un mejor futuro financiero'],
    f: { name: 'Nombre', phone: 'Teléfono o WhatsApp', country: '¿A dónde envías dinero?', referralSource: '¿Cómo te enteraste de nosotros?', referralSourceOther: 'Por favor especifica' },
    referralSourceOptions: ['Facebook', 'Instagram', 'Amigo o familiar', 'Búsqueda en Google', 'En persona', 'Publicidad física', 'Otro'],
    countries: ['México', 'Otro'],
    ph: { name: 'María Santos', phone: '(555) 123-4567', referralSourceOther: 'Cuéntanos más' },
    select: 'Selecciona…',
    submit: 'Unirme a la lista',
    fine: 'Puente está en validación temprana y aún no está disponible. Al unirte entras a la lista de acceso anticipado.',
    success: {
      title: '¡Estás en la lista!',
      body: 'Te avisaremos en cuanto Puente esté listo. ¿Quieres adelantarte en la fila?',
      refLabel: 'Comparte tu enlace de invitación y avanza',
      copy: 'Copiar', copied: '¡Copiado!',
      wa: 'Compartir por WhatsApp',
      waText: 'Me uní a la lista de Puente — envía dinero a casa y crea crédito. Únete:',
    },
    steps: [
      { h: 'Cuéntanos sobre ti' },
      { h: 'Un par de preguntas más' },
    ],
    next: 'Siguiente',
    back: 'Atrás',
  },
  footer: {
    tagline: 'Envía dinero.\nCrea crédito.',
    privacyLink: 'Política de Privacidad',
    termsLink: 'Términos de Servicio',
    disclaimer: ['Puente Financial, Inc. ("Puente") es una empresa de tecnología financiera, no un banco. Los servicios de remesas, pagos y banca son proporcionados por instituciones financieras con licencia en EE. UU. asociadas a Puente. Puente es un agente autorizado de Bridge Building Inc (NMLS # 2450917). Para información sobre licencias estatales en EE. UU., consulte: ', '.'],
    disclaimer2: 'En los Estados Unidos, Puente está registrada ante la Red de Control de Delitos Financieros del Departamento del Tesoro de EE. UU. (FinCEN) como un Negocio de Servicios Monetarios (BSA ID: 31000334222151).',
    rights: '© 2026 Puente Financial, Inc. Todos los derechos reservados.',
    note: 'Concepto en validación — aún no disponible.',
  },
  onboarding: {
    signup: {
      // Puerta única: este flujo también inicia sesión para usuarios que
      // regresan — el texto no debe decirles que están creando una cuenta
      title: 'Inicia sesión o crea tu cuenta',
      sub: 'Ingresa tu número de celular y te enviaremos un código de verificación por SMS.',
      phone: 'Número de celular',
      phonePh: '(555) 555-5555',
      // NEEDS LEGAL REVIEW (EN + ES): texto de consentimiento TCPA
      smsConsent:
        'Acepto recibir mensajes de texto automatizados de Puente Financial en este número, incluidos códigos de verificación y avisos de cuenta. Pueden aplicar tarifas de mensajes y datos. El consentimiento no es una condición para usar Puente.',
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
      resent: 'Código reenviado',
      error: 'Ese código no funcionó. Inténtalo de nuevo o reenvíalo.',
    },
    profile: {
      title: 'Cuéntanos sobre ti',
      sub: 'Usa tu nombre legal — debe coincidir con tu identificación para la verificación de identidad.',
      firstName: 'Nombre',
      lastName: 'Apellido',
      email: 'Correo electrónico',
      emailNote: 'Te enviaremos un correo de verificación — puedes continuar mientras tanto.',
      cta: 'Continuar',
      saving: 'Guardando…',
      error: 'No pudimos guardar tu información. Inténtalo de nuevo.',
    },
    // NEEDS LEGAL REVIEW (ES): texto sobre el requisito de verificación de identidad
    kyc: {
      title: 'Verifica tu identidad',
      body: 'La ley federal nos exige verificar tu identidad antes de que puedas enviar dinero. Nuestro socio seguro Bridge se encarga de esto — toma unos 2 minutos. Ten tu identificación a la mano.',
      // NEEDS LEGAL REVIEW (EN + ES): aviso de compartición de datos (GLBA)
      dataNotice:
        'Al continuar, compartiremos tu nombre y correo electrónico con Bridge (bridge.xyz), un transmisor de dinero con licencia que verifica tu identidad y procesa las transferencias. Bridge te pedirá el resto — fecha de nacimiento, dirección, SSN o ITIN y una foto de tu identificación — directamente a ti.',
      cta: 'Verificar mi identidad',
      starting: 'Iniciando…',
      error: 'No pudimos iniciar la verificación. Inténtalo de nuevo.',
    },
    pending: {
      title: 'Estamos verificando tu identidad',
      body: 'Normalmente toma unos minutos, pero puede tardar hasta 1 día hábil.',
      autoNote: 'Esta página se actualiza automáticamente — no necesitas recargarla.',
    },
    // NEEDS LEGAL REVIEW (EN + ES): resultado de verificación de identidad.
    // Nunca debe leerse como una denegación de crédito o de cuenta — trata
    // estrictamente de la verificación de identidad.
    // Las razones de Bridge llegan en inglés y se muestran tal cual.
    rejected: {
      title: 'No pudimos verificar tu identidad',
      body: 'Parte de la información o los documentos que proporcionaste no se pudieron confirmar. Puedes intentarlo de nuevo — solo toma unos minutos.',
      reasonLabel: 'Qué pasó (detalle del proveedor de verificación, en inglés):',
      retryCta: 'Intentar de nuevo',
      retrying: 'Iniciando…',
      retryError: 'No pudimos reiniciar la verificación. Inténtalo de nuevo.',
      exhaustedBody: 'No pudimos verificar tu identidad después de varios intentos. Contáctanos y te ayudaremos a resolverlo.',
      supportCta: 'Contactar soporte',
    },
    dashboard: {
      title: 'Estás verificado',
      body: 'Muy pronto podrás enviar dinero. Te avisaremos en cuanto esté disponible.',
      recipientsCta: 'Administrar destinatarios',
    },
  },
  recipients: {
    title: 'Tus destinatarios',
    sub: 'Las personas a quienes envías dinero, y dónde les llega.',
    empty: 'Aún no tienes destinatarios. Agrega a la primera persona a la que quieras enviar dinero.',
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
    clabeNote: 'Pídele a tu destinatario su CLABE de 18 dígitos — el dinero enviado a una cuenta equivocada pero válida no se puede recuperar.',
    clabeMismatch: 'Las CLABE no coinciden.',
    accountEnding: '····{last4}',
    archive: 'Archivar',
    confirmArchive: 'Toca de nuevo para confirmar',
    archived: 'Archivado',
    archiveFailed: 'No se pudo archivar — intenta de nuevo',
    errors: {
      invalidClabe: 'Esa CLABE no parece correcta — revisa el número de 18 dígitos.',
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
    dashboardReady: 'Envía dinero a tus destinatarios — o administra a quién le envías.',
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
    errors: {
      validation_error: 'Revisa los datos e inténtalo de nuevo.',
      unauthorized: 'Tu sesión expiró. Inicia sesión de nuevo.',
      forbidden: 'No tienes acceso para hacer eso.',
      not_found: 'No encontramos eso. Actualiza e inténtalo de nuevo.',
      kyc_required: 'Necesitas verificar tu identidad antes de enviar dinero.',
      limit_exceeded: 'Esto supera tu límite de envío por ahora. Prueba con un monto menor o vuelve más tarde.',
      quote_expired: 'Este tipo de cambio expiró. Obtén una nueva cotización para continuar.',
      transfer_not_cancelable: 'Esta transferencia ya no se puede cancelar.',
      conflict: 'Esto no se puede actualizar ahora. Actualiza e inténtalo de nuevo.',
      idempotency_conflict: 'Todavía estamos procesando tu solicitud anterior. Espera un momento antes de intentar de nuevo.',
      not_configured: 'Enviar dinero aún no está disponible. Te avisaremos en cuanto esté listo.',
      rate_limited: 'Demasiados intentos. Espera un momento e inténtalo de nuevo.',
      rate_unavailable: 'No pudimos obtener el tipo de cambio ahora. Inténtalo en un momento.',
      provider_rejected: 'Nuestro socio de pagos no pudo aceptar esto. Revisa los datos de la cuenta del destinatario.',
      provider_unavailable: 'No pudimos conectar con nuestro socio de pagos. Inténtalo en un momento.',
      internal_error: 'Algo salió mal de nuestro lado. Inténtalo de nuevo.',
      cancellation_requires_support: 'Comunícate con soporte para cancelar esta transferencia.',
      generic: 'Algo salió mal. Inténtalo de nuevo.',
    },
  },
}

export const translations: Record<Lang, Translations> = { en, es }
