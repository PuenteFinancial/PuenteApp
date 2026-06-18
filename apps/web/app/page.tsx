import AnnounceBanner from '@/components/AnnounceBanner'
import Nav from '@/components/Nav'
import Hero from '@/components/Hero'
import ValueStrip from '@/components/ValueStrip'
import RemittancesSection from '@/components/RemittancesSection'
import HowItWorksSection from '@/components/HowItWorksSection'
import WaitlistSection from '@/components/WaitlistSection'
import Footer from '@/components/Footer'

export default function Page() {
  return (
    <main>
      <div className="darktop">
        <AnnounceBanner />
        <Nav />
        <Hero />
      </div>
      <ValueStrip />
      <RemittancesSection />
      <HowItWorksSection />
      <WaitlistSection />
      <Footer />
    </main>
  )
}
