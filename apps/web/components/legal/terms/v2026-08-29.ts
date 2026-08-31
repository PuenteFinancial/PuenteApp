import type { TermsDoc } from './types'

// Puente Terms of Service v1.1, effective 2026-08-29.
//
// NEEDS LEGAL REVIEW (EN + ES) — legally operative in both languages. The
// English is the copy supplied by the business and is authoritative; the
// Spanish is a translation and has NOT been through counsel.
//
// This document's date is also its consent version. REQUIRED_CONSENTS
// (packages/shared/src/types/consent.ts) still pins puente_tos at 2026-07-21:
// publishing this page did NOT bump it, deliberately, pending counsel. Bumping
// it forces app-wide re-consent.

const SUPPORT = 'mailto:support@puentefinancial.com'
const SUPPORT_TEXT = 'support@puentefinancial.com'

export const termsEn: TermsDoc = {
  title: 'Terms of Service',
  effective: 'Effective Date: August 29, 2026 · Version 1.1',
  date: '2026-08-29',
  version: '1.1',
  sections: [
    {
      h: '1. Acceptance',
      blocks: [
        { k: 'p', text: ['These Terms of Service ("Terms") govern your use of the mobile application and related services (the "Service") offered by Puente Financial, Inc. ("Puente," "we," "us," or "our"). "You" or "User" refers to the individual who creates an account and uses the Service to send money, and all references to "you" throughout these Terms mean that person. These Terms apply to you as the sender; they do not create an account for, or impose any obligation on, the recipients to whom you send funds. Certain features of the Service are provided by our service partners, Stripe, LLC ("Stripe") and Bridge Building Inc. ("Bridge"), as described in Section 4.'] },
        { k: 'p', text: ['By creating an account or using the Service, you agree to be bound by these Terms and by the separate terms of our service partners described in Section 4, which you will also be asked to accept at the points in the Service where those partners’ features are used. If you do not agree to these Terms or to the partner terms incorporated by reference, you may not use the Service.'] },
      ],
    },
    {
      h: '2. Eligibility',
      blocks: [
        { k: 'p', text: ['To use the Service, you must be at least 18 years old (or the age of majority in your state of residence) and able to provide a valid government-issued identification document. Your ability to use the Service is subject to successful completion of the identity verification process described in Section 6. Eligibility may also be determined by our partners. If Stripe or Bridge declines to verify you, denies or closes your account with them, or otherwise determines that you are not eligible for their services, you will also not be eligible to use the Service. We may deny, suspend, or terminate access to any person who does not meet these requirements, who does not pass identity verification, who is found ineligible by one of our partners, or who resides in a state or location where we or our partners are not authorized to provide the Service (see Section 4.4).'] },
      ],
    },
    {
      h: '3. The Service',
      blocks: [
        { k: 'p', text: ['Puente provides a financial technology application that lets you initiate money transfers to recipients in eligible destinations. Puente is a technology platform. Puente is not a bank. Puente does not at any time hold, custody, transmit, or take possession or control of your funds, whether in U.S. dollars or in any other form. All movement, holding, and transmission of funds is performed by our regulated service partners:'] },
        {
          k: 'ul',
          items: [
            { text: ['Money transmission is provided by Bridge Building Inc. ("Bridge"), a licensed money transmitter (NMLS #2450917) registered with the U.S. Department of the Treasury Financial Crimes Enforcement Network ("FinCEN") as a money services business.'] },
            { text: ['Payment collection and funds transfer at the point of purchase is provided by Stripe, LLC and its affiliates ("Stripe") through Stripe’s regulated Fiat-to-Crypto Onramp service.'] },
          ],
        },
        { k: 'p', text: ['Puente’s role is limited to (a) providing the customer-facing application, (b) presenting pricing and disclosures to you, (c) facilitating the single identity verification process described in Section 6, and (d) initiating and orchestrating transaction instructions on your behalf through our partners’ regulated infrastructure. Puente cannot move, withdraw, redirect, or access funds held by Stripe or Bridge for any purpose other than initiating a transfer you have authorized.'] },
      ],
    },
    {
      h: '4. Service Partners',
      blocks: [],
      subs: [
        {
          h: '4.1 Partner Terms Apply',
          blocks: [
            { k: 'p', text: ['Certain functions of the Service are provided by our third-party partners rather than by Puente. Your use of those functions is governed by each partner’s own terms, which are incorporated into these Terms by reference. By creating an account and using the Service, you agree to the following partner terms, and you will separately be asked to accept the applicable partner terms at the point in the Service where each partner’s features are first used:'] },
            {
              k: 'linkGroups',
              groups: [
                {
                  label: 'Bridge Building Inc.',
                  links: [
                    { text: 'Bridge US User Terms', href: 'https://www.withbridge.com/legal/us-terms/bridge-building-inc' },
                    { text: 'Bridge US Privacy Policy', href: 'https://www.withbridge.com/legal/us-privacy-policy/bridge-building-inc' },
                    { text: 'Bridge Stablecoin Terms', href: 'https://www.withbridge.com/legal/bridge-stablecoin-terms/bridge-building-inc' },
                  ],
                },
                {
                  label: 'Stripe, LLC',
                  links: [
                    { text: 'Stripe Fiat-to-Crypto Onramp Terms', href: 'https://stripe.com/legal/crypto-onramp' },
                    { text: 'Stripe Link End User Terms of Service', href: 'https://stripe.com/legal/end-users' },
                    { text: 'Stripe Link Account Terms', href: 'https://stripe.com/legal/link-account-terms' },
                    { text: 'Stripe Arbitration Agreement', href: 'https://stripe.com/legal/crypto-onramp#arbitration-agreement' },
                    { text: 'Stripe Privacy Policy', href: 'https://stripe.com/privacy' },
                  ],
                },
              ],
            },
          ],
        },
        {
          h: '4.2 Partner Accounts',
          blocks: [
            { k: 'p', text: ['To provide the Service, our partners may require you to hold an account with them. In particular, you will have a Stripe account used to fund and place your transfer. These partner accounts are governed by the partner terms above, not by these Terms, even though you access them through the Puente application.'] },
          ],
        },
        {
          h: '4.3 Conflicts',
          blocks: [
            { k: 'p', text: ['For any function performed by a partner (for example, funds transfer, money transmission, or identity verification), the applicable partner’s terms govern that function. These Terms govern your relationship with Puente and the Puente application. Nothing in these Terms modifies, replaces, or overrides a partner’s terms as they apply to the partner’s own services.'] },
          ],
        },
        {
          h: '4.4 Where the Service Is Available',
          blocks: [
            { k: 'p', text: ['The Service is available only in states and locations where both Bridge and Stripe are authorized to provide their respective services. Because each partner maintains its own licensing footprint, availability of the Service is limited to the more restrictive of the two. We or our partners may add or remove available locations at any time and without prior notice. Current partner licensing information is available at:'] },
            {
              k: 'ul',
              items: [
                { lead: 'Bridge:', text: [{ text: 'https://www.nmlsconsumeraccess.org', href: 'https://www.nmlsconsumeraccess.org' }, ' (NMLS #2450917)'] },
                { lead: 'Stripe:', text: [{ text: 'https://stripe.com/spc/licenses', href: 'https://stripe.com/spc/licenses' }] },
              ],
            },
          ],
        },
      ],
    },
    {
      h: '5. How Transfers Work',
      blocks: [
        { k: 'p', text: ['When you send money through the Service:'] },
        {
          k: 'ol',
          items: [
            ['You choose an amount to send and a recipient, and you fund the transfer from a supported funding source (see Section 7).'],
            ['As part of funding your transfer, your funds are used to purchase a U.S. dollar-denominated stablecoin (USD Coin, or "USDC") through Stripe. The USDC is used to carry the value of your transfer.'],
            ['Bridge, as the licensed money transmitter, uses those funds to deliver payment to your recipient in their local currency.'],
          ],
        },
        { k: 'p', text: ['Puente does not hold, custody, or control your funds at any point. All funds are held and moved by Stripe and Bridge.'] },
      ],
    },
    {
      h: '6. Identity Verification',
      blocks: [
        { k: 'p', text: ['Your use of the Service is subject to successful identity verification. Verification is normally performed once: Stripe collects your identifying information and documentation through its verification provider (Persona), and the result is shared with Puente and Bridge so that a single verification satisfies all parties. In some cases, a partner may require additional or separate verification if it deems necessary.'] },
        { k: 'p', text: ['The information collected may include your full legal name, date of birth, residential address, phone number, taxpayer identification number (a Social Security Number (SSN) or Individual Taxpayer Identification Number (ITIN)), and a government-issued identification document. You agree that all information you provide is complete, accurate, and current, and you agree to update it if it changes. We, Stripe, and Bridge may require additional information at any time as a condition of continued access to the Service, and access may be suspended while additional information is requested or reviewed.'] },
      ],
    },
    {
      h: '7. Fees & Exchange Rates',
      blocks: [
        { k: 'p', text: ['Before you authorize any transfer, we will clearly show you all fees and charges that apply to that transfer, along with the exchange rate, the total amount you will pay, and the amount your recipient is expected to receive in local currency. You will never be charged a fee that was not disclosed to you before you authorized the transfer. The fees for a transfer may include a remittance fee and a currency exchange (FX) rate or margin.'] },
        { k: 'p', text: ['You will be charged the rate quoted to you at the time you authorize a transfer, and you will receive a receipt confirming these details after payment. Fees and rates may change over time, but the rate that applies to any transfer is always the one disclosed to you before you authorize it.'] },
        { k: 'p', text: ['Your bank or card issuer may charge you separate fees (for example, insufficient-funds fees) in connection with funding a transfer. Puente is not responsible for fees charged to you by your own bank or card issuer.'] },
        { k: 'ul', items: [{ lead: 'Supported funding sources.', text: ['At launch, the Service supports funding by bank account (ACH) and debit card only. The Service does not currently accept credit cards. If we enable credit card funding in the future, additional terms and disclosures will apply and will be presented to you at that time.'] }] },
      ],
    },
    {
      h: '8. Transaction Limits',
      blocks: [
        { k: 'p', text: ['At launch, transfers are subject to the following limits: $1,500 per day, $3,000 per month, and $18,000 over any six-month period. We may adjust these limits at our discretion or as required by our partners or applicable law, including based on your account risk rating or verification status. Our partners may also impose their own limits on transactions processed through their infrastructure.'] },
      ],
    },
    {
      h: '9. Cancellations & Refunds',
      blocks: [],
      subs: [
        {
          h: '9.1 The 30-Minute Window',
          blocks: [
            { k: 'p', text: ['Consistent with applicable federal remittance transfer regulations, you have the right to cancel a transfer for a full refund within 30 minutes after you authorize it, provided the funds have not yet been disbursed to the recipient. To cancel, contact us immediately at ', { text: SUPPORT_TEXT, href: SUPPORT }, ' or use the in-app cancellation option, if available. To preserve this right in practice, Puente holds your transaction for 30 minutes before initiating the irreversible settlement steps described in Section 5.'] },
          ],
        },
        {
          h: '9.2 Refunds After Settlement',
          blocks: [
            { k: 'p', text: ['If you cancel through the appropriate channels after the settlement steps in Section 5 have already been executed, Puente will arrange for the funds to be returned to the original funding source (the card or bank account used to fund the transfer). Refunds returned to your original funding source may take several business days to appear, depending on your bank or card issuer.'] },
          ],
        },
      ],
    },
    {
      h: '10. Errors & Disputes',
      blocks: [
        { k: 'p', text: ['If you believe an error has occurred in connection with your transfer (including an incorrect amount sent or received, a transfer not delivered by the disclosed date, or an unauthorized transfer), you may report it by contacting ', { text: SUPPORT_TEXT, href: SUPPORT }, '. You must notify us within 180 days of the disclosed delivery date.'] },
        { k: 'p', text: ['We will investigate promptly. We will normally determine whether an error occurred and communicate the results to you within 90 days of receiving your notice, and where an error is confirmed we will correct it in accordance with applicable law, which may include a refund or resending the transfer.'] },
        { k: 'p', text: ['Please note: the 180-day error-reporting window in this Section applies to remittance-transfer errors. It is separate from and does not extend the shorter, time-sensitive notice requirements for suspected fraud or unauthorized account access described in Section 11. If your concern involves suspected fraud or unauthorized access, you should act under Section 11 immediately rather than relying on the 180-day window.'] },
      ],
    },
    {
      h: '11. Fraud & Unauthorized Activity',
      blocks: [
        { k: 'note', text: ['This Section is important and time-sensitive. Read it carefully.'] },
        { k: 'p', text: ['Our partners’ terms, which apply to you under Section 4, require prompt notice of suspected fraud or unauthorized activity in order to preserve certain protections. In particular, if you become aware of or suspect any unauthorized access to your account or any fraudulent or unauthorized activity relating to a transfer:'] },
        {
          k: 'ul',
          items: [
            { text: ['You must notify Puente immediately, and in any event within 24 hours, at ', { text: SUPPORT_TEXT, href: SUPPORT }, '.'] },
            { text: ['You may be required to promptly report the activity to law enforcement, provide a copy of any report, cooperate fully in any investigation, and complete any required affidavits.'] },
          ],
        },
        { k: 'p', text: ['Failure to provide prompt notice as required by our partners’ terms may reduce or eliminate protections that would otherwise be available to you under those terms. This 24-hour notice requirement is distinct from, and does not replace, the 180-day error-reporting right in Section 10. When in doubt about a suspicious event, treat it as urgent and notify us right away.'] },
      ],
    },
    {
      h: '12. Risk Disclosures',
      blocks: [
        { k: 'p', text: ['Use of the Service involves certain risks that you should understand before sending a transfer:'] },
        {
          k: 'ul',
          items: [
            { lead: 'Exchange rate risk.', text: ['The exchange rate applied to your transfer is set at the time of the transaction and may differ from rates available elsewhere or at other times.'] },
            { lead: 'Delivery timing.', text: ['While Puente and our partners work to deliver transfers promptly, delivery may be delayed due to factors outside our control, including recipient bank processing times, incorrect recipient information, or required compliance review.'] },
            { lead: 'Irrevocability after disbursement.', text: ['Once a transfer has been disbursed to the recipient (that is, after the cancellation window in Section 9 has passed and funds have settled), it generally cannot be reversed.'] },
            { lead: 'Compliance review and holds.', text: ['Transfers may be delayed, held, or declined as required by anti-money laundering, sanctions, and fraud-prevention obligations.'] },
            { lead: 'Reliance on third-party infrastructure.', text: ['Money transmission is performed by Bridge, and payment collection is performed by Stripe. Delivery also depends on the recipient’s own bank and on local payment networks (for example, SPEI in Mexico), all of which are outside Puente’s control.'] },
          ],
        },
      ],
      subs: [
        {
          h: '12.1 Stablecoin Disclosures',
          blocks: [
            { k: 'p', text: ['As described in Section 5, the Service uses a U.S. dollar-denominated stablecoin (USDC on the Base network) as an internal settlement mechanism. Although you do not hold, own, or control any cryptocurrency through the Service, you should be aware of the following:'] },
            {
              k: 'ul',
              items: [
                { lead: 'Not legal tender; not government-backed.', text: ['Stablecoins and other digital assets are not legal tender, are not issued or guaranteed by any government, and their acceptance and treatment are subject to an evolving regulatory landscape.'] },
                { lead: 'No deposit or investor insurance.', text: ['Funds in transit, including any stablecoin used as a settlement mechanism, are not protected by Federal Deposit Insurance Corporation (FDIC) insurance, Securities Investor Protection Corporation (SIPC) protection, or any other insurance, and are not guaranteed by any governmental agency.'] },
                { lead: 'Technology and settlement risk.', text: ['The stablecoin settlement step relies on blockchain networks and third-party infrastructure that neither Puente nor its partners operate or control. Disruptions, delays, or failures affecting that infrastructure could delay or affect your transfer.'] },
                { lead: 'Pooled settlement.', text: ['The wallet that receives the settlement stablecoin is controlled and custodied by Bridge and may hold funds associated with multiple customers in transit before disbursement.'] },
              ],
            },
          ],
        },
      ],
    },
    {
      h: '13. Complaints',
      blocks: [
        { k: 'p', text: ['We are committed to resolving concerns promptly and fairly. This process is separate from the error-resolution rights in Section 10 and the arbitration provisions in Section 20.'] },
        {
          k: 'ul',
          items: [
            { lead: 'How to file a complaint.', text: ['Contact us at ', { text: SUPPORT_TEXT, href: SUPPORT }, ' with a description of your concern, your account information, and any relevant transaction details.'] },
            { lead: 'Acknowledgment.', text: ['We will acknowledge receipt of your complaint within 3 business days.'] },
            { lead: 'Investigation and resolution.', text: ['We aim to investigate and resolve complaints within 30 business days of acknowledgment, and we will keep you updated if additional time is needed.'] },
            { lead: 'Complaints about partner services.', text: ['Some concerns (for example, those relating to money transmission or to funds collection) may fall under the responsibility of Bridge or Stripe. In those cases, we will help direct you to the appropriate partner’s resolution channel, and the applicable partner’s terms will govern how that concern is handled. State-specific complaint contacts for our partners are available through the licensing links in Section 4.4.'] },
            { lead: 'Recordkeeping.', text: ['All complaints and their resolutions are logged and retained consistent with our recordkeeping obligations.'] },
            { lead: 'Escalation.', text: ['If you are not satisfied with the resolution, you may request escalation by contacting ', { text: SUPPORT_TEXT, href: SUPPORT }, ' and requesting escalation.'] },
          ],
        },
      ],
    },
    {
      h: '14. Suspension & Termination',
      blocks: [
        { k: 'p', text: ['We may suspend, restrict, or terminate your access to the Service at our discretion, including where we or our partners suspect fraud, a violation of these Terms or a partner’s terms, a match against a sanctions or watchlist screening, or where required by law or by our regulatory or partner relationships. Our partners may independently suspend or terminate the services they provide, in accordance with their own terms, which may affect your ability to use the Service. You may close your account at any time by contacting ', { text: SUPPORT_TEXT, href: SUPPORT }, '.'] },
      ],
    },
    {
      h: '15. Electronic Communications',
      blocks: [
        { k: 'p', text: ['By using the Service, you consent to receive disclosures, notices, receipts, and communications from us and from our partners electronically, including via email or in-app notification, instead of in paper form. You are responsible for keeping your contact information current. Our partners maintain their own electronic-communications and E-Sign consent terms, which apply to their communications with you under Section 4.'] },
      ],
    },
    {
      h: '16. Changes to Terms',
      blocks: [
        { k: 'p', text: ['We may update these Terms from time to time. Where changes are material, we will provide notice via email or in-app notification a reasonable period before the changes take effect. Your continued use of the Service after changes take effect constitutes acceptance of the updated Terms. Our partners may separately change their own terms on their own schedules; those changes are governed by the partners’ terms, not by this Section.'] },
      ],
    },
    {
      h: '17. Limitation of Liability',
      blocks: [
        { k: 'p', text: ['To the fullest extent permitted by law, Puente shall not be liable for indirect, incidental, special, or consequential damages arising from your use of the Service. Puente’s total liability for any claim arising out of these Terms or the Service shall not exceed the amount of fees you paid to Puente in the transaction giving rise to the claim.'] },
        { k: 'p', text: ['Because Puente does not hold, custody, transmit, or control funds (see Sections 3 and 5), Puente is not responsible or liable for the acts, omissions, performance, or failures of Stripe, Bridge, recipient banks, or local payment networks, including funds-transfer failures, money-transmission errors, identity-verification decisions, or the custody or handling of funds, all of which are governed by the responsible partner’s own terms. Each partner allocates liability differently under its own terms, and the protections and remedies available to you for a given issue depend on which partner’s service is involved. Nothing in this Section limits any liability that cannot be limited under applicable law, including applicable state money-transmission law.'] },
      ],
    },
    {
      h: '18. Indemnification',
      blocks: [
        { k: 'p', text: ['You agree to indemnify and hold Puente harmless from any claims, losses, or damages arising from your violation of these Terms or your misuse of the Service.'] },
      ],
    },
    {
      h: '19. Intellectual Property',
      blocks: [
        { k: 'p', text: ['The Puente application, name, and logo are the property of Puente Financial, Inc. and may not be used without our prior written consent.'] },
      ],
    },
    {
      h: '20. Arbitration',
      blocks: [
        { k: 'note', text: ['Please read this Section carefully. It affects your legal rights.'] },
      ],
      subs: [
        {
          h: '20.1 Arbitration With Puente',
          blocks: [
            { k: 'p', text: ['Any dispute arising out of or relating to these Terms or the Service will be resolved through binding individual arbitration, rather than in court, except that either party may bring a qualifying claim in small claims court. You and Puente each waive the right to a jury trial and the right to participate in a class action or class arbitration.'] },
            { k: 'ul', items: [{ lead: 'Right to opt out.', text: ['You may opt out of this arbitration provision by sending written notice to ', { text: SUPPORT_TEXT, href: SUPPORT }, ' within 30 days of creating your account. If you opt out, disputes with Puente will be resolved in the state or federal courts located in Utah, and both parties consent to jurisdiction there.'] }] },
          ],
        },
        {
          h: '20.2 Partner Arbitration Agreements',
          blocks: [
            { k: 'p', text: ['Because the Service depends on Bridge and Stripe, and because you also agree to their terms under Section 4, you may be subject to as many as three separate and independent arbitration agreements for a single issue: this one with Puente, one with Bridge, and one with Stripe. Each has its own scope, rules, governing law, venue, and opt-out mechanics. For example:'] },
            {
              k: 'ul',
              items: [
                { text: ['Bridge’s terms provide for arbitration under New York law, with mediation before the American Arbitration Association prior to arbitration, and their own written opt-out process.'] },
                { text: ['Stripe’s terms provide for arbitration under the Federal Arbitration Act, require a good-faith informal resolution conference before arbitration, and have their own mail-in opt-out process and deadline.'] },
              ],
            },
            { k: 'p', text: ['Opting out of Puente’s arbitration provision (Section 20.1) has no effect on Bridge’s or Stripe’s arbitration agreements. If you wish to opt out of a partner’s arbitration agreement, you must do so separately and directly with that partner, following the process and deadline in that partner’s terms. We encourage you to review the partner terms linked in Section 4.'] },
          ],
        },
      ],
    },
    {
      h: '21. Governing Law',
      blocks: [
        { k: 'p', text: ['These Terms are governed by the laws of the State of Utah, without regard to conflict of laws principles, except where federal law applies to money transmission, sanctions, or consumer financial protection matters. This governing-law provision applies to your relationship with Puente; our partners’ terms specify their own governing law for their services.'] },
      ],
    },
    {
      h: '22. Contact',
      blocks: [
        { k: 'p', text: ['Puente Financial, Inc.'] },
        { k: 'p', text: ['Provo, Utah, United States'] },
        { k: 'p', text: [{ text: SUPPORT_TEXT, href: SUPPORT }] },
      ],
    },
  ],
}

