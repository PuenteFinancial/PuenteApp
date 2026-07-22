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
        'We use the information you provide to operate Puente Financial, to communicate with you about product updates and launch announcements, and to verify your identity and secure your account — including sending one-time verification codes by SMS. We will not sell or share your personal information with third parties for marketing purposes.',
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
