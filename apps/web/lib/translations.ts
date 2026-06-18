export type Lang = 'en' | 'es'

export type Translations = {
  announce: { pre: string; link: string }
  nav: { remit: string; how: string; cta: string }
  hero: {
    eyebrow: string
    h1: [string, string][]
    sub: string
    cta1: string
    cta2: string
    elig: string
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
      rate: string; fee: string; flat: string
      total: string; note: string; cta: string
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
    sub: string
    cta: string
    points: string[]
    f: { name: string; phone: string; email: string; country: string; amount: string; provider: string; knowsScore: string; scoreRange: string; remitFrequency: string; remitYears: string }
    scoreOptions: string[]
    remitFrequencyOptions: string[]
    remitYearsOptions: string[]
    countries: string[]
    amounts: string[]
    providers: string[]
    ph: { name: string; phone: string; email: string }
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
  footer: { tagline: string; rights: string; note: string }
}

const en: Translations = {
  announce: { pre: 'Early access is open.', link: 'Sign up' },
  nav: { remit: 'Remittances', how: 'How it works', cta: 'Sign up' },
  hero: {
    eyebrow: 'Remittances + credit building',
    h1: [['Send', 'money.'], ['Build', 'credit.']],
    sub: 'Send money home — and build your U.S. credit history with every payment you make. One app, built for newcomers.',
    cta1: 'Sign up',
    cta2: 'See how it works',
    elig: 'Works with your ITIN or SSN.',
    notes: ['$5 flat fee', 'Real exchange rate', 'Built for newcomers'],
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
    sub: 'One flat $5 fee. The real exchange rate, no markup. And every transfer you send also builds your U.S. credit history.',
    calc: {
      to: 'Sending to',
      you: 'You send', they: 'They receive',
      rate: '1 USD = 17.20 MXN', fee: 'Fee', flat: '$5.00 flat',
      total: 'Total to pay', note: 'Real mid-market rate · no markup',
      cta: 'Sign up',
    },
  },
  how: {
    eyebrow: 'How it works',
    h2: [['Build credit ', 'without thinking about it.']],
    sub: 'Sending money home is something you already do. With Puente, every on-time payment helps build your U.S. credit history — automatically.',
    steps: [
      { t: 'Send money home', d: 'Send like you always do — $5 flat, at the real exchange rate, arriving in seconds.' },
      { t: 'We report your on-time payments', d: 'Puente reports your payments to the major U.S. credit bureaus on your behalf.' },
      { t: 'Your credit history grows', d: 'On-time payments build a stronger U.S. credit profile over time — no card, no debt.' },
    ],
    privacyTitle: 'Your status stays private',
    privacy: 'We never store or report your documentation, legal, or immigration status. Your credit-building is based on your payments — nothing else.',
    eligTitle: "What you'll need",
    elig: "An ITIN or SSN and a U.S. address. That's it.",
    cta: 'Sign up',
  },
  wl: {
    eyebrow: 'Get started',
    h2: 'Sign up today',
    sub: 'Sign up and start turning your remittances into a stronger U.S. financial future.',
    cta: 'Sign up',
    points: ['Start building U.S. credit from your first transfer', 'Early member benefits', 'Help us build the best product for you'],
    f: { name: 'Full name', phone: 'Phone number', email: 'Email', country: 'Country you send to', amount: 'How much do you send per transfer?', provider: 'Current remittance provider', knowsScore: 'Do you know your US credit score?', scoreRange: 'What is your credit score range?', remitFrequency: 'How often do you send?', remitYears: 'How long have you been sending remittances?' },
    scoreOptions: ['Below 580', '580–669', '670–739', '740–799', '800+'],
    remitFrequencyOptions: ['Weekly', 'Every 2 weeks', 'Monthly', 'A few times a year', "I don't send yet"],
    remitYearsOptions: ['Less than 1 year', '1–3 years', '3–5 years', 'More than 5 years', "I don't send yet"],
    countries: ['Mexico', 'Other'],
    amounts: ['$0–$50', '$50–$200', '$200–$500', '$500+', "I don't send yet"],
    providers: ['Western Union', 'Remitly', 'Félix', 'MoneyGram', 'Bank transfer', "I don't send yet", 'Other'],
    ph: { name: 'María Santos', phone: '(555) 123-4567', email: 'you@email.com' },
    select: 'Select…',
    submit: 'Join the waitlist',
    fine: 'Puente is in early validation and not yet available. Joining adds you to the early-access list.',
    success: {
      title: "You're on the list!",
      body: "We'll reach out the moment Puente is ready. Want to move up the line?",
      refLabel: 'Share your invite link and skip ahead',
      copy: 'Copy', copied: 'Copied!',
      wa: 'Share on WhatsApp',
      waText: 'I just joined the Puente waitlist — send money home for a $5 flat fee and build credit. Join me:',
    },
    steps: [
      { h: 'Tell us about yourself' },
      { h: 'About your remittances' },
      { h: 'Your credit picture' },
    ],
    next: 'Next',
    back: 'Back',
  },
  footer: {
    tagline: 'Send money home and build U.S. credit doing it. One app, built for our community.',
    rights: '© 2026 Puente Financial, Inc.',
    note: 'Concept in validation — not yet available.',
  },
}

const es: Translations = {
  announce: { pre: 'El acceso anticipado está abierto.', link: 'Regístrate' },
  nav: { remit: 'Remesas', how: 'Cómo funciona', cta: 'Regístrate' },
  hero: {
    eyebrow: 'Remesas + historial de crédito',
    h1: [['Envía', 'dinero.'], ['Crea', 'crédito.']],
    sub: 'Envía dinero a casa — y crea tu historial crediticio en EE. UU. con cada pago que haces. Una sola app, hecha para ti.',
    cta1: 'Regístrate',
    cta2: 'Mira cómo funciona',
    elig: 'Funciona con tu ITIN o SSN.',
    notes: ['Tarifa fija de $5', 'Tipo de cambio real', 'Hecha para ti'],
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
    sub: 'Una tarifa fija de $5. El tipo de cambio real, sin sobreprecio. Y cada transferencia que envías también construye tu historial crediticio en EE. UU.',
    calc: {
      to: 'Enviar a',
      you: 'Tú envías', they: 'Ellos reciben',
      rate: '1 USD = 17.20 MXN', fee: 'Tarifa', flat: '$5.00 fija',
      total: 'Total a pagar', note: 'Tipo de cambio real · sin sobreprecio',
      cta: 'Regístrate',
    },
  },
  how: {
    eyebrow: 'Cómo funciona',
    h2: [['Crea crédito ', 'sin siquiera pensarlo.']],
    sub: 'Enviar dinero a casa es algo que ya haces. Con Puente, cada pago a tiempo ayuda a construir tu historial crediticio en EE. UU. — automáticamente.',
    steps: [
      { t: 'Envía dinero a casa', d: 'Envía como siempre — $5 fijos, al tipo de cambio real, llegando en segundos.' },
      { t: 'Reportamos tus pagos a tiempo', d: 'Puente reporta tus pagos a los principales burós de crédito de EE. UU. por ti.' },
      { t: 'Tu historial de crédito crece', d: 'Los pagos a tiempo construyen un mejor perfil de crédito con el tiempo — sin tarjeta, sin deudas.' },
    ],
    privacyTitle: 'Tu estatus se queda privado',
    privacy: 'Nunca guardamos ni reportamos tu documentación, estatus legal o migratorio. Tu historial de crédito se basa en tus pagos — nada más.',
    eligTitle: 'Lo que necesitas',
    elig: 'Un ITIN o SSN y una dirección en EE. UU. Eso es todo.',
    cta: 'Regístrate',
  },
  wl: {
    eyebrow: 'Empieza ya',
    h2: 'Regístrate hoy',
    sub: 'Regístrate y empieza a convertir tus remesas en un futuro financiero más sólido en EE. UU.',
    cta: 'Regístrate',
    points: ['Empieza a crear crédito desde tu primera transferencia', 'Beneficios de miembro anticipado', 'Ayúdanos a construir el mejor producto para ti'],
    f: { name: 'Nombre completo', phone: 'Teléfono', email: 'Correo electrónico', country: 'País al que envías', amount: '¿Cuánto envías por transferencia?', provider: 'Proveedor de remesas actual', knowsScore: '¿Conoces tu puntaje de crédito en EE. UU.?', scoreRange: '¿Cuál es tu rango de puntaje?', remitFrequency: '¿Con qué frecuencia envías?', remitYears: '¿Hace cuánto tiempo envías remesas?' },
    scoreOptions: ['Menos de 580', '580–669', '670–739', '740–799', '800+'],
    remitFrequencyOptions: ['Semanalmente', 'Cada 2 semanas', 'Mensualmente', 'Pocas veces al año', 'Aún no envío'],
    remitYearsOptions: ['Menos de 1 año', '1–3 años', '3–5 años', 'Más de 5 años', 'Aún no envío'],
    countries: ['México', 'Otro'],
    amounts: ['$0–$50', '$50–$200', '$200–$500', '$500+', 'Aún no envío'],
    providers: ['Western Union', 'Remitly', 'Félix', 'MoneyGram', 'Transferencia bancaria', 'Aún no envío', 'Otro'],
    ph: { name: 'María Santos', phone: '(555) 123-4567', email: 'tu@correo.com' },
    select: 'Selecciona…',
    submit: 'Unirme a la lista',
    fine: 'Puente está en validación temprana y aún no está disponible. Al unirte entras a la lista de acceso anticipado.',
    success: {
      title: '¡Estás en la lista!',
      body: 'Te avisaremos en cuanto Puente esté listo. ¿Quieres adelantarte en la fila?',
      refLabel: 'Comparte tu enlace de invitación y avanza',
      copy: 'Copiar', copied: '¡Copiado!',
      wa: 'Compartir por WhatsApp',
      waText: 'Me uní a la lista de Puente — envía dinero a casa con tarifa fija de $5 y crea crédito. Únete:',
    },
    steps: [
      { h: 'Cuéntanos sobre ti' },
      { h: 'Sobre tus remesas' },
      { h: 'Tu historial de crédito' },
    ],
    next: 'Siguiente',
    back: 'Atrás',
  },
  footer: {
    tagline: 'Envía dinero a casa y crea crédito en EE. UU. al hacerlo. Una sola app, hecha para nuestra comunidad.',
    rights: '© 2026 Puente Financial, Inc.',
    note: 'Concepto en validación — aún no disponible.',
  },
}

export const translations: Record<Lang, Translations> = { en, es }
