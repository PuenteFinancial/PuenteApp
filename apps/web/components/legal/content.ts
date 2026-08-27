import type { Lang } from '@/lib/translations'

// Bilingual copy for the legal pages (Privacy Policy + Terms of Service).
//
// NOTE: The Spanish translations here are a first pass and are pending
// native-speaker / legal review before they should be relied upon. Keep the
// two languages in lockstep — any change to the English source must be
// mirrored in Spanish (and vice versa). The English copy is legally operative
// today and is also what the A2P 10DLC (TCR) vetting scanner reads, so it must
// remain the SSR default on the canonical /privacy and /terms URLs.

type Bullet = { label: string; body: string }

export type PrivacyCopy = {
  backHome: string
  title: string
  updated: string
  s1: { h: string; body: string }
  s2: { h: string; body: string }
  s3: { h: string; intro: string; bullets: Bullet[] }
  s4: { h: string; body: string }
  s5: { h: string; pre: string; post: string }
  s6: { h: string; pre: string }
}

export type TermsCopy = {
  backHome: string
  title: string
  updated: string
  s1: { h: string; body: string }
  s2: { h: string; body: string }
  s3: { h: string; body: string }
  s4: { h: string; body: string }
  s5: { h: string; pre: string; privacyLink: string; post: string }
  s6: { h: string; pre: string }
}

export const privacyCopy: Record<Lang, PrivacyCopy> = {
  en: {
    backHome: '← Back to home',
    title: 'Privacy Policy',
    updated: 'Last updated: July 21, 2026',
    s1: {
      h: '1. Information We Collect',
      body:
        'When you join our waitlist, we collect your first name, WhatsApp number, estimated monthly send amount, and destination country. When you create an account or sign in, we collect your mobile phone number so we can send one-time verification codes by SMS (see “SMS / Text Messaging” below). We also collect standard web analytics data such as your browser type and general location.',
    },
    s2: {
      h: '2. How We Use Your Information',
      body:
        'We use the information you provide to operate Puente Financial, to communicate with you about product updates and launch announcements, and to verify your identity and secure your account, including sending one-time verification codes by SMS. We will not sell or share your personal information with third parties for marketing purposes.',
    },
    s3: {
      h: '3. SMS / Text Messaging',
      intro:
        'When you create an account or sign in to the Puente Financial mobile app, we send a one-time verification code (OTP) by text message to the mobile number you provide, to confirm it belongs to you. By entering your number and requesting a code, you consent to receive these transactional SMS messages from Puente Financial.',
      bullets: [
        {
          label: 'Message frequency:',
          body:
            'You receive a message only when you request a verification code; frequency varies with how often you sign in.',
        },
        {
          label: 'Message and data rates may apply,',
          body: 'depending on your mobile carrier and plan.',
        },
        {
          label: 'Opt-out:',
          body:
            'Reply STOP to any message to opt out of SMS, or HELP for help. Because these codes are required to access your account, opting out may prevent you from signing in.',
        },
        {
          label: 'No sharing of mobile data:',
          body:
            'We do not share, sell, rent, or otherwise provide your mobile phone number, SMS opt-in, or messaging consent to any third parties or affiliates for marketing or promotional purposes. We use a messaging service provider solely to deliver your verification codes; this information is never used for marketing or promotional purposes.',
        },
      ],
    },
    s4: {
      h: '4. Data Storage',
      body:
        'Your information is stored securely using Supabase, a SOC 2 compliant database platform. We retain your data for as long as necessary to operate our waitlist and communicate with you about our product.',
    },
    s5: {
      h: '5. Your Rights',
      pre: 'You may request that we delete your information at any time by emailing us at',
      post: '. We will process your request within 30 days.',
    },
    s6: {
      h: '6. Contact',
      pre: 'For any questions about this policy, please contact us at',
    },
  },
  es: {
    backHome: '← Volver al inicio',
    title: 'Política de Privacidad',
    updated: 'Última actualización: 21 de julio de 2026',
    s1: {
      h: '1. Información que Recopilamos',
      body:
        'Cuando te unes a nuestra lista de espera, recopilamos tu nombre, tu número de WhatsApp, el monto mensual estimado de envío y el país de destino. Cuando creas una cuenta o inicias sesión, recopilamos tu número de teléfono móvil para poder enviarte códigos de verificación de un solo uso por SMS (consulta «SMS / Mensajes de Texto» más abajo). También recopilamos datos analíticos web estándar, como el tipo de navegador y tu ubicación general.',
    },
    s2: {
      h: '2. Cómo Usamos tu Información',
      body:
        'Usamos la información que proporcionas para operar Puente Financial, para comunicarnos contigo sobre novedades del producto y anuncios de lanzamiento, y para verificar tu identidad y proteger tu cuenta, incluido el envío de códigos de verificación de un solo uso por SMS. No venderemos ni compartiremos tu información personal con terceros con fines de marketing.',
    },
    s3: {
      h: '3. SMS / Mensajes de Texto',
      intro:
        'Cuando creas una cuenta o inicias sesión en la aplicación móvil de Puente Financial, te enviamos un código de verificación de un solo uso (OTP) por mensaje de texto al número de móvil que proporcionas, para confirmar que te pertenece. Al ingresar tu número y solicitar un código, aceptas recibir estos mensajes SMS transaccionales de Puente Financial.',
      bullets: [
        {
          label: 'Frecuencia de mensajes:',
          body:
            'Recibes un mensaje solo cuando solicitas un código de verificación; la frecuencia varía según la frecuencia con la que inicies sesión.',
        },
        {
          label: 'Pueden aplicarse tarifas de mensajes y datos,',
          body: 'según tu operador y plan de telefonía móvil.',
        },
        {
          label: 'Cancelar la suscripción:',
          body:
            'Responde STOP a cualquier mensaje para cancelar los SMS, o HELP para obtener ayuda. Como estos códigos son necesarios para acceder a tu cuenta, cancelar la suscripción puede impedirte iniciar sesión.',
        },
        {
          label: 'No compartimos datos móviles:',
          body:
            'No compartimos, vendemos, alquilamos ni proporcionamos de ningún otro modo tu número de teléfono móvil, tu suscripción por SMS ni tu consentimiento de mensajería a terceros ni afiliados con fines de marketing o promocionales. Utilizamos un proveedor de servicios de mensajería únicamente para entregarte tus códigos de verificación; esta información nunca se usa con fines de marketing o promocionales.',
        },
      ],
    },
    s4: {
      h: '4. Almacenamiento de Datos',
      body:
        'Tu información se almacena de forma segura mediante Supabase, una plataforma de base de datos con certificación SOC 2. Conservamos tus datos durante el tiempo que sea necesario para operar nuestra lista de espera y comunicarnos contigo sobre nuestro producto.',
    },
    s5: {
      h: '5. Tus Derechos',
      pre: 'Puedes solicitar que eliminemos tu información en cualquier momento escribiéndonos a',
      post: '. Procesaremos tu solicitud en un plazo de 30 días.',
    },
    s6: {
      h: '6. Contacto',
      pre: 'Si tienes preguntas sobre esta política, contáctanos en',
    },
  },
}

