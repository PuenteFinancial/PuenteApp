import type { TermsDoc } from './types'

// Puente Terms of Service v1.0, effective 2026-07-21. SUPERSEDED by v1.1 on
// 2026-08-29 and frozen here so anyone who agreed to this version can still
// read what they agreed to. Do not edit the operative text.
//
// This is the waitlist-era document, converted verbatim from the flat
// `termsCopy` shape that previously lived in ../content.ts.

const LEGAL = 'mailto:legal@puentefinancial.com'
const LEGAL_TEXT = 'legal@puentefinancial.com'

export const termsV1En: TermsDoc = {
  title: 'Terms of Service',
  effective: 'Last updated: July 21, 2026 · Version 1.0',
  date: '2026-07-21',
  version: '1.0',
  sections: [
    {
      h: '1. Waitlist and Early Access',
      blocks: [{ k: 'p', text: ['By joining the Puente Financial waitlist, you agree to receive communications about our product development and launch. Joining the waitlist does not guarantee access to any product or service. Access to Puente Financial’s services may be offered on a limited or invitation basis and can depend on your eligibility and identity verification.'] }],
    },
    {
      h: '2. Products and Services',
      blocks: [{ k: 'p', text: ['Puente Financial is introducing money movement services, including USD-to-Mexico remittance, on a limited and rolling basis. Availability may depend on your location, identity verification, and eligibility. Credit-building and credit-reporting features described on this website are planned and not yet available. All descriptions of features, pricing, and rewards are forward-looking and subject to change, and nothing on this website constitutes a financial offer or commitment.'] }],
    },
    {
      h: '3. Accuracy of Information',
      blocks: [{ k: 'p', text: ['We strive to provide accurate information about our planned products, but descriptions of features, pricing, rewards, and other product details are subject to change prior to launch and should not be relied upon as definitive.'] }],
    },
    {
      h: '4. Limitation of Liability',
      blocks: [{ k: 'p', text: ['Puente Financial shall not be liable for any damages arising from your use of or reliance on this website or its content. This website is provided “as is” without warranties of any kind.'] }],
    },
    {
      h: '5. SMS / Text Messaging',
      blocks: [{ k: 'p', text: ['By providing your mobile number and requesting a verification code, you agree to receive one-time passcode (OTP) text messages from Puente Financial for account creation and login. Message frequency varies. Message and data rates may apply. Reply STOP to opt out of SMS or HELP for help. See our ', { text: 'Privacy Policy', href: '/privacy' }, ' for details on how we handle mobile information.'] }],
    },
    {
      h: '6. Contact',
      blocks: [{ k: 'p', text: ['For questions about these terms, contact us at ', { text: LEGAL_TEXT, href: LEGAL }, '.'] }],
    },
  ],
}

export const termsV1Es: TermsDoc = {
  title: 'Términos de Servicio',
  effective: 'Última actualización: 21 de julio de 2026 · Versión 1.0',
  date: '2026-07-21',
  version: '1.0',
  sections: [
    {
      h: '1. Lista de Espera y Acceso Anticipado',
      blocks: [{ k: 'p', text: ['Al unirte a la lista de espera de Puente Financial, aceptas recibir comunicaciones sobre el desarrollo y el lanzamiento de nuestro producto. Unirte a la lista de espera no garantiza el acceso a ningún producto o servicio. El acceso a los servicios de Puente Financial puede ofrecerse de forma limitada o por invitación y puede depender de tu elegibilidad y verificación de identidad.'] }],
    },
    {
      h: '2. Productos y Servicios',
      blocks: [{ k: 'p', text: ['Puente Financial está incorporando servicios de movimiento de dinero, incluidas las remesas de EE. UU. a México, de forma limitada y progresiva. La disponibilidad puede depender de tu ubicación, la verificación de identidad y tu elegibilidad. Las funciones de construcción de crédito y de reporte de crédito descritas en este sitio web están planificadas y aún no están disponibles. Todas las descripciones de funciones, precios y recompensas son prospectivas y están sujetas a cambios, y nada en este sitio web constituye una oferta o compromiso financiero.'] }],
    },
    {
      h: '3. Exactitud de la Información',
      blocks: [{ k: 'p', text: ['Nos esforzamos por proporcionar información precisa sobre nuestros productos planificados, pero las descripciones de funciones, precios, recompensas y otros detalles del producto están sujetas a cambios antes del lanzamiento y no deben considerarse definitivas.'] }],
    },
    {
      h: '4. Limitación de Responsabilidad',
      blocks: [{ k: 'p', text: ['Puente Financial no será responsable de ningún daño derivado de tu uso o confianza en este sitio web o su contenido. Este sitio web se proporciona «tal cual», sin garantías de ningún tipo.'] }],
    },
    {
      h: '5. SMS / Mensajes de Texto',
      blocks: [{ k: 'p', text: ['Al proporcionar tu número de móvil y solicitar un código de verificación, aceptas recibir mensajes de texto con contraseñas de un solo uso (OTP) de Puente Financial para la creación de cuentas e inicio de sesión. La frecuencia de los mensajes varía. Pueden aplicarse tarifas de mensajes y datos. Responde STOP para cancelar los SMS o HELP para obtener ayuda. Consulta nuestra ', { text: 'Política de Privacidad', href: '/privacy' }, ' para conocer los detalles sobre cómo manejamos la información móvil.'] }],
    },
    {
      h: '6. Contacto',
      blocks: [{ k: 'p', text: ['Si tienes preguntas sobre estos términos, contáctanos en ', { text: LEGAL_TEXT, href: LEGAL }, '.'] }],
    },
  ],
}
