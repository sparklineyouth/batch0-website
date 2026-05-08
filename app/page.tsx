import Navbar from "@/components/navbar";
import Hero from "@/components/hero";
import Marquee from "@/components/marquee";
import Problem from "@/components/problem";
import ScrollPreview from "@/components/scroll-preview";
import Curriculum from "@/components/curriculum";
import Stats from "@/components/stats";
import Comparison from "@/components/comparison";
import Founders from "@/components/founders";
import FAQ from "@/components/faq";
import CTA from "@/components/cta";
import Footer from "@/components/footer";

export default function Home() {
  return (
    <main className="relative min-h-screen overflow-hidden bg-black">
      <Navbar />
      <Hero />
      <Marquee />
      <Problem />
      <ScrollPreview />
      <Curriculum />
      <Stats />
      <Comparison />
      <Founders />
      <FAQ />
      <CTA />
      <Footer />
    </main>
  );
}