export const termsCopy: Record<Lang, TermsCopy> = {
  en: {
    backHome: '← Back to home',
    title: 'Terms of Service',
    updated: 'Last updated: July 21, 2026',
    s1: {
      h: '1. Waitlist and Early Access',
      body:
        'By joining the Puente Financial waitlist, you agree to receive communications about our product development and launch. Joining the waitlist does not guarantee access to any product or service. Access to Puente Financial’s services may be offered on a limited or invitation basis and can depend on your eligibility and identity verification.',
    },
    s2: {
      h: '2. Products and Services',
      body:
        'Puente Financial is introducing money movement services, including USD-to-Mexico remittance, on a limited and rolling basis. Availability may depend on your location, identity verification, and eligibility. Credit-building and credit-reporting features described on this website are planned and not yet available. All descriptions of features, pricing, and rewards are forward-looking and subject to change, and nothing on this website constitutes a financial offer or commitment.',
    },
    s3: {
      h: '3. Accuracy of Information',
      body:
        'We strive to provide accurate information about our planned products, but descriptions of features, pricing, rewards, and other product details are subject to change prior to launch and should not be relied upon as definitive.',
    },
    s4: {
      h: '4. Limitation of Liability',
      body:
        'Puente Financial shall not be liable for any damages arising from your use of or reliance on this website or its content. This website is provided “as is” without warranties of any kind.',
    },
    s5: {
      h: '5. SMS / Text Messaging',
      pre:
        'By providing your mobile number and requesting a verification code, you agree to receive one-time passcode (OTP) text messages from Puente Financial for account creation and login. Message frequency varies. Message and data rates may apply. Reply STOP to opt out of SMS or HELP for help. See our',
      privacyLink: 'Privacy Policy',
      post: 'for details on how we handle mobile information.',
    },
    s6: {
      h: '6. Contact',
      pre: 'For questions about these terms, contact us at',
    },
  },
  es: {
    backHome: '← Volver al inicio',
    title: 'Términos de Servicio',
    updated: 'Última actualización: 21 de julio de 2026',
    s1: {
      h: '1. Lista de Espera y Acceso Anticipado',
      body:
        'Al unirte a la lista de espera de Puente Financial, aceptas recibir comunicaciones sobre el desarrollo y el lanzamiento de nuestro producto. Unirte a la lista de espera no garantiza el acceso a ningún producto o servicio. El acceso a los servicios de Puente Financial puede ofrecerse de forma limitada o por invitación y puede depender de tu elegibilidad y verificación de identidad.',
    },
    s2: {
      h: '2. Productos y Servicios',
      body:
        'Puente Financial está incorporando servicios de movimiento de dinero, incluidas las remesas de EE. UU. a México, de forma limitada y progresiva. La disponibilidad puede depender de tu ubicación, la verificación de identidad y tu elegibilidad. Las funciones de construcción de crédito y de reporte de crédito descritas en este sitio web están planificadas y aún no están disponibles. Todas las descripciones de funciones, precios y recompensas son prospectivas y están sujetas a cambios, y nada en este sitio web constituye una oferta o compromiso financiero.',
    },
    s3: {
      h: '3. Exactitud de la Información',
      body:
        'Nos esforzamos por proporcionar información precisa sobre nuestros productos planificados, pero las descripciones de funciones, precios, recompensas y otros detalles del producto están sujetas a cambios antes del lanzamiento y no deben considerarse definitivas.',
    },
    s4: {
      h: '4. Limitación de Responsabilidad',
      body:
        'Puente Financial no será responsable de ningún daño derivado de tu uso o confianza en este sitio web o su contenido. Este sitio web se proporciona «tal cual», sin garantías de ningún tipo.',
    },
    s5: {
      h: '5. SMS / Mensajes de Texto',
      pre:
        'Al proporcionar tu número de móvil y solicitar un código de verificación, aceptas recibir mensajes de texto con contraseñas de un solo uso (OTP) de Puente Financial para la creación de cuentas e inicio de sesión. La frecuencia de los mensajes varía. Pueden aplicarse tarifas de mensajes y datos. Responde STOP para cancelar los SMS o HELP para obtener ayuda. Consulta nuestra',
      privacyLink: 'Política de Privacidad',
      post: 'para conocer los detalles sobre cómo manejamos la información móvil.',
    },
    s6: {
      h: '6. Contacto',
      pre: 'Si tienes preguntas sobre estos términos, contáctanos en',
    },
  },
}