// Spanish translation. Register note: this document uses the formal "usted",
// unlike the older waitlist-era terms which used "tú". Formal register is the
// convention for operative legal text in Spanish; counsel should confirm.
export const termsEs: TermsDoc = {
  title: 'Términos de Servicio',
  effective: 'Fecha de entrada en vigor: 29 de agosto de 2026 · Versión 1.1',
  date: '2026-08-29',
  version: '1.1',
  sections: [
    {
      h: '1. Aceptación',
      blocks: [
        { k: 'p', text: ['Estos Términos de Servicio (los "Términos") rigen su uso de la aplicación móvil y los servicios relacionados (el "Servicio") ofrecidos por Puente Financial, Inc. ("Puente", "nosotros" o "nuestro"). "Usted" o "Usuario" se refiere a la persona que crea una cuenta y utiliza el Servicio para enviar dinero, y todas las referencias a "usted" en estos Términos significan esa persona. Estos Términos se le aplican a usted como remitente; no crean una cuenta para los destinatarios a quienes envía fondos, ni les imponen ninguna obligación. Algunas funciones del Servicio son proporcionadas por nuestros socios de servicio, Stripe, LLC ("Stripe") y Bridge Building Inc. ("Bridge"), según se describe en la Sección 4.'] },
        { k: 'p', text: ['Al crear una cuenta o utilizar el Servicio, usted acepta quedar obligado por estos Términos y por los términos independientes de nuestros socios de servicio descritos en la Sección 4, que también se le pedirá que acepte en los puntos del Servicio donde se utilicen las funciones de esos socios. Si no está de acuerdo con estos Términos o con los términos de los socios incorporados por referencia, no puede utilizar el Servicio.'] },
      ],
    },
    {
      h: '2. Elegibilidad',
      blocks: [
        { k: 'p', text: ['Para utilizar el Servicio, usted debe tener al menos 18 años de edad (o la mayoría de edad en su estado de residencia) y poder presentar un documento de identificación válido emitido por el gobierno. Su capacidad para utilizar el Servicio está sujeta a la finalización satisfactoria del proceso de verificación de identidad descrito en la Sección 6. La elegibilidad también puede ser determinada por nuestros socios. Si Stripe o Bridge se niega a verificarlo, deniega o cierra su cuenta con ellos, o determina de otro modo que usted no es elegible para sus servicios, tampoco será elegible para utilizar el Servicio. Podemos denegar, suspender o cancelar el acceso a cualquier persona que no cumpla estos requisitos, que no pase la verificación de identidad, que sea considerada no elegible por uno de nuestros socios, o que resida en un estado o lugar donde nosotros o nuestros socios no estemos autorizados a prestar el Servicio (véase la Sección 4.4).'] },
      ],
    },
    {
      h: '3. El Servicio',
      blocks: [
        { k: 'p', text: ['Puente proporciona una aplicación de tecnología financiera que le permite iniciar transferencias de dinero a destinatarios en destinos elegibles. Puente es una plataforma tecnológica. Puente no es un banco. Puente no retiene, custodia, transmite ni toma posesión o control de sus fondos en ningún momento, ya sea en dólares estadounidenses o en cualquier otra forma. Todo el movimiento, la retención y la transmisión de fondos es realizada por nuestros socios de servicio regulados:'] },
        {
          k: 'ul',
          items: [
            { text: ['La transmisión de dinero es proporcionada por Bridge Building Inc. ("Bridge"), un transmisor de dinero con licencia (NMLS #2450917) registrado ante la Red de Control de Delitos Financieros del Departamento del Tesoro de EE. UU. ("FinCEN") como negocio de servicios monetarios.'] },
            { text: ['La recaudación de pagos y la transferencia de fondos en el punto de compra es proporcionada por Stripe, LLC y sus filiales ("Stripe") a través del servicio regulado Fiat-to-Crypto Onramp de Stripe.'] },
          ],
        },
        { k: 'p', text: ['La función de Puente se limita a (a) proporcionar la aplicación de cara al cliente, (b) presentarle los precios y las divulgaciones, (c) facilitar el proceso único de verificación de identidad descrito en la Sección 6, y (d) iniciar y coordinar instrucciones de transacción en su nombre a través de la infraestructura regulada de nuestros socios. Puente no puede mover, retirar, redirigir ni acceder a los fondos retenidos por Stripe o Bridge para ningún fin distinto de iniciar una transferencia que usted haya autorizado.'] },
      ],
    },
    {
      h: '4. Socios de Servicio',
      blocks: [],
      subs: [
        {
          h: '4.1 Los Términos de los Socios Aplican',
          blocks: [
            { k: 'p', text: ['Algunas funciones del Servicio son proporcionadas por nuestros socios externos y no por Puente. Su uso de esas funciones se rige por los términos propios de cada socio, que se incorporan a estos Términos por referencia. Al crear una cuenta y utilizar el Servicio, usted acepta los siguientes términos de los socios, y se le pedirá por separado que acepte los términos aplicables en el punto del Servicio donde se utilicen por primera vez las funciones de cada socio:'] },
            {
              k: 'linkGroups',
              groups: [
                {
                  label: 'Bridge Building Inc.',
                  links: [
                    { text: 'Términos de Usuario de Bridge (EE. UU.)', href: 'https://www.withbridge.com/legal/us-terms/bridge-building-inc' },
                    { text: 'Política de Privacidad de Bridge (EE. UU.)', href: 'https://www.withbridge.com/legal/us-privacy-policy/bridge-building-inc' },
                    { text: 'Términos de Stablecoin de Bridge', href: 'https://www.withbridge.com/legal/bridge-stablecoin-terms/bridge-building-inc' },
                  ],
                },
                {
                  label: 'Stripe, LLC',
                  links: [
                    { text: 'Términos de Fiat-to-Crypto Onramp de Stripe', href: 'https://stripe.com/legal/crypto-onramp' },
                    { text: 'Términos de Servicio para Usuarios Finales de Stripe Link', href: 'https://stripe.com/legal/end-users' },
                    { text: 'Términos de la Cuenta de Stripe Link', href: 'https://stripe.com/legal/link-account-terms' },
                    { text: 'Acuerdo de Arbitraje de Stripe', href: 'https://stripe.com/legal/crypto-onramp#arbitration-agreement' },
                    { text: 'Política de Privacidad de Stripe', href: 'https://stripe.com/privacy' },
                  ],
                },
              ],
            },
          ],
        },
        {
          h: '4.2 Cuentas con los Socios',
          blocks: [
            { k: 'p', text: ['Para prestar el Servicio, nuestros socios pueden exigirle que mantenga una cuenta con ellos. En particular, usted tendrá una cuenta de Stripe que se utiliza para financiar y realizar su transferencia. Estas cuentas con los socios se rigen por los términos de los socios indicados anteriormente, y no por estos Términos, aunque usted acceda a ellas a través de la aplicación de Puente.'] },
          ],
        },
        {
          h: '4.3 Conflictos',
          blocks: [
            { k: 'p', text: ['Para cualquier función realizada por un socio (por ejemplo, transferencia de fondos, transmisión de dinero o verificación de identidad), los términos del socio correspondiente rigen esa función. Estos Términos rigen su relación con Puente y con la aplicación de Puente. Nada en estos Términos modifica, reemplaza ni anula los términos de un socio en lo que respecta a los servicios propios de ese socio.'] },
          ],
        },
        {
          h: '4.4 Dónde Está Disponible el Servicio',
          blocks: [
            { k: 'p', text: ['El Servicio está disponible únicamente en los estados y lugares donde tanto Bridge como Stripe están autorizados a prestar sus respectivos servicios. Debido a que cada socio mantiene su propio alcance de licencias, la disponibilidad del Servicio se limita al más restrictivo de los dos. Nosotros o nuestros socios podemos agregar o eliminar lugares disponibles en cualquier momento y sin previo aviso. La información vigente sobre las licencias de nuestros socios está disponible en:'] },
            {
              k: 'ul',
              items: [
                { lead: 'Bridge:', text: [{ text: 'https://www.nmlsconsumeraccess.org', href: 'https://www.nmlsconsumeraccess.org' }, ' (NMLS #2450917)'] },
                { lead: 'Stripe:', text: [{ text: 'https://stripe.com/spc/licenses', href: 'https://stripe.com/spc/licenses' }] },
              ],
            },
          ],
        },
      ],
    },
    {
      h: '5. Cómo Funcionan las Transferencias',
      blocks: [
        { k: 'p', text: ['Cuando usted envía dinero a través del Servicio:'] },
        {
          k: 'ol',
          items: [
            ['Usted elige un monto a enviar y un destinatario, y financia la transferencia desde una fuente de financiamiento admitida (véase la Sección 7).'],
            ['Como parte del financiamiento de su transferencia, sus fondos se utilizan para comprar, a través de Stripe, una stablecoin denominada en dólares estadounidenses (USD Coin, o "USDC"). La USDC se utiliza para transportar el valor de su transferencia.'],
            ['Bridge, como transmisor de dinero con licencia, utiliza esos fondos para entregar el pago a su destinatario en su moneda local.'],
          ],
        },
        { k: 'p', text: ['Puente no retiene, custodia ni controla sus fondos en ningún momento. Todos los fondos son retenidos y movidos por Stripe y Bridge.'] },
      ],
    },
    {
      h: '6. Verificación de Identidad',
      blocks: [
        { k: 'p', text: ['Su uso del Servicio está sujeto a una verificación de identidad satisfactoria. La verificación normalmente se realiza una sola vez: Stripe recopila su información y documentación de identificación a través de su proveedor de verificación (Persona), y el resultado se comparte con Puente y Bridge para que una sola verificación satisfaga a todas las partes. En algunos casos, un socio puede requerir una verificación adicional o independiente si lo considera necesario.'] },
        { k: 'p', text: ['La información recopilada puede incluir su nombre legal completo, fecha de nacimiento, domicilio residencial, número de teléfono, número de identificación fiscal (un Número de Seguro Social (SSN) o un Número de Identificación Personal del Contribuyente (ITIN)) y un documento de identificación emitido por el gobierno. Usted acepta que toda la información que proporciona es completa, exacta y actual, y se compromete a actualizarla si cambia. Nosotros, Stripe y Bridge podemos solicitar información adicional en cualquier momento como condición para el acceso continuo al Servicio, y el acceso puede suspenderse mientras se solicita o revisa información adicional.'] },
      ],
    },
    {
      h: '7. Comisiones y Tipos de Cambio',
      blocks: [
        { k: 'p', text: ['Antes de que usted autorice cualquier transferencia, le mostraremos claramente todas las comisiones y cargos que se aplican a esa transferencia, junto con el tipo de cambio, el monto total que pagará y el monto que se espera que su destinatario reciba en moneda local. Nunca se le cobrará una comisión que no se le haya divulgado antes de que autorizara la transferencia. Las comisiones de una transferencia pueden incluir una comisión de remesa y un tipo o margen de cambio de divisas (FX).'] },
        { k: 'p', text: ['Se le cobrará la tasa que se le cotizó en el momento en que autoriza una transferencia, y recibirá un recibo que confirma estos detalles después del pago. Las comisiones y las tasas pueden cambiar con el tiempo, pero la tasa que se aplica a cualquier transferencia es siempre la que se le divulgó antes de que la autorizara.'] },
        { k: 'p', text: ['Su banco o emisor de tarjeta puede cobrarle comisiones independientes (por ejemplo, comisiones por fondos insuficientes) en relación con el financiamiento de una transferencia. Puente no es responsable de las comisiones que le cobre su propio banco o emisor de tarjeta.'] },
        { k: 'ul', items: [{ lead: 'Fuentes de financiamiento admitidas.', text: ['En el lanzamiento, el Servicio admite el financiamiento únicamente mediante cuenta bancaria (ACH) y tarjeta de débito. El Servicio no acepta actualmente tarjetas de crédito. Si habilitamos el financiamiento con tarjeta de crédito en el futuro, se aplicarán términos y divulgaciones adicionales que se le presentarán en ese momento.'] }] },
      ],
    },
    {
      h: '8. Límites de Transacción',
      blocks: [
        { k: 'p', text: ['En el lanzamiento, las transferencias están sujetas a los siguientes límites: $1,500 por día, $3,000 por mes y $18,000 en cualquier período de seis meses. Podemos ajustar estos límites a nuestra discreción o según lo requieran nuestros socios o la ley aplicable, incluso en función de la calificación de riesgo de su cuenta o de su estado de verificación. Nuestros socios también pueden imponer sus propios límites a las transacciones procesadas a través de su infraestructura.'] },
      ],
    },
    {
      h: '9. Cancelaciones y Reembolsos',
      blocks: [],
      subs: [
        {
          h: '9.1 La Ventana de 30 Minutos',
          blocks: [
            { k: 'p', text: ['De conformidad con las regulaciones federales aplicables sobre transferencias de remesas, usted tiene derecho a cancelar una transferencia y obtener un reembolso completo dentro de los 30 minutos posteriores a su autorización, siempre que los fondos aún no hayan sido desembolsados al destinatario. Para cancelar, contáctenos de inmediato en ', { text: SUPPORT_TEXT, href: SUPPORT }, ' o utilice la opción de cancelación dentro de la aplicación, si está disponible. Para preservar este derecho en la práctica, Puente retiene su transacción durante 30 minutos antes de iniciar los pasos de liquidación irreversibles descritos en la Sección 5.'] },
          ],
        },
        {
          h: '9.2 Reembolsos Después de la Liquidación',
          blocks: [
            { k: 'p', text: ['Si usted cancela a través de los canales apropiados después de que ya se hayan ejecutado los pasos de liquidación de la Sección 5, Puente gestionará la devolución de los fondos a la fuente de financiamiento original (la tarjeta o cuenta bancaria utilizada para financiar la transferencia). Los reembolsos devueltos a su fuente de financiamiento original pueden tardar varios días hábiles en aparecer, según su banco o emisor de tarjeta.'] },
          ],
        },
      ],
    },
    {
      h: '10. Errores y Disputas',
      blocks: [
        { k: 'p', text: ['Si usted cree que se ha producido un error en relación con su transferencia (incluido un monto incorrecto enviado o recibido, una transferencia no entregada en la fecha divulgada, o una transferencia no autorizada), puede reportarlo contactando a ', { text: SUPPORT_TEXT, href: SUPPORT }, '. Debe notificarnos dentro de los 180 días posteriores a la fecha de entrega divulgada.'] },
        { k: 'p', text: ['Investigaremos con prontitud. Normalmente determinaremos si se produjo un error y le comunicaremos los resultados dentro de los 90 días posteriores a la recepción de su aviso, y cuando se confirme un error lo corregiremos de acuerdo con la ley aplicable, lo que puede incluir un reembolso o el reenvío de la transferencia.'] },
        { k: 'p', text: ['Tenga en cuenta: la ventana de 180 días para reportar errores de esta Sección se aplica a errores de transferencias de remesas. Es independiente de los requisitos de aviso más breves y urgentes para sospecha de fraude o acceso no autorizado a la cuenta descritos en la Sección 11, y no los extiende. Si su preocupación involucra sospecha de fraude o acceso no autorizado, debe actuar conforme a la Sección 11 de inmediato en lugar de basarse en la ventana de 180 días.'] },
      ],
    },
    {
      h: '11. Fraude y Actividad No Autorizada',
      blocks: [
        { k: 'note', text: ['Esta Sección es importante y urgente. Léala con atención.'] },
        { k: 'p', text: ['Los términos de nuestros socios, que se le aplican conforme a la Sección 4, exigen un aviso inmediato de sospecha de fraude o actividad no autorizada para preservar ciertas protecciones. En particular, si usted tiene conocimiento o sospecha de cualquier acceso no autorizado a su cuenta o de cualquier actividad fraudulenta o no autorizada relacionada con una transferencia:'] },
        {
          k: 'ul',
          items: [
            { text: ['Debe notificar a Puente de inmediato, y en todo caso dentro de las 24 horas, en ', { text: SUPPORT_TEXT, href: SUPPORT }, '.'] },
            { text: ['Es posible que se le exija reportar la actividad con prontitud a las autoridades policiales, proporcionar una copia de cualquier reporte, cooperar plenamente en cualquier investigación y completar las declaraciones juradas requeridas.'] },
          ],
        },
        { k: 'p', text: ['No proporcionar el aviso inmediato exigido por los términos de nuestros socios puede reducir o eliminar protecciones que de otro modo estarían disponibles para usted conforme a esos términos. Este requisito de aviso de 24 horas es distinto del derecho de 180 días para reportar errores de la Sección 10, y no lo reemplaza. Ante la duda sobre un evento sospechoso, trátelo como urgente y notifíquenos de inmediato.'] },
      ],
    },
    {
      h: '12. Divulgaciones de Riesgos',
      blocks: [
        { k: 'p', text: ['El uso del Servicio implica ciertos riesgos que usted debe comprender antes de enviar una transferencia:'] },
        {
          k: 'ul',
          items: [
            { lead: 'Riesgo del tipo de cambio.', text: ['El tipo de cambio aplicado a su transferencia se fija en el momento de la transacción y puede diferir de las tasas disponibles en otros lugares o en otros momentos.'] },
            { lead: 'Plazos de entrega.', text: ['Si bien Puente y nuestros socios trabajan para entregar las transferencias con prontitud, la entrega puede retrasarse por factores fuera de nuestro control, incluidos los tiempos de procesamiento del banco del destinatario, información incorrecta del destinatario o una revisión de cumplimiento requerida.'] },
            { lead: 'Irrevocabilidad tras el desembolso.', text: ['Una vez que una transferencia ha sido desembolsada al destinatario (es decir, después de que haya transcurrido la ventana de cancelación de la Sección 9 y los fondos se hayan liquidado), por lo general no puede revertirse.'] },
            { lead: 'Revisión de cumplimiento y retenciones.', text: ['Las transferencias pueden retrasarse, retenerse o rechazarse según lo exijan las obligaciones contra el lavado de dinero, de sanciones y de prevención del fraude.'] },
            { lead: 'Dependencia de infraestructura de terceros.', text: ['La transmisión de dinero es realizada por Bridge, y la recaudación de pagos es realizada por Stripe. La entrega también depende del propio banco del destinatario y de las redes de pago locales (por ejemplo, SPEI en México), todo lo cual está fuera del control de Puente.'] },
          ],
        },
      ],
      subs: [
        {
          h: '12.1 Divulgaciones sobre Stablecoins',
          blocks: [
            { k: 'p', text: ['Como se describe en la Sección 5, el Servicio utiliza una stablecoin denominada en dólares estadounidenses (USDC en la red Base) como mecanismo interno de liquidación. Aunque usted no posee, no es propietario ni controla ninguna criptomoneda a través del Servicio, debe tener en cuenta lo siguiente:'] },
            {
              k: 'ul',
              items: [
                { lead: 'No es moneda de curso legal; no está respaldada por el gobierno.', text: ['Las stablecoins y otros activos digitales no son moneda de curso legal, no son emitidos ni garantizados por ningún gobierno, y su aceptación y tratamiento están sujetos a un panorama regulatorio en evolución.'] },
                { lead: 'Sin seguro de depósitos ni de inversores.', text: ['Los fondos en tránsito, incluida cualquier stablecoin utilizada como mecanismo de liquidación, no están protegidos por el seguro de la Corporación Federal de Seguro de Depósitos (FDIC), por la protección de la Corporación de Protección al Inversor en Valores (SIPC) ni por ningún otro seguro, y no están garantizados por ninguna agencia gubernamental.'] },
                { lead: 'Riesgo tecnológico y de liquidación.', text: ['El paso de liquidación con stablecoin depende de redes blockchain e infraestructura de terceros que ni Puente ni sus socios operan ni controlan. Las interrupciones, retrasos o fallas que afecten a esa infraestructura podrían retrasar o afectar su transferencia.'] },
                { lead: 'Liquidación agrupada.', text: ['La billetera que recibe la stablecoin de liquidación es controlada y custodiada por Bridge y puede mantener fondos asociados con múltiples clientes en tránsito antes del desembolso.'] },
              ],
            },
          ],
        },
      ],
    },
    {
      h: '13. Quejas',
      blocks: [
        { k: 'p', text: ['Nos comprometemos a resolver las inquietudes de forma rápida y justa. Este proceso es independiente de los derechos de resolución de errores de la Sección 10 y de las disposiciones de arbitraje de la Sección 20.'] },
        {
          k: 'ul',
          items: [
            { lead: 'Cómo presentar una queja.', text: ['Contáctenos en ', { text: SUPPORT_TEXT, href: SUPPORT }, ' con una descripción de su inquietud, la información de su cuenta y cualquier detalle relevante de la transacción.'] },
            { lead: 'Acuse de recibo.', text: ['Acusaremos recibo de su queja dentro de los 3 días hábiles.'] },
            { lead: 'Investigación y resolución.', text: ['Nuestro objetivo es investigar y resolver las quejas dentro de los 30 días hábiles posteriores al acuse de recibo, y lo mantendremos informado si se necesita tiempo adicional.'] },
            { lead: 'Quejas sobre los servicios de los socios.', text: ['Algunas inquietudes (por ejemplo, las relacionadas con la transmisión de dinero o con la recaudación de fondos) pueden ser responsabilidad de Bridge o de Stripe. En esos casos, le ayudaremos a dirigirse al canal de resolución del socio correspondiente, y los términos del socio aplicable regirán cómo se maneja esa inquietud. Los contactos de quejas específicos por estado de nuestros socios están disponibles a través de los enlaces de licencias de la Sección 4.4.'] },
            { lead: 'Conservación de registros.', text: ['Todas las quejas y sus resoluciones se registran y conservan de conformidad con nuestras obligaciones de conservación de registros.'] },
            { lead: 'Escalamiento.', text: ['Si no está satisfecho con la resolución, puede solicitar un escalamiento contactando a ', { text: SUPPORT_TEXT, href: SUPPORT }, ' y solicitando el escalamiento.'] },
          ],
        },
      ],
    },
    {
      h: '14. Suspensión y Cancelación',
      blocks: [
        { k: 'p', text: ['Podemos suspender, restringir o cancelar su acceso al Servicio a nuestra discreción, incluso cuando nosotros o nuestros socios sospechemos de fraude, de una violación de estos Términos o de los términos de un socio, de una coincidencia en una revisión de sanciones o listas de vigilancia, o cuando así lo exija la ley o nuestras relaciones regulatorias o con los socios. Nuestros socios pueden suspender o cancelar de forma independiente los servicios que prestan, de acuerdo con sus propios términos, lo que puede afectar su capacidad para utilizar el Servicio. Usted puede cerrar su cuenta en cualquier momento contactando a ', { text: SUPPORT_TEXT, href: SUPPORT }, '.'] },
      ],
    },
    {
      h: '15. Comunicaciones Electrónicas',
      blocks: [
        { k: 'p', text: ['Al utilizar el Servicio, usted consiente en recibir divulgaciones, avisos, recibos y comunicaciones de nuestra parte y de nuestros socios de forma electrónica, incluso por correo electrónico o notificación dentro de la aplicación, en lugar de en papel. Usted es responsable de mantener actualizada su información de contacto. Nuestros socios mantienen sus propios términos de comunicaciones electrónicas y de consentimiento E-Sign, que se aplican a sus comunicaciones con usted conforme a la Sección 4.'] },
      ],
    },
    {
      h: '16. Cambios a los Términos',
      blocks: [
        { k: 'p', text: ['Podemos actualizar estos Términos periódicamente. Cuando los cambios sean materiales, le daremos aviso por correo electrónico o notificación dentro de la aplicación con una antelación razonable a la entrada en vigor de los cambios. Su uso continuado del Servicio después de que los cambios entren en vigor constituye la aceptación de los Términos actualizados. Nuestros socios pueden cambiar sus propios términos por separado y según sus propios calendarios; esos cambios se rigen por los términos de los socios, no por esta Sección.'] },
      ],
    },
    {
      h: '17. Limitación de Responsabilidad',
      blocks: [
        { k: 'p', text: ['En la máxima medida permitida por la ley, Puente no será responsable de daños indirectos, incidentales, especiales o consecuentes derivados de su uso del Servicio. La responsabilidad total de Puente por cualquier reclamación derivada de estos Términos o del Servicio no excederá el monto de las comisiones que usted pagó a Puente en la transacción que dio lugar a la reclamación.'] },
        { k: 'p', text: ['Debido a que Puente no retiene, custodia, transmite ni controla fondos (véanse las Secciones 3 y 5), Puente no es responsable de los actos, omisiones, desempeño o fallas de Stripe, Bridge, los bancos receptores o las redes de pago locales, incluidas las fallas en la transferencia de fondos, los errores de transmisión de dinero, las decisiones de verificación de identidad, o la custodia o el manejo de fondos, todo lo cual se rige por los términos propios del socio responsable. Cada socio asigna la responsabilidad de manera diferente conforme a sus propios términos, y las protecciones y recursos disponibles para usted en un caso determinado dependen de cuál servicio del socio esté involucrado. Nada en esta Sección limita ninguna responsabilidad que no pueda limitarse conforme a la ley aplicable, incluida la ley estatal aplicable sobre transmisión de dinero.'] },
      ],
    },
    {
      h: '18. Indemnización',
      blocks: [
        { k: 'p', text: ['Usted acepta indemnizar y eximir de responsabilidad a Puente frente a cualquier reclamación, pérdida o daño derivado de su violación de estos Términos o de su uso indebido del Servicio.'] },
      ],
    },
    {
      h: '19. Propiedad Intelectual',
      blocks: [
        { k: 'p', text: ['La aplicación, el nombre y el logotipo de Puente son propiedad de Puente Financial, Inc. y no pueden utilizarse sin nuestro consentimiento previo por escrito.'] },
      ],
    },
    {
      h: '20. Arbitraje',
      blocks: [
        { k: 'note', text: ['Lea esta Sección con atención. Afecta sus derechos legales.'] },
      ],
      subs: [
        {
          h: '20.1 Arbitraje con Puente',
          blocks: [
            { k: 'p', text: ['Cualquier disputa que surja de estos Términos o del Servicio, o que se relacione con ellos, se resolverá mediante arbitraje individual vinculante, en lugar de en un tribunal, con la salvedad de que cualquiera de las partes puede presentar una reclamación que califique ante un tribunal de reclamos menores. Usted y Puente renuncian cada uno al derecho a un juicio con jurado y al derecho a participar en una demanda colectiva o en un arbitraje colectivo.'] },
            { k: 'ul', items: [{ lead: 'Derecho a optar por no participar.', text: ['Usted puede optar por no participar en esta disposición de arbitraje enviando un aviso por escrito a ', { text: SUPPORT_TEXT, href: SUPPORT }, ' dentro de los 30 días posteriores a la creación de su cuenta. Si usted opta por no participar, las disputas con Puente se resolverán en los tribunales estatales o federales ubicados en Utah, y ambas partes consienten a la jurisdicción allí.'] }] },
          ],
        },
        {
          h: '20.2 Acuerdos de Arbitraje de los Socios',
          blocks: [
            { k: 'p', text: ['Debido a que el Servicio depende de Bridge y Stripe, y a que usted también acepta sus términos conforme a la Sección 4, usted puede estar sujeto a hasta tres acuerdos de arbitraje separados e independientes para un mismo asunto: este con Puente, uno con Bridge y uno con Stripe. Cada uno tiene su propio alcance, reglas, ley aplicable, sede y mecánica para optar por no participar. Por ejemplo:'] },
            {
              k: 'ul',
              items: [
                { text: ['Los términos de Bridge prevén arbitraje conforme a la ley de Nueva York, con mediación ante la American Arbitration Association antes del arbitraje, y su propio proceso escrito para optar por no participar.'] },
                { text: ['Los términos de Stripe prevén arbitraje conforme a la Ley Federal de Arbitraje, exigen una conferencia informal de resolución de buena fe antes del arbitraje, y tienen su propio proceso por correo postal y plazo para optar por no participar.'] },
              ],
            },
            { k: 'p', text: ['Optar por no participar en la disposición de arbitraje de Puente (Sección 20.1) no tiene efecto sobre los acuerdos de arbitraje de Bridge o de Stripe. Si usted desea optar por no participar en el acuerdo de arbitraje de un socio, debe hacerlo por separado y directamente con ese socio, siguiendo el proceso y el plazo indicados en los términos de ese socio. Le recomendamos revisar los términos de los socios enlazados en la Sección 4.'] },
          ],
        },
      ],
    },
    {
      h: '21. Ley Aplicable',
      blocks: [
        { k: 'p', text: ['Estos Términos se rigen por las leyes del Estado de Utah, sin considerar sus principios de conflicto de leyes, salvo cuando la ley federal se aplique a asuntos de transmisión de dinero, sanciones o protección financiera del consumidor. Esta disposición sobre ley aplicable rige su relación con Puente; los términos de nuestros socios especifican su propia ley aplicable para sus servicios.'] },
      ],
    },
    {
      h: '22. Contacto',
      blocks: [
        { k: 'p', text: ['Puente Financial, Inc.'] },
        { k: 'p', text: ['Provo, Utah, Estados Unidos'] },
        { k: 'p', text: [{ text: SUPPORT_TEXT, href: SUPPORT }] },
      ],
    },
  ],
}