// ── E-SIGN Consent to Electronic Records (K1, KYC rehaul) ──────────────────
//
// NEEDS LEGAL REVIEW (EN + ES) — placeholder pending the K7 counsel pass.
// Legally operative in both languages. The document's "Last updated" date IS
// its consent version: it must match the `esign` entry in REQUIRED_CONSENTS
// (packages/shared/src/types/consent.ts). Changing this text means bumping
// both, which forces app-wide re-consent — that is the designed behavior,
// not a bug.
//
// Scope note: this consent covers ALL electronic records (deliberately
// expanded 2026-08-27 from the earlier receipt-only scope — a knowing,
// ratified change; see docs/decisions.md).

export type EsignCopy = {
  backHome: string
  title: string
  updated: string
  intro: string
  s1: { h: string; body: string }
  s2: { h: string; body: string }
  s3: { h: string; body: string }
  s4: { h: string; body: string }
  s5: { h: string; body: string }
  s6: { h: string; pre: string }
}

export const esignCopy: Record<Lang, EsignCopy> = {
  en: {
    backHome: '← Back',
    title: 'Consent to Electronic Records (E-SIGN)',
    updated: 'Last updated: August 27, 2026',
    intro:
      'This consent applies to all records related to your Puente Financial account. By agreeing, you consent to receive and sign everything electronically instead of on paper.',
    s1: {
      h: '1. What This Consent Covers',
      body:
        'All agreements, authorizations, disclosures, receipts, statements, notices, and other records we are required to provide you or that you sign in connection with your Puente account and transfers — including remittance transfer disclosures and receipts — will be provided or completed electronically.',
    },
    s2: {
      h: '2. Hardware and Software Requirements',
      body:
        'To receive and keep electronic records you need: a device with internet access; a current web browser; a valid email address; a phone number that can receive SMS; and the ability to view and save or print PDF and web-page documents. If these requirements change in a way that creates a material risk you cannot access your records, we will notify you.',
    },
    s3: {
      h: '3. Paper Copies',
      body:
        'You can request a free paper copy of any record we provided electronically by contacting us at the address below. We will mail it to the address you provide, at no charge, within 10 business days of your request. Requesting a paper copy does not withdraw your consent to electronic records.',
    },
    s4: {
      h: '4. Withdrawing Your Consent',
      body:
        'You may withdraw this consent at any time by contacting us at the address below. Because Puente is an electronic service, withdrawing consent means you will no longer be able to use Puente to send money. Withdrawal takes effect after we have had a reasonable time to process it and does not affect records already provided electronically.',
    },
    s5: {
      h: '5. Keeping Your Contact Information Current',
      body:
        'You are responsible for keeping a current email address and phone number on file with us. You can update them in your account settings or by contacting us.',
    },
    s6: {
      h: '6. Contact',
      pre: 'Questions about this consent, paper copies, or withdrawal:',
    },
  },
  es: {
    backHome: '← Volver',
    title: 'Consentimiento para Documentos Electrónicos (E-SIGN)',
    updated: 'Última actualización: 27 de agosto de 2026',
    intro:
      'Este consentimiento aplica a todos los documentos relacionados con tu cuenta de Puente Financial. Al aceptar, consientes recibir y firmar todo electrónicamente en lugar de en papel.',
    s1: {
      h: '1. Qué Cubre Este Consentimiento',
      body:
        'Todos los acuerdos, autorizaciones, avisos, recibos, estados de cuenta, notificaciones y demás documentos que debamos entregarte o que firmes en relación con tu cuenta de Puente y tus transferencias — incluidas las divulgaciones y recibos de transferencias de remesas — se entregarán o completarán electrónicamente.',
    },
    s2: {
      h: '2. Requisitos de Hardware y Software',
      body:
        'Para recibir y conservar documentos electrónicos necesitas: un dispositivo con acceso a internet; un navegador web actualizado; una dirección de correo electrónico válida; un número de teléfono que pueda recibir SMS; y la capacidad de ver y guardar o imprimir documentos PDF y páginas web. Si estos requisitos cambian de forma que cree un riesgo material de que no puedas acceder a tus documentos, te lo notificaremos.',
    },
    s3: {
      h: '3. Copias en Papel',
      body:
        'Puedes solicitar una copia en papel gratuita de cualquier documento que te hayamos entregado electrónicamente contactándonos en la dirección indicada abajo. La enviaremos por correo postal a la dirección que nos proporciones, sin costo, dentro de los 10 días hábiles siguientes a tu solicitud. Solicitar una copia en papel no retira tu consentimiento para documentos electrónicos.',
    },
    s4: {
      h: '4. Retirar Tu Consentimiento',
      body:
        'Puedes retirar este consentimiento en cualquier momento contactándonos en la dirección indicada abajo. Como Puente es un servicio electrónico, retirar el consentimiento significa que ya no podrás usar Puente para enviar dinero. El retiro surte efecto después de que hayamos tenido un tiempo razonable para procesarlo y no afecta los documentos ya entregados electrónicamente.',
    },
    s5: {
      h: '5. Mantener Tu Información de Contacto Actualizada',
      body:
        'Eres responsable de mantener un correo electrónico y un número de teléfono vigentes en tu cuenta. Puedes actualizarlos en la configuración de tu cuenta o contactándonos.',
    },
    s6: {
      h: '6. Contacto',
      pre: 'Preguntas sobre este consentimiento, copias en papel o retiro:',
    },
  },
}
